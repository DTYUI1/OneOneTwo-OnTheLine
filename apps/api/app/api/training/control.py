"""Звонок отдела контроля реагирования (TC-07; памятка ДДС, с. 26–28).

Отдел контроля следит, чтобы служба вовремя ставила статус реагирования. Если карточка дольше
срока плана (`TrainingPlan.control_call.after_s`) остаётся без «Принята» или «Не принята»,
специалист звонит диспетчеру и спрашивает причину. В тренажёре это входящий вызов без бригады
(`Call.direction = inbound`, `brigade_id` и `target_id` пусты, номер 112 — Служба 112): один на
карточку, звонит MISSED_AFTER, без ответа гаснет пропущенным и больше не повторяется.

Пояснение диспетчера — событие `control_reply` (голосом или вариантом). Ни звонок, ни пояснение
на оценку не влияют: оценщик берёт только исходящие звонки (`evaluations/service.py`), а
опоздание со статусом уже считает критерий реакции. Разбор показывает `CardTraining.control`.
"""

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.notifications import notify
from app.api.training.contacts import card_phone
from app.api.training.content import plan_for_assignment
from app.core.models import Assignment, Call, Card, CardEvent, Scenario

# Номер вызова: отдел контроля реагирования — подразделение Службы 112 (памятка, с. 26).
CONTROL_EXT = "112"
# Без статуса реагирования: карточка ещё не «Принята» и не «Не принята» (памятка, с. 27,
# «Не оповещено»).
WITHOUT_STATUS = frozenset({"added", "received"})
# Как у вызова бригады (TC-02): 25 с, потом пропущенный.
MISSED_AFTER = timedelta(seconds=25)


def is_control(call: Call) -> bool:
    """Входящий вызов без бригады — это отдел контроля (вызовы бригад всегда с бригадой)."""
    return call.direction == "inbound" and call.brigade_id is None


def timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


async def control_plan(db: AsyncSession, card: Card) -> dict[str, Any] | None:
    """`control_call` плана выданного сценария; None — отдел контроля по карточке не звонит."""
    assignment = await db.get(Assignment, card.assignment_id)
    if assignment is None:
        return None
    scenario = await db.get(Scenario, assignment.scenario_id)
    if scenario is None:
        return None
    plan = await plan_for_assignment(db, assignment, scenario)
    control = plan.plan.get("control_call") if plan is not None else None
    return control if isinstance(control, dict) else None


async def control_call(db: AsyncSession, card_id: UUID, *, lock: bool = False) -> Call | None:
    query = (
        select(Call)
        .where(
            Call.card_id == card_id,
            Call.direction == "inbound",
            Call.brigade_id.is_(None),
        )
        .order_by(Call.started_at, Call.id)
        .limit(1)
    )
    if lock:
        query = query.with_for_update()
    return await db.scalar(query)


async def ring_control(db: AsyncSession, card: Card, now: datetime) -> int:
    """Отдел контроля звонит, если карточка без статуса реагирования дольше срока плана.

    Вызывается worker под блокировкой карточки. Один звонок на карточку: статус, поставленный
    до срока, звонок отменяет навсегда; после звонка статус ничего не меняет.
    """
    if card.closed_at is not None or card.interrupted_at is not None:
        return 0
    if card.state not in WITHOUT_STATUS:
        return 0
    plan = await control_plan(db, card)
    if plan is None or now - card.appeared_at < timedelta(seconds=int(plan["after_s"])):
        return 0
    if await control_call(db, card.id) is not None:
        return 0
    service_id = (await card_phone(db, card)).service_id
    if service_id is None:
        return 0
    call = Call(
        id=uuid4(),
        card_id=card.id,
        dialed_ext=CONTROL_EXT,
        service_id=service_id,
        started_at=now,
        direction="inbound",
    )
    db.add(call)
    await db.flush()
    await notify(db, "call.state", call.id)
    from app.api.training.service import bump_revision

    await bump_revision(db, card.id)
    return 1


async def end_missed_control(db: AsyncSession, assignment_ids: list[UUID], now: datetime) -> int:
    """Звонок отдела контроля без ответа гаснет пропущенным — и у карточки, закрытой во время
    звонка (worker обходит только открытые карточки)."""
    if not assignment_ids:
        return 0
    ringing = select(Call.card_id).where(
        Call.direction == "inbound",
        Call.brigade_id.is_(None),
        Call.answered_at.is_(None),
        Call.ended_at.is_(None),
        Call.started_at <= now - MISSED_AFTER,
    )
    cards = list(
        await db.scalars(
            select(Card.id)
            .where(Card.assignment_id.in_(assignment_ids), Card.id.in_(ringing))
            .order_by(Card.id)
            .with_for_update()
        )
    )
    from app.api.training.service import bump_revision

    ended = 0
    for card_id in cards:
        call = await control_call(db, card_id, lock=True)
        if call is None or call.answered_at is not None or call.ended_at is not None:
            continue
        call.ended_at, call.end_reason = now, "missed"
        await db.flush()
        await notify(db, "call.state", call.id)
        await bump_revision(db, card_id)
        ended += 1
    return ended


async def control_view(db: AsyncSession, card: Card) -> dict[str, Any] | None:
    """`CardTraining.control`: звонок, сколько карточка была без статуса, пояснение."""
    call = await control_call(db, card.id)
    if call is None:
        return None
    plan = await control_plan(db, card)
    reply = await db.scalar(
        select(CardEvent)
        .where(
            CardEvent.card_id == card.id,
            CardEvent.type == "control_reply",
            CardEvent.payload["call_id"].astext == str(call.id),
        )
        .order_by(CardEvent.server_ts, CardEvent.id)
        .limit(1)
    )
    return {
        "call_id": str(call.id),
        "started_at": timestamp(call.started_at),
        "answered_at": timestamp(call.answered_at) if call.answered_at else None,
        "ended_at": timestamp(call.ended_at) if call.ended_at else None,
        "end_reason": call.end_reason
        if call.end_reason in {"missed", "session_finished"}
        else None,
        "without_status_s": max(0, round((call.started_at - card.appeared_at).total_seconds())),
        "reply_options": list(plan["reply_options"]) if plan else [],
        "reply": {
            "mode": reply.payload["mode"],
            "text": reply.payload["text"],
            "option_key": reply.payload.get("option_key"),
            "at": timestamp(reply.server_ts),
        }
        if reply is not None
        else None,
    }


async def control_reply_call(db: AsyncSession, card: Card, payload: dict[str, Any]) -> Call:
    """Пояснение отделу контроля (`control_reply`): только в идущем разговоре с ним.

    404 — звонка отдела контроля по этой карточке нет; 409 — не отвечен или уже кончился, или
    вариант не из плана. Запись — сама строка card_events.
    """
    call = await db.get(Call, UUID(payload["call_id"]))
    if call is None or call.card_id != card.id or not is_control(call):
        raise HTTPException(404, "Звонок отдела контроля не найден.")
    if call.answered_at is None or call.ended_at is not None:
        raise HTTPException(409, "Отделу контроля отвечают, пока идёт разговор с ним.")
    key = payload.get("option_key")
    if payload["mode"] == "parts":
        plan = await control_plan(db, card)
        keys = {item["key"] for item in plan["reply_options"]} if plan else set()
        if key not in keys:
            raise HTTPException(409, "Такого варианта пояснения нет.")
    return call


async def is_control_call(db: AsyncSession, call_id: UUID) -> bool:
    call = await db.get(Call, call_id)
    return call is not None and is_control(call)
