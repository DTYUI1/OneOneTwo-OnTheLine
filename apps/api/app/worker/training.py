"""Выдача сведений в отвеченном звонке; выдача никогда не означает предъявление."""

import copy
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.api.notifications import notify
from app.api.training.gating import report_schedule
from app.api.training.service import bump_revision
from app.core.models import (
    Assignment,
    Call,
    CallTarget,
    Card,
    MessageDelivery,
    Session,
)


async def deliver_messages(db: AsyncSession, card: Card, now: datetime) -> int:
    """Вызывается под Session → Assignment → Card; звонки блокируются последними.

    Готовый доклад (расписание — `report_schedule`) выдаётся в идущий разговор с его
    бригадой. Отсчёт идёт от отправки бригады, а не от текущего звонка: перезвонив
    позже, диспетчер сразу слышит то, что бригада уже готова доложить.
    """
    if card.closed_at is not None or card.interrupted_at is not None:
        return 0
    assignment = await db.get(Assignment, card.assignment_id)
    if assignment is None:
        return 0
    calls = list(
        (
            await db.scalars(
                select(Call)
                .where(
                    Call.card_id == card.id,
                    Call.target_id.is_not(None),
                    Call.answered_at.is_not(None),
                    Call.ended_at.is_(None),
                    # Бригада отказала в этом звонке (не направлена сюда) — доклада в нём нет.
                    Call.refusal.is_(None),
                )
                .order_by(Call.answered_at, Call.id)
                .with_for_update()
            )
        ).all()
    )
    if not calls:
        return 0
    created = 0
    for report in await report_schedule(db, card):
        if report.issued or report.ready_at is None or now < report.ready_at:
            continue
        call = next(
            (
                c
                for c in calls
                if c.brigade_id == report.brigade_id and c.target_id == report.target_id
            ),
            None,
        )
        if call is None:
            continue
        message = report.planned["message"]
        delivery_id = uuid4()
        public_message = copy.deepcopy(message)
        if public_message["audio"] is not None:
            public_message["audio"]["url"] = (
                f"/api/cards/{card.id}/messages/{delivery_id}/audio"
                f"?version={public_message['audio']['version']}"
            )
        db.add(
            MessageDelivery(
                id=delivery_id,
                card_id=card.id,
                call_id=call.id,
                participant_id=assignment.participant_id,
                brigade_id=call.brigade_id,
                target_id=call.target_id,
                message_id=report.identity[0],
                message_version=report.identity[1],
                delivered_at=now,
                message=public_message,
                waiting_started_at=report.waiting_started_at,
                ready_at=report.ready_at,
            )
        )
        created += 1
    if created:
        await bump_revision(db, card.id)
    return created


async def ring_brigades(db: AsyncSession, card: Card, now: datetime) -> int:
    """Бригада с готовым докладом звонит диспетчеру сама (решение 27.09).

    Звонок входящий (`direction=inbound`) и ждёт ответа, пока диспетчер занят другим:
    время без ответа видно в разборе. Не звоним, если с бригадой уже есть звонок —
    идущий, набираемый диспетчером или ещё не отвеченный входящий.
    """
    if card.closed_at is not None or card.interrupted_at is not None:
        return 0
    ready = [
        report
        for report in await report_schedule(db, card)
        if not report.issued and report.ready_at is not None and report.ready_at <= now
    ]
    waiting_brigades = {report.brigade_id for report in ready}
    # Доклад уже услышан в другом звонке (диспетчер сам перезвонил бригаде) —
    # её входящий вызов больше не нужен.
    ringing = await db.scalars(
        select(Call)
        .where(
            Call.card_id == card.id,
            Call.direction == "inbound",
            Call.answered_at.is_(None),
            Call.ended_at.is_(None),
        )
        .order_by(Call.id)
        .with_for_update()
    )
    for call in ringing:
        if call.brigade_id not in waiting_brigades:
            call.ended_at, call.end_reason = now, "report_heard"
            await notify(db, "call.state", call.id)
    if not ready:
        return 0
    busy = set(
        await db.scalars(
            select(Call.brigade_id).where(
                Call.card_id == card.id, Call.ended_at.is_(None), Call.brigade_id.is_not(None)
            )
        )
    )
    rang = 0
    for report in ready:
        if report.brigade_id in busy:
            continue
        target = await db.get(CallTarget, report.target_id)
        if target is None:
            continue
        call = Call(
            id=uuid4(),
            card_id=card.id,
            dialed_ext=target.phone_ext,
            service_id=target.service_id,
            target_id=target.id,
            brigade_id=report.brigade_id,
            started_at=now,
            direction="inbound",
        )
        db.add(call)
        await db.flush()
        busy.add(report.brigade_id)
        await notify(db, "call.state", call.id)
        rang += 1
    if rang:
        await bump_revision(db, card.id)
    return rang


class TrainingScheduler:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self.sessions = sessions

    async def tick(self, now: datetime | None = None) -> int:
        now = now or datetime.now(UTC)
        async with self.sessions() as db:
            ids = list(
                await db.scalars(
                    select(Session.id).where(Session.status == "running").order_by(Session.id)
                )
            )
        created = 0
        for session_id in ids:
            async with self.sessions.begin() as db:
                lesson = await db.scalar(
                    select(Session)
                    .where(Session.id == session_id, Session.status == "running")
                    .with_for_update(skip_locked=True)
                )
                if lesson is None:
                    continue
                assignments = list(
                    await db.scalars(
                        select(Assignment.id)
                        .where(Assignment.session_id == session_id)
                        .order_by(Assignment.id)
                        .with_for_update()
                    )
                )
                cards = await db.scalars(
                    select(Card)
                    .where(
                        Card.assignment_id.in_(assignments),
                        Card.closed_at.is_(None),
                        Card.interrupted_at.is_(None),
                    )
                    .order_by(Card.id)
                    .with_for_update()
                )
                for card in cards:
                    created += await deliver_messages(db, card, now)
                    created += await ring_brigades(db, card, now)
        return created
