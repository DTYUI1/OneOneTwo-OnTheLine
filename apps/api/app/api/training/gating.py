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
from app.core.models import (
    Call,
    Card,
    CardEvent,
    MessageDelivery,
)
from app.core.read_cache import remembered

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


# Пауза между докладами — не больше 40 с реального времени (docs/dds_gameplay.md, раздел 1,
# п. 5): задержка ветки события (`delay`) или неверного адреса не отодвигает доклад дальше
# этого срока от начала его ожидания. Исход события (`within_s`) доклад ждёт всегда — сроки
# событий в данных сценария укладываются в этот бюджет сами (data/scenarios/README.md).
MAX_REPORT_WAIT = timedelta(seconds=40)


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


async def card_calls(db: AsyncSession, card_id: UUID) -> list[Call]:
    """Звонки карточки по id (повторное чтение в транзакции — из `read_cache`)."""

    async def load() -> list[Call]:
        return list(await db.scalars(select(Call).where(Call.card_id == card_id).order_by(Call.id)))

    return list(await remembered(db, ("card_calls", card_id), load))


async def status_history(db: AsyncSession, card_id: UUID) -> list[tuple[str, datetime]]:
    async def load() -> list[tuple[str, datetime]]:
        rows = await db.execute(
            select(CardEvent.payload, CardEvent.server_ts)
            .where(CardEvent.card_id == card_id, CardEvent.type == "status_change")
            .order_by(CardEvent.server_ts, CardEvent.id)
        )
        return [(payload["state"], at) for payload, at in rows.tuples()]

    return list(await remembered(db, ("status_history", card_id), load))


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


# Старые планы без justifies_state: этап доклада — следующий за статусом, которого он ждёт.
_NEXT_STAGE = {"accepted": "responding", "responding": "arrived"}


def report_stage(planned: dict[str, Any]) -> str | None:
    """Какой статус обосновывает доклад плана: выезд, прибытие…; None — не известно."""
    explicit = planned.get("justifies_state")
    if isinstance(explicit, str):
        return explicit
    return _NEXT_STAGE.get(str(planned.get("requires_state")))


@dataclass(frozen=True)
class ScheduledReport:
    """Доклад плана и его время на этой карточке.

    Бригада работает с момента отправки (первая полная вводная ей, GP-05) или со статуса,
    которого доклад ждёт (requires_state), — что позже; это подтверждённое ожидание.
    Через available_after_s доклад готов: бригада звонит сама, если с ней не говорят.
    Доклад о выезде (обосновывает «Начало реагирования») готов сразу после вводной:
    бригада говорит его в том же разговоре.
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
    from app.api.training.scenario_events import card_events_plan

    messages, _ = await card_events_plan(db, card)
    return messages


def delayed(report: ScheduledReport, ready: datetime, by: timedelta) -> datetime:
    """Готовность доклада, отложенного на `by`: не позже MAX_REPORT_WAIT от начала ожидания
    и не раньше `ready` (исход события, который доклад ждёт)."""
    if report.waiting_started_at is None:
        return ready + by
    return max(ready, min(ready + by, report.waiting_started_at + MAX_REPORT_WAIT))


def schedule_reports(
    plan_messages: list[dict[str, Any]],
    briefed: dict[UUID, datetime],
    statuses: list[tuple[str, datetime]],
    issued: set[tuple[UUID, int]],
    crew: dict[UUID, tuple[UUID, UUID]] | None = None,
) -> list[ScheduledReport]:
    """Одно расписание для выдачи, входящего звонка бригады и ожидания в разборе.

    `briefed` — бригада → когда выехала по вводной (`briefing.dispatched`): без вводной
    бригада не докладывает, сколько бы с ней ни говорили. `crew` — какая направленная бригада
    исполняет роль бригады плана (`brigades.card_crew`); без него докладывает сама бригада
    плана.
    """
    reports = []
    for planned in plan_messages:
        message = planned["message"]
        brigade_id, target_id = UUID(planned["brigade_id"]), UUID(planned["call_target_id"])
        if crew and brigade_id in crew:
            brigade_id, target_id = crew[brigade_id]
        dispatched = briefed.get(brigade_id)
        opened = gate_opened_at(planned, statuses)
        started = max(dispatched, opened) if dispatched and opened else None
        after_s = 0 if report_stage(planned) == "responding" else planned["available_after_s"]
        identity = (UUID(message["id"]), message["version"])
        reports.append(
            ScheduledReport(
                planned=planned,
                identity=identity,
                brigade_id=brigade_id,
                target_id=target_id,
                issued=identity in issued,
                waiting_started_at=started,
                ready_at=started + timedelta(seconds=after_s) if started else None,
            )
        )
    return reports


async def report_schedule(
    db: AsyncSession, card: Card, now: datetime | None = None
) -> list[ScheduledReport]:
    """Расписание докладов карточки; с событиями бригады (DT-10) — и реплики мира.

    `now` — момент, на который мир решает исход событий (по умолчанию — сейчас).
    """
    from app.api.training.briefing import (
        apply_wrong_address,
        apply_wrong_incident,
        card_briefings,
        card_scenario,
        dispatched,
        dispatching,
    )
    from app.api.training.scenario_events import card_events_plan, world_schedule

    plan_messages, events = await card_events_plan(db, card)
    if not plan_messages:
        return []
    calls = await card_calls(db, card.id)
    sent = dispatching(await card_briefings(db, card.id))
    briefed = await dispatched(db, card.id)
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
    statuses = await status_history(db, card.id)
    reports = schedule_reports(plan_messages, briefed, statuses, issued, crew)
    # Мир (события бригады) и очередь её реплик (`turns`): и без событий бригада не
    # докладывает поверх «Как приняли?».
    reports = await world_schedule(
        db,
        card,
        events,
        reports,
        crew,
        statuses,
        calls,
        issued,
        now or datetime.now(UTC),
        plan_messages,
    )
    if any(row.address == "wrong" or not row.incident for row in sent.values()):
        scenario = await card_scenario(db, card)
        reports = apply_wrong_address(reports, sent, scenario)
        reports = apply_wrong_incident(reports, sent, scenario, issued)
    return reports
