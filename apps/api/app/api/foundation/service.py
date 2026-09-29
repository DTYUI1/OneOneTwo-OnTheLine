import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import uuid4

from fastapi import HTTPException, Request, Response
from sqlalchemy import func, select, text
from sqlalchemy.exc import SQLAlchemyError

from app.api.foundation import repo, schemas
from app.core.config import Settings
from app.core.models import SCHEMA_REVISION, AuthSession, WorkerHeartbeat
from app.core.security import csrf_digest, issue_token, verify_password


async def login(request: Request, body: schemas.Login, response: Response) -> schemas.User:
    config: Settings = request.app.state.config
    db = request.state.db
    account = await repo.user_by_login(db, body.login)
    encoded = account.password_hash if account else request.app.state.dummy_password_hash
    valid = await verify_password(encoded, body.password)
    if not valid or account is None or not account.is_active:
        # Аудит безопасности: в какую учётку пытались войти. Введённый текст не пишем —
        # в поле логина по ошибке набирают пароль; только ID существующей учётки.
        request.state.entity = "users"
        request.state.entity_id = str(account.id) if account else None
        raise HTTPException(401, "Неверный логин или пароль.")
    csrf = secrets.token_urlsafe(32)
    session = AuthSession(
        id=uuid4(),
        user_id=account.id,
        csrf_hash=csrf_digest(csrf),
        expires_at=datetime.now(UTC) + timedelta(seconds=config.session_ttl_seconds),
    )
    db.add(session)
    request.state.actor_id = account.id
    request.state.entity = "auth_sessions"
    request.state.entity_id = str(session.id)
    token = issue_token(session.id, account.id, session.expires_at, config)
    response.set_cookie(
        "session",
        token,
        httponly=True,
        secure=config.cookie_secure,
        samesite="strict",
        max_age=config.session_ttl_seconds,
    )
    response.set_cookie(
        "csrf",
        csrf,
        secure=config.cookie_secure,
        samesite="strict",
        max_age=config.session_ttl_seconds,
    )
    return schemas.User.model_validate(account)


async def logout(request: Request, response: Response) -> schemas.User:
    await request.state.db.delete(request.state.auth_session)
    request.state.entity = "auth_sessions"
    request.state.entity_id = str(request.state.auth_session.id)
    response.delete_cookie(
        "session", httponly=True, secure=request.app.state.config.cookie_secure, samesite="strict"
    )
    response.delete_cookie("csrf", secure=request.app.state.config.cookie_secure, samesite="strict")
    return schemas.User.model_validate(request.state.user)


async def get_settings(request: Request) -> schemas.Settings:
    row = await repo.training_settings(request.state.db)
    if row is None:
        raise HTTPException(503, "Начальные настройки не загружены. Запустите seed.")
    return schemas.Settings.model_validate(schemas.with_comment_defaults(row.value))


async def update_settings(request: Request, value: schemas.Settings) -> schemas.Settings:
    row = await repo.training_settings(request.state.db, lock=True)
    if row is None:
        raise HTTPException(503, "Начальные настройки не загружены. Запустите seed.")
    request.state.entity = "settings"
    request.state.entity_id = "training"
    request.state.audit_before = row.value
    row.value = value.model_dump()
    row.updated_by = request.state.user.id
    row.updated_at = datetime.now(UTC)
    request.state.audit_after = row.value
    return value


async def health(request: Request) -> schemas.Health:
    database: Literal["ok", "error"] = "ok"
    worker: Literal["ok", "error"] = "error"
    try:
        async with request.app.state.database.sessions() as db:
            revision = await db.scalar(text("SELECT version_num FROM alembic_version"))
            seeded = await repo.training_settings(db)
            heartbeat = await db.scalar(select(func.max(WorkerHeartbeat.updated_at)))
            if revision != SCHEMA_REVISION or seeded is None:
                database = "error"
            if heartbeat is not None and heartbeat >= datetime.now(UTC) - timedelta(
                seconds=request.app.state.config.worker_lease_seconds * 2
            ):
                worker = "ok"
    except (SQLAlchemyError, OSError, TimeoutError):
        database = "error"
    return schemas.Health(
        status=(
            "ok"
            if database == "ok" and worker == "ok" and request.app.state.realtime.healthy
            else "degraded"
        ),
        mode="database",
        database=database,
        worker=worker,
        ai_provider=request.app.state.config.ai_provider,
    )
