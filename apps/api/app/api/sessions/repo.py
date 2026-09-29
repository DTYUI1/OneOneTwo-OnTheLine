from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.models import Assignment, Participant, Session


async def get_session(db: AsyncSession, session_id: UUID, *, lock: bool = False) -> Session | None:
    query = (
        select(Session).where(Session.id == session_id).options(selectinload(Session.participants))
    )
    if lock:
        query = query.with_for_update()
    return await db.scalar(query)


async def sessions(db: AsyncSession, user_id: UUID, role: str) -> list[Session]:
    query = select(Session).options(selectinload(Session.participants)).order_by(Session.id)
    if role == "trainee":
        query = query.join(Participant).where(Participant.user_id == user_id)
    else:
        # Тренировки обучаемых — их личное дело: в списках занятий класса их нет.
        query = query.where(Session.kind == "lesson")
        if role == "teacher":
            query = query.where(Session.teacher_id == user_id)
    return list((await db.scalars(query)).unique().all())


async def assignments(db: AsyncSession, session_id: UUID) -> list[tuple[Assignment, UUID]]:
    rows = await db.execute(
        select(Assignment, Participant.user_id)
        .join(Participant, Participant.id == Assignment.participant_id)
        .where(Assignment.session_id == session_id)
        .order_by(Assignment.order, Assignment.id)
    )
    return list(rows.tuples())
