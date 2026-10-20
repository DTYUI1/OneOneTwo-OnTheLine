"""Серверный срок удержания: журнал переживает закрытие вкладки и смену браузера."""

from datetime import datetime, timedelta
from uuid import UUID

from evalcore.defaults import CARD_TERMINAL_STATES  # type: ignore[import-untyped]
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.notifications import notify
from app.api.training.service import bump_revision
from app.core.models import Call, Card, CardEvent

HOLD_LIMIT = timedelta(minutes=3)


async def expire_held_calls(db: AsyncSession, assignment_ids: list[UUID], now: datetime) -> int:
    """Завершить непрерывное удержание по серверным меткам, в том числе закрытой карточки.

    Вызывается под Session → Assignment; затем блокируем Card → Call → Evaluation,
    как при событиях карточки. Новое удержание получает новый срок; повтор тика неизменен.
    """
    if not assignment_ids:
        return 0
    live = select(Call.card_id).where(Call.ended_at.is_(None), Call.answered_at.is_not(None))
    cards = await db.scalars(
        select(Card)
        .where(Card.assignment_id.in_(assignment_ids), Card.id.in_(live))
        .order_by(Card.id)
        .with_for_update()
    )
    ended = 0
    for card in cards:
        card_id = card.id
        marks = await db.execute(
            select(CardEvent.type, CardEvent.payload, CardEvent.server_ts)
            .where(CardEvent.card_id == card_id, CardEvent.type.in_(("call_hold", "call_resume")))
            .order_by(CardEvent.server_ts, CardEvent.id)
        )
        held: dict[UUID, datetime] = {}
        for kind, payload, at in marks:
            call_id = UUID(payload["call_id"])
            if kind == "call_hold":
                held[call_id] = at
            else:
                held.pop(call_id, None)
        if not held:
            continue
        calls = await db.scalars(
            select(Call)
            .where(
                Call.card_id == card_id,
                Call.ended_at.is_(None),
                Call.answered_at.is_not(None),
            )
            .order_by(Call.id)
            .with_for_update()
        )
        changed = False
        for call in calls:
            started = held.get(call.id)
            if started is None or started + HOLD_LIMIT > now:
                continue
            call.ended_at, call.end_reason = started + HOLD_LIMIT, "hold_timeout"
            await db.flush()
            await notify(db, "call.state", call.id)
            ended += 1
            changed = True
        if changed:
            await bump_revision(db, card_id)
            if card.state in CARD_TERMINAL_STATES:
                # Не создаём новую оценку/job: обновляем поздний факт в той же транзакции.
                from app.api.evaluations.service import refresh_terminal_rules

                await refresh_terminal_rules(db, card_id)
    return ended
