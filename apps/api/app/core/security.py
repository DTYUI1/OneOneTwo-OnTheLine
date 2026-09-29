"""Пароли Argon2id, ограниченный JWT и отзыв сессии в PostgreSQL."""

import hashlib
from datetime import UTC, datetime
from uuid import UUID

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from app.core.config import Settings

hasher = PasswordHasher()


async def hash_password(password: str) -> str:
    # Argon2 не должен задерживать остальные соединения в event loop.
    return await run_in_threadpool(hasher.hash, password)


async def verify_password(encoded: str, password: str) -> bool:
    try:
        return await run_in_threadpool(hasher.verify, encoded, password)
    except (VerificationError, InvalidHashError):
        return False


def csrf_digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def issue_token(session_id: UUID, user_id: UUID, expires_at: datetime, config: Settings) -> str:
    return jwt.encode(
        {
            "sid": str(session_id),
            "sub": str(user_id),
            "exp": expires_at,
            "iat": datetime.now(UTC),
            "iss": "arm112",
            "aud": "arm112",
        },
        config.jwt_secret.get_secret_value(),
        algorithm="HS256",
    )


def read_token(token: str, config: Settings) -> tuple[UUID, UUID]:
    try:
        payload = jwt.decode(
            token,
            config.jwt_secret.get_secret_value(),
            algorithms=["HS256"],
            issuer="arm112",
            audience="arm112",
            options={"require": ["sid", "sub", "exp", "iat", "iss", "aud"]},
        )
        return UUID(payload["sid"]), UUID(payload["sub"])
    except (jwt.InvalidTokenError, ValueError, TypeError, AttributeError) as exc:
        raise HTTPException(401, "Войдите в систему.") from exc
