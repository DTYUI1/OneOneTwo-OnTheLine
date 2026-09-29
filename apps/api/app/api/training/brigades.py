"""Какими бригадами располагает диспетчер на карточке и какие из них заняты (28.09).

Бригада, направленная на незакрытое происшествие, на другое не едет. Чтобы при многих
происшествиях диспетчеру было кого направить, бригад становится больше: две, с четырьмя
происшествиями у обучаемого в занятии — три, с шестью — четыре. Бригада плана сценария —
роль, а не конкретная бригада: доклады приходят от той, которую направил диспетчер.
"""

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import (
    Assignment,
    Brigade,
    Call,
    CallTarget,
    Card,
    CardBrigade,
    Participant,
)

BASE_BRIGADES = 2


def brigade_limit(incidents: int) -> int:
    """Две бригады; каждые два происшествия сверх двух добавляют ещё одну."""
    return BASE_BRIGADES + max(0, incidents - BASE_BRIGADES) // 2


@dataclass(frozen=True)
class BusyBrigade:
    card_id: UUID
    card_number: str


@dataclass(frozen=True)
class BrigadeRoster:
    """Доступные бригады в порядке справочника и занятые на других карточках."""

    available: tuple[UUID, ...]
    busy: dict[UUID, BusyBrigade]


async def brigade_roster(db: AsyncSession, card: Card) -> BrigadeRoster:
    assignment = await db.get(Assignment, card.assignment_id)
    participant = (
        await db.get(Participant, assignment.participant_id) if assignment is not None else None
    )
    if assignment is None or participant is None:
        return BrigadeRoster(available=(), busy={})
    incidents = int(
        await db.scalar(
            select(func.count())
            .select_from(Assignment)
            .where(
                Assignment.session_id == assignment.session_id,
                Assignment.participant_id == participant.id,
                Assignment.cancelled_at.is_(None),
            )
        )
        or 0
    )
    brigades = list(
        await db.scalars(
            select(Brigade.id)
            .where(Brigade.service_id == participant.dds_service_id, Brigade.is_active.is_(True))
            .order_by(Brigade.name, Brigade.id)
        )
    )
    rows = (
        await db.execute(
            select(CardBrigade.brigade_id, Card.id, Card.number)
            .join(Card, Card.id == CardBrigade.card_id)
            .join(Assignment, Assignment.id == Card.assignment_id)
            .where(
                Assignment.session_id == assignment.session_id,
                Assignment.participant_id == participant.id,
                Card.id != card.id,
                Card.closed_at.is_(None),
                Card.interrupted_at.is_(None),
            )
            .order_by(Card.appeared_at, Card.id)
        )
    ).tuples()
    busy: dict[UUID, BusyBrigade] = {}
    for brigade_id, card_id, number in rows:
        busy.setdefault(brigade_id, BusyBrigade(card_id=card_id, card_number=number))
    return BrigadeRoster(available=tuple(brigades[: brigade_limit(max(incidents, 1))]), busy=busy)


REFUSAL_BUSY = "busy"
REFUSAL_NOT_ASSIGNED = "not_assigned"


async def call_refusal(db: AsyncSession, card: Card, brigade_id: UUID) -> str | None:
    """Почему бригада откажет диспетчеру в звонке по этой карточке; None — она направлена сюда.

    Связь у диспетчера ДДС есть со всеми своими бригадами, поэтому звонок не запрещается:
    ненаправленная бригада отвечает, что вызов ей не назначен, занятая — что она на другом
    происшествии. Докладов по такому звонку нет (`gating.schedule_reports`).
    """
    if await db.get(CardBrigade, (card.id, brigade_id)) is not None:
        return None
    roster = await brigade_roster(db, card)
    return REFUSAL_BUSY if brigade_id in roster.busy else REFUSAL_NOT_ASSIGNED


def assign_crew(
    plan_messages: list[dict[str, Any]],
    selected: list[UUID],
    working: list[UUID] | None = None,
) -> dict[UUID, UUID]:
    """Бригада плана → направленная бригада.

    Роль остаётся за бригадой, которая уже работает (`working` — направленные бригады, с
    которыми был разговор по этой карточке, в порядке первого ответа): подкрепление,
    направленное позже, доклады у неё не забирает. Кто ещё не работал: направлена сама
    бригада плана — докладывает она; иначе роль берёт первая направленная, которой ещё не
    досталась другая роль плана. Не направлено никого — роль пуста.
    """
    planned = list(dict.fromkeys(UUID(message["brigade_id"]) for message in plan_messages))
    active = [brigade for brigade in working or [] if brigade in selected]
    crew = {brigade: brigade for brigade in planned if brigade in active}
    started = [brigade for brigade in active if brigade not in crew.values()]
    for brigade in planned:
        if brigade not in crew and started:
            crew[brigade] = started.pop(0)
    for brigade in planned:
        if brigade not in crew and brigade in selected and brigade not in crew.values():
            crew[brigade] = brigade
    spare = [brigade for brigade in selected if brigade not in crew.values()]
    for brigade in planned:
        if brigade not in crew and spare:
            crew[brigade] = spare.pop(0)
    return crew


async def card_crew(
    db: AsyncSession, card: Card, plan_messages: list[dict[str, Any]]
) -> dict[UUID, tuple[UUID, UUID]]:
    """Бригада плана → (направленная бригада, её прямой номер) для этой карточки."""
    selected = list(
        await db.scalars(
            select(CardBrigade.brigade_id)
            .join(Brigade, Brigade.id == CardBrigade.brigade_id)
            .where(CardBrigade.card_id == card.id)
            .order_by(Brigade.name, Brigade.id)
        )
    )
    targets = {
        target.brigade_id: target.id
        for target in await db.scalars(
            select(CallTarget)
            .where(CallTarget.brigade_id.in_(selected), CallTarget.is_active.is_(True))
            .order_by(CallTarget.id)
        )
    }
    # Кто уже на связи по этой карточке: первый отвеченный разговор без отказа.
    answered = await db.execute(
        select(Call.brigade_id, func.min(Call.answered_at))
        .where(
            Call.card_id == card.id,
            Call.brigade_id.in_(selected),
            Call.answered_at.is_not(None),
            Call.refusal.is_(None),
        )
        .group_by(Call.brigade_id)
        .order_by(func.min(Call.answered_at))
    )
    working = [brigade for brigade, _ in answered.tuples() if brigade is not None]
    crew = assign_crew(
        plan_messages, [brigade for brigade in selected if brigade in targets], working
    )
    return {planned: (actual, targets[actual]) for planned, actual in crew.items()}
