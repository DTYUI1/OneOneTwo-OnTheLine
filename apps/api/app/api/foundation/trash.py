"""C-07: корзина учётных записей (ТЗ: не удалять критичные данные без резервного копирования).

Удаление — строка user_deletions: учётка блокируется, сессии отзываются, человек пропадает
из списков. Обезличивает её worker и только после успешной копии, начатой позже удаления:
тогда прежние данные уже лежат в копии. Строка пользователя остаётся — на неё ссылаются
занятия, оценки и журнал аудита; стираются ФИО, логин, пароль и профиль. До этого момента
удаление обратимо.
"""

import secrets
from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import Request
from sqlalchemy import delete, exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.foundation import schemas
from app.api.foundation.users import conflict, ensure_not_deleted, locked_user, public, revoke
from app.core.models import (
    AuditLog,
    AuthSession,
    Backup,
    Participant,
    Session,
    User,
    UserDeletion,
)
from app.core.security import hash_password

ANONYMOUS = "Удалённый пользователь"
# Корзина показывает все ожидающие и столько последних обезличенных.
PURGED_SHOWN = 50


def view(user: User, deleted: UserDeletion | datetime | None) -> schemas.User:
    moment = deleted.deleted_at if isinstance(deleted, UserDeletion) else deleted
    return schemas.User.model_validate(user).model_copy(update={"deleted_at": moment})


async def deleted_at(db: AsyncSession) -> dict[UUID, datetime]:
    rows = await db.execute(select(UserDeletion.user_id, UserDeletion.deleted_at))
    return dict(rows.tuples().all())


async def last_backup_at(db: AsyncSession) -> datetime | None:
    """Начало последней успешной копии (время БД, до pg_dump)."""
    return await db.scalar(select(func.max(Backup.started_at)).where(Backup.status == "done"))


async def in_training(db: AsyncSession, user_id: UUID) -> bool:
    """Идёт занятие с этим человеком — администратор в учебный процесс не вмешивается (ТЗ)."""
    running = select(Session.id).where(Session.status == "running")
    return bool(
        await db.scalar(
            select(
                exists().where(Participant.user_id == user_id, Participant.session_id.in_(running))
                | exists().where(Session.teacher_id == user_id, Session.status == "running")
            )
        )
    )


async def trash_user(request: Request, user_id: UUID, body: schemas.TrashInput) -> schemas.User:
    db: AsyncSession = request.state.db
    request.state.entity, request.state.entity_id = "users", str(user_id)
    user = await locked_user(db, user_id)
    if user.id == request.state.user.id:
        raise conflict("self_lockout", "Свою учётную запись удаляет другой администратор.")
    await ensure_not_deleted(db, user.id)
    if await in_training(db, user.id):
        raise conflict(
            "user_in_training",
            "Идёт занятие с этим пользователем. Удалите учётную запись после его завершения.",
        )
    request.state.audit_before = public(user)
    user.is_active = False
    deletion = UserDeletion(
        user_id=user.id,
        deleted_at=await db.scalar(select(func.now())),
        deleted_by=request.state.user.id,
        reason=body.reason,
    )
    db.add(deletion)
    await revoke(db, user.id)
    await db.flush()
    result = view(user, deletion)
    request.state.audit_after = {**result.model_dump(mode="json"), "reason": body.reason}
    return result


async def restore_user(request: Request, user_id: UUID) -> schemas.User:
    """Вернуть из корзины заблокированной: доступ администратор открывает отдельно."""
    db: AsyncSession = request.state.db
    request.state.entity, request.state.entity_id = "users", str(user_id)
    user = await locked_user(db, user_id)
    deletion = await db.get(UserDeletion, user.id, with_for_update=True)
    if deletion is None:
        raise conflict("user_not_deleted", "Учётная запись не в корзине.")
    if deletion.purged_at is not None:
        raise conflict(
            "user_purged",
            "Данные уже обезличены после резервной копии. Вернуть их можно только "
            "восстановлением копии.",
        )
    request.state.audit_before = view(user, deletion).model_dump(mode="json")
    await db.delete(deletion)
    await db.flush()
    request.state.audit_after = public(user)
    return view(user, None)


def state_of(deletion: UserDeletion, covered: datetime | None) -> str:
    if deletion.purged_at is not None:
        return "purged"
    return "ready" if covered is not None and deletion.deleted_at < covered else "waiting_backup"


async def list_trash(request: Request) -> schemas.TrashList:
    db: AsyncSession = request.state.db
    covered = await last_backup_at(db)
    rows = select(User, UserDeletion).join(UserDeletion, UserDeletion.user_id == User.id)
    waiting = await db.execute(
        rows.where(UserDeletion.purged_at.is_(None)).order_by(UserDeletion.deleted_at.desc())
    )
    purged = await db.execute(
        rows.where(UserDeletion.purged_at.is_not(None))
        .order_by(UserDeletion.purged_at.desc())
        .limit(PURGED_SHOWN)
    )
    items: list[dict[str, Any]] = [
        {
            "kind": "user",
            "id": user.id,
            "title": user.full_name,
            "login": user.login,
            "role": user.role,
            "reason": deletion.reason,
            "deleted_at": deletion.deleted_at,
            "deleted_by": deletion.deleted_by,
            "purged_at": deletion.purged_at,
            "state": state_of(deletion, covered),
        }
        for user, deletion in [*waiting.tuples(), *purged.tuples()]
    ]
    return schemas.TrashList.model_validate({"last_backup_at": covered, "items": items})


async def purge_due(db: AsyncSession) -> int:
    """Обезличить учётки, удалённые до начала последней успешной копии (вызывает worker)."""
    covered = await last_backup_at(db)
    if covered is None:
        return 0
    backup = await db.scalar(
        select(Backup.name).where(Backup.status == "done", Backup.started_at == covered).limit(1)
    )
    rows = (
        await db.execute(
            select(User, UserDeletion)
            .join(UserDeletion, UserDeletion.user_id == User.id)
            .where(UserDeletion.purged_at.is_(None), UserDeletion.deleted_at < covered)
            .with_for_update(skip_locked=True)
        )
    ).tuples()
    now = await db.scalar(select(func.now()))
    count = 0
    for user, deletion in rows:
        # Хвост UUID: у демо-учёток начало id одинаковое, а логин обязан быть уникальным.
        user.full_name = f"{ANONYMOUS} {user.id.hex[-6:]}"
        user.login = f"deleted-{user.id.hex[-12:]}"
        user.password_hash = await hash_password(secrets.token_urlsafe(32))
        user.workstation_number = None
        user.dds_service_id = None
        user.is_active = False
        deletion.purged_at = now
        await db.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
        db.add(
            AuditLog(
                actor_id=None,
                action="purgeUser",
                entity="users",
                entity_id=str(user.id),
                after={"anonymized": True, "backup": backup},
            )
        )
        count += 1
    await db.flush()
    return count
