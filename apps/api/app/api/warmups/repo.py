from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import User, WarmupResult

# Свежие результаты: обучаемому — для «лучший / прошлый раз», преподавателю — обзор группы.
LIST_LIMIT = 200


async def latest(db: AsyncSession, trainee_id: UUID | None) -> list[tuple[WarmupResult, User]]:
    query = select(WarmupResult, User).join(User, User.id == WarmupResult.trainee_id)
    if trainee_id is not None:
        query = query.where(WarmupResult.trainee_id == trainee_id)
    rows = await db.execute(
        query.order_by(WarmupResult.created_at.desc(), WarmupResult.id).limit(LIST_LIMIT)
    )
    return [(result, trainee) for result, trainee in rows.tuples()]
