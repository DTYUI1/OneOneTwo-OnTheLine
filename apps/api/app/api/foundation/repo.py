from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import AuthSession, Setting, User


async def user_by_login(db: AsyncSession, login: str) -> User | None:
    return await db.scalar(select(User).where(User.login == login))


async def users(db: AsyncSession) -> list[User]:
    return list((await db.scalars(select(User).order_by(User.login))).all())


async def authenticate(
    db: AsyncSession, sid: UUID, user_id: UUID
) -> tuple[AuthSession, User] | None:
    # Logout и уже начатая мутация сериализуются по сессии, отзыв действует и между процессами.
    row = (
        await db.execute(
            select(AuthSession, User)
            .join(User, User.id == AuthSession.user_id)
            .where(
                AuthSession.id == sid,
                User.id == user_id,
                User.is_active.is_(True),
                AuthSession.expires_at > datetime.now(UTC),
            )
            .with_for_update(of=AuthSession)
        )
    ).first()
    return (row[0], row[1]) if row else None


async def training_settings(db: AsyncSession, *, lock: bool = False) -> Setting | None:
    query = select(Setting).where(Setting.key == "training")
    if lock:
        query = query.with_for_update()
    return await db.scalar(query)
