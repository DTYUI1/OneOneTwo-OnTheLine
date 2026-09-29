from uuid import UUID

from sqlalchemy import RowMapping, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import Assignment, Call, Card, CardEvent, Participant, Scenario, Session


def card_query():
    return (
        select(
            Card,
            Assignment.session_id,
            Participant.user_id.label("trainee_id"),
            Scenario.card.label("source"),
            Session.teacher_id,
            Session.status.label("session_status"),
        )
        .join(Assignment, Assignment.id == Card.assignment_id)
        .join(Participant, Participant.id == Assignment.participant_id)
        .join(Scenario, Scenario.id == Assignment.scenario_id)
        .join(Session, Session.id == Assignment.session_id)
    )


async def cards(db: AsyncSession, user_id: UUID, role: str) -> list[RowMapping]:
    query = card_query().order_by(Card.appeared_at, Card.id)
    if role == "trainee":
        query = query.where(Participant.user_id == user_id)
    elif role == "teacher":
        query = query.where(Session.teacher_id == user_id)
    return list((await db.execute(query)).mappings())


async def card(
    db: AsyncSession, card_id: UUID, user_id: UUID, role: str, *, lock: bool = False
) -> RowMapping | None:
    query = card_query().where(Card.id == card_id)
    if role == "trainee":
        query = query.where(Participant.user_id == user_id)
    elif role == "teacher":
        query = query.where(Session.teacher_id == user_id)
    if lock:
        # Сначала блокируем занятие, затем назначение и карточку. После ожидания
        # повторный SELECT увидит finish, зафиксированный параллельным запросом.
        owner = (await db.execute(query)).mappings().one_or_none()
        if owner is None:
            return None
        await db.scalar(
            select(Session)
            .where(
                Session.id == owner["session_id"],
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        await db.scalar(
            select(Assignment)
            .where(
                Assignment.id == owner["Card"].assignment_id,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        query = query.with_for_update(of=Card)
        query = query.execution_options(populate_existing=True)
    return (await db.execute(query)).mappings().one_or_none()


async def events(db: AsyncSession, card_id: UUID) -> list[CardEvent]:
    return list(
        (
            await db.scalars(
                select(CardEvent)
                .where(CardEvent.card_id == card_id)
                .order_by(CardEvent.server_ts, CardEvent.id)
            )
        ).all()
    )


async def calls(db: AsyncSession, card_id: UUID) -> list[Call]:
    return list(
        (
            await db.scalars(
                select(Call).where(Call.card_id == card_id).order_by(Call.started_at, Call.id)
            )
        ).all()
    )
