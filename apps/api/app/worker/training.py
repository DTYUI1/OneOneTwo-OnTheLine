"""Выдача сведений в отвеченном звонке; выдача никогда не означает предъявление."""

import copy
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.api.notifications import notify
from app.api.training.control import end_missed_control, ring_control
from app.api.training.gating import ScheduledReport, report_schedule
from app.api.training.holds import expire_held_calls
from app.api.training.scenario_events import event_view, fire_due_events
from app.api.training.service import bump_revision
from app.api.training.turns import asks_confirmation
from app.core.models import (
    Assignment,
    Call,
    CallTarget,
    Card,
    MessageDelivery,
    MessagePresentation,
    Session,
)

# Пропущенный вызов (TC-02, docs/dds_touches.md; touches.md, «Входящий доклад бригады», 2).
# Входящий бригады звонит MISSED_AFTER и гаснет «пропущенным»; через REDIAL_AFTER бригада
# звонит снова. Второй пропуск того же доклада подряд — «потерян»: сама она больше не звонит,
# доклад отдаётся в разговор, когда диспетчер позвонит ей сам. Пауза — как между докладами
# плана (эталон, 1.5: не больше 40 с).
MISSED_AFTER = timedelta(seconds=25)
REDIAL_AFTER = timedelta(seconds=40)
MISSED = ("missed", "lost")


async def missed_since_contact(db: AsyncSession, card: Card) -> dict[UUID, Call]:
    """Последний пропущенный вызов бригады после последнего разговора с ней.

    Разговор — любой отвеченный звонок с бригадой (её вызов или звонок диспетчера): после
    него счёт пропусков начинается заново. Нет бригады в ответе — пропусков нет.
    """
    last: dict[UUID, Call] = {}
    for call in await db.scalars(
        select(Call)
        .where(Call.card_id == card.id, Call.brigade_id.is_not(None))
        .order_by(Call.started_at, Call.id)
    ):
        brigade = call.brigade_id
        assert brigade is not None
        if call.answered_at is not None:
            last.pop(brigade, None)
        elif call.end_reason in MISSED:
            last[brigade] = call
    return last


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
    waits: set[UUID] = set()
    ready = [
        report
        for report in await report_schedule(db, card, now)
        if not report.issued and report.ready_at is not None and report.ready_at <= now
    ]
    for report in sorted(ready, key=delivery_order):
        # После реплики, на которую бригада ждёт ответа (вопрос, доклад с «Как приняли?»),
        # следующую в этом проходе не выдаём: её выдаст расписание, когда учтёт ответ
        # (очередь реплик, `turns`).
        if report.brigade_id in waits and report.planned.get("priority") != "alarm":
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
                # Порядок выдачи — порядок, в котором бригада говорит (клиент сортирует по
                # времени выдачи): у реплик одного прохода время не совпадает.
                delivered_at=now + timedelta(microseconds=created),
                message=public_message,
                waiting_started_at=report.waiting_started_at,
                ready_at=report.ready_at,
            )
        )
        created += 1
        planned = report.planned
        question = bool(planned.get("question"))
        if question or asks_confirmation(
            call.direction == "inbound", question, bool(planned.get("answer"))
        ):
            waits.add(report.brigade_id)
    if created:
        await bump_revision(db, card.id)
    return created


def delivery_order(report: ScheduledReport) -> tuple[datetime, int]:
    """Кто говорит первым из готовых: раньше готовое; при равенстве — ответ бригады на
    действие диспетчера (реплика ветки), потом реплика события, потом доклад плана: «Понял
    поправку» звучит до «Прибыли», а не после (проверка 17.10)."""
    planned = report.planned
    rank = 2 if "requires_state" in planned or "justifies_state" in planned else 1
    if planned.get("answer"):
        rank = 0
    assert report.ready_at is not None
    return report.ready_at, rank


async def unheard_reports(db: AsyncSession, card: Card) -> list[tuple[UUID, UUID]]:
    """Доклады, выданные в разговор, который кончился раньше, чем их услышали.

    Бригада кладёт трубку сама, когда диспетчеру нечего сказать (Softphone, brigadeQuiet);
    доклад, выданный в эту же секунду, остаётся неуслышанным. Он уже выдан и в расписании
    готовых не числится — бригада звонит с ним снова, иначе обучаемый ждёт его вечно
    (эталон, 1.5). Услышать его можно в любом следующем разговоре с этой бригадой.
    """
    heard = (
        select(MessagePresentation.id)
        .where(
            MessagePresentation.delivery_id == MessageDelivery.id,
            MessagePresentation.kind == "message_presented",
        )
        .exists()
    )
    rows = await db.execute(
        select(MessageDelivery.brigade_id, MessageDelivery.target_id)
        .join(Call, Call.id == MessageDelivery.call_id)
        .where(MessageDelivery.card_id == card.id, Call.ended_at.is_not(None), ~heard)
        .order_by(MessageDelivery.delivered_at, MessageDelivery.id)
    )
    return list(rows.tuples())


async def ring_brigades(db: AsyncSession, card: Card, now: datetime) -> int:
    """Бригада с готовым докладом звонит диспетчеру сама (решение 27.09).

    Звонок входящий (`direction=inbound`) и звонит MISSED_AFTER, потом гаснет пропущенным
    (TC-02); время без ответа видно в разборе. Не звоним, если с бригадой уже есть звонок —
    идущий, набираемый диспетчером или ещё не отвеченный входящий.
    """
    if card.closed_at is not None or card.interrupted_at is not None:
        return 0
    ready = [
        (report.brigade_id, report.target_id)
        for report in await report_schedule(db, card, now)
        if not report.issued and report.ready_at is not None and report.ready_at <= now
    ]
    ready += await unheard_reports(db, card)
    waiting_brigades = {brigade_id for brigade_id, _ in ready}
    missed = await missed_since_contact(db, card)
    # Тревожный вызов не пропускается и звонит до ответа (решение 15.10, #97).
    alarms: set[UUID] | None = None

    async def alarm(brigade_id: UUID | None) -> bool:
        nonlocal alarms
        if alarms is None:
            alarms = (await event_view(db, card, [])).alarm_brigades
        return brigade_id in alarms

    ringing = await db.scalars(
        select(Call)
        .where(
            Call.card_id == card.id,
            Call.direction == "inbound",
            # Вызов без бригады — отдел контроля (TC-07): у него свои правила, `control.py`.
            Call.brigade_id.is_not(None),
            Call.answered_at.is_(None),
            Call.ended_at.is_(None),
        )
        .order_by(Call.id)
        .with_for_update()
    )
    ended = 0
    for call in ringing:
        # Доклад уже услышан в другом звонке (диспетчер сам перезвонил бригаде) —
        # её входящий вызов больше не нужен.
        if call.brigade_id not in waiting_brigades:
            call.ended_at, call.end_reason = now, "report_heard"
        elif now - call.started_at >= MISSED_AFTER and not await alarm(call.brigade_id):
            # Не ответили — пропущенный; второй пропуск того же доклада — потерян.
            assert call.brigade_id is not None
            call.ended_at = now
            call.end_reason = "lost" if call.brigade_id in missed else "missed"
            missed[call.brigade_id] = call
        else:
            continue
        ended += 1
        await notify(db, "call.state", call.id)
    if ended:
        await db.flush()
    if not ready:
        if ended:
            await bump_revision(db, card.id)
        return 0
    assignment = await db.get(Assignment, card.assignment_id)
    if assignment is None:
        return 0
    # Как при ручном наборе: линия бригады общая для всех карточек участника.
    # Session уже заблокирована вызывающим кодом; чужие Card/Call здесь не блокируем.
    busy = set(
        await db.scalars(
            select(Call.brigade_id)
            .join(Card, Card.id == Call.card_id)
            .join(Assignment, Assignment.id == Card.assignment_id)
            .where(
                Assignment.participant_id == assignment.participant_id,
                Call.ended_at.is_(None),
                Call.brigade_id.is_not(None),
            )
        )
    )
    rang = 0
    for brigade_id, target_id in ready:
        if brigade_id in busy:
            continue
        # После пропущенного бригада ждёт перезвона REDIAL_AFTER, потерянный доклад — до
        # звонка диспетчера. Тревога звонит всё равно.
        last = missed.get(brigade_id)
        if (
            last is not None
            and (last.end_reason == "lost" or now - (last.ended_at or now) < REDIAL_AFTER)
            and not await alarm(brigade_id)
        ):
            continue
        target = await db.get(CallTarget, target_id)
        if target is None:
            continue
        call = Call(
            id=uuid4(),
            card_id=card.id,
            dialed_ext=target.phone_ext,
            service_id=target.service_id,
            target_id=target.id,
            brigade_id=brigade_id,
            started_at=now,
            direction="inbound",
        )
        db.add(call)
        await db.flush()
        busy.add(brigade_id)
        await notify(db, "call.state", call.id)
        rang += 1
    if rang or ended:
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
                # Срок удержания действует и после закрытия карточки; до выдачи новых
                # докладов погасим просроченные разговоры, не полагаясь на вкладку АРМ.
                await expire_held_calls(db, assignments, now)
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
                    # События бригады (DT-10) срабатывают до выдачи: их реплика уходит тем
                    # же тиком, в идущий разговор или звонком бригады.
                    await fire_due_events(db, card, now)
                    created += await deliver_messages(db, card, now)
                    created += await ring_brigades(db, card, now)
                    # Отдел контроля (TC-07): карточка без статуса дольше срока плана. Его
                    # вызов — не сведения бригады, в счёт выданного не идёт.
                    await ring_control(db, card, now)
                await end_missed_control(db, assignments, now)
        return created
