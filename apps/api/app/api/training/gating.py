"""Бригада докладывает по решению диспетчера: правило requires_state плана сообщений.

Общая часть worker (выдача) и API (подсказка «бригада ждёт статуса»): одно правило в
одном месте, чтобы подсказка не расходилась с фактической выдачей.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.training.brigades import card_crew
from app.api.training.content import plan_for_assignment
from app.core.models import (
    Assignment,
    Call,
    Card,
    CardEvent,
    MessageDelivery,
    Scenario,
)

# Порядок хода дела для requires_state: «дошла до статуса» = статус этого ранга или дальше.
# "rejected" ранга не имеет: непринятой карточке бригада ничего не докладывает.
STATE_RANK = {
    "accepted": 1,
    "responding": 2,
    "arrived": 3,
    "working": 4,
    "completed": 5,
    "refused": 5,
}


def reached_at(required: str, statuses: list[tuple[str, datetime]]) -> datetime | None:
    """Когда диспетчер впервые поставил статус не ниже требуемого; None — ещё не поставил."""
    rank = STATE_RANK[required]
    return next((at for state, at in statuses if STATE_RANK.get(state, 0) >= rank), None)


def gate_opened_at(
    planned: dict[str, Any], statuses: list[tuple[str, datetime]]
) -> datetime | None:
    """Момент, с которого бригада может докладывать; без requires_state — сразу.

    Бригада действует по решению диспетчера, а не по часам: доклад о прибытии не
    звучит, пока в карточке не отмечен выезд (находка капитана 27.09 — раньше все
    доклады выдавались за 26 с от ответа, и ученик не успевал их перенести).
    """
    required = planned.get("requires_state")
    if required is None:
        return datetime.min.replace(tzinfo=UTC)
    return reached_at(required, statuses)


async def status_history(db: AsyncSession, card_id: UUID) -> list[tuple[str, datetime]]:
    rows = await db.execute(
        select(CardEvent.payload, CardEvent.server_ts)
        .where(CardEvent.card_id == card_id, CardEvent.type == "status_change")
        .order_by(CardEvent.server_ts, CardEvent.id)
    )
    return [(payload["state"], at) for payload, at in rows.tuples()]


def awaiting_state(
    plan_messages: list[dict[str, Any]],
    issued: set[tuple[UUID, int]],
    statuses: list[tuple[str, datetime]],
) -> str | None:
    """Статус, без которого бригада не даст следующий по плану доклад; None — не ждёт.

    Смотрим только на первый ещё не выданный доклад: если он ждёт лишь секунды
    available_after_s, подсказывать нечего — решение уже принято.
    """
    for planned in plan_messages:
        message = planned["message"]
        if (UUID(message["id"]), message["version"]) in issued:
            continue
        if gate_opened_at(planned, statuses) is None:
            return str(planned["requires_state"])
        return None
    return None


@dataclass(frozen=True)
class ScheduledReport:
    """Доклад плана и его время на этой карточке.

    Бригада работает с момента отправки (первый отвеченный звонок ей) или со статуса,
    которого доклад ждёт (requires_state), — что позже; это подтверждённое ожидание.
    Через available_after_s доклад готов: бригада звонит сама, если с ней не говорят.
    """

    planned: dict[str, Any]
    identity: tuple[UUID, int]
    brigade_id: UUID
    target_id: UUID
    issued: bool
    waiting_started_at: datetime | None
    ready_at: datetime | None


async def card_plan(db: AsyncSession, card: Card) -> list[dict[str, Any]]:
    """Сообщения плана сценария карточки в порядке плана; пусто — плана нет."""
    assignment = await db.get(Assignment, card.assignment_id)
    if assignment is None:
        return []
    scenario = await db.get(Scenario, assignment.scenario_id)
    if scenario is None:
        return []
    plan = await plan_for_assignment(db, assignment, scenario)
    return list(plan.plan["messages"]) if plan is not None else []


def schedule_reports(
    plan_messages: list[dict[str, Any]],
    calls: list[Call],
    statuses: list[tuple[str, datetime]],
    issued: set[tuple[UUID, int]],
    crew: dict[UUID, tuple[UUID, UUID]] | None = None,
) -> list[ScheduledReport]:
    """Одно расписание для выдачи, входящего звонка бригады и ожидания в разборе.

    `crew` — какая направленная бригада исполняет роль бригады плана (`brigades.card_crew`);
    без него докладывает сама бригада плана. Звонок с отказом (`Call.refusal`: бригада не
    была направлена сюда при наборе) бригаду не отправляет, даже если её направят потом.
    """
    reports = []
    for planned in plan_messages:
        message = planned["message"]
        brigade_id, target_id = UUID(planned["brigade_id"]), UUID(planned["call_target_id"])
        if crew and brigade_id in crew:
            brigade_id, target_id = crew[brigade_id]
        dispatched = min(
            (
                call.answered_at
                for call in calls
                if call.brigade_id == brigade_id
                and call.target_id == target_id
                and call.answered_at is not None
                and call.refusal is None
            ),
            default=None,
        )
        opened = gate_opened_at(planned, statuses)
        started = max(dispatched, opened) if dispatched and opened else None
        identity = (UUID(message["id"]), message["version"])
        reports.append(
            ScheduledReport(
                planned=planned,
                identity=identity,
                brigade_id=brigade_id,
                target_id=target_id,
                issued=identity in issued,
                waiting_started_at=started,
                ready_at=started + timedelta(seconds=planned["available_after_s"])
                if started
                else None,
            )
        )
    return reports


async def report_schedule(db: AsyncSession, card: Card) -> list[ScheduledReport]:
    plan_messages = await card_plan(db, card)
    if not plan_messages:
        return []
    calls = list(await db.scalars(select(Call).where(Call.card_id == card.id).order_by(Call.id)))
    issued = set(
        (
            await db.execute(
                select(MessageDelivery.message_id, MessageDelivery.message_version).where(
                    MessageDelivery.card_id == card.id
                )
            )
        ).tuples()
    )
    crew = await card_crew(db, card, plan_messages)
    return schedule_reports(plan_messages, calls, await status_history(db, card.id), issued, crew)
