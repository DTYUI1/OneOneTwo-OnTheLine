"""Остановка выдачи и попыток под той же блокировкой занятия, что у scheduler."""

from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.c01 import C01Input
from app.api.notifications import notify
from app.api.sessions import repo, schemas
from app.api.sessions.service import ensure_owner, serialize
from app.core.models import Assignment, Call, Card, Participant, SessionFinish
from app.worker.queue import enqueue_job


class SessionLifecycle(C01Input):
    contract_name = "SessionLifecycle"


def timestamp(value: datetime | None) -> str | None:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z") if value else None


async def stop_attempts(db: AsyncSession, session_id: UUID, now: datetime) -> None:
    """Отменить невыданное, прервать открытые карточки и звонки занятия.

    Общее для finish преподавателя и перезапуска тренировки обучаемого; вызывается
    под блокировкой занятия.
    """
    assignments = list(
        (
            await db.scalars(
                select(Assignment)
                .where(
                    Assignment.session_id == session_id,
                )
                .order_by(Assignment.id)
                .with_for_update()
            )
        ).all()
    )
    cards = list(
        (
            await db.scalars(
                select(Card)
                .where(
                    Card.assignment_id.in_([a.id for a in assignments]),
                )
                .order_by(Card.id)
                .with_for_update()
            )
        ).all()
    )
    cards_by_assignment = {c.assignment_id: c for c in cards}
    for assignment in assignments:
        card = cards_by_assignment.get(assignment.id)
        if card is None:
            assignment.cancelled_at = now
            # Legacy Assignment не имеет cancelled; актуальная отмена доступна в lifecycle.
            if assignment.batch_id is not None:
                assignment.status = "cancelled"
        elif card.closed_at is None:
            card.interrupted_at = now
    calls = await db.scalars(
        select(Call)
        .where(
            Call.card_id.in_([c.id for c in cards]),
            Call.ended_at.is_(None),
        )
        .order_by(Call.id)
        .with_for_update()
    )
    for call in calls:
        call.ended_at, call.end_reason = now, "session_finished"
        await notify(db, "call.state", call.id)


async def finish(
    request: Request, session_id: UUID, request_id: UUID | None = None
) -> schemas.Session:
    db = request.state.db
    lesson = await repo.get_session(db, session_id, lock=True)
    if lesson is None:
        raise HTTPException(404, "Занятие не найдено.")
    ensure_owner(lesson, request.state.user)
    user = request.state.user
    # Обучаемый завершает только свою личную тренировку: иначе её не закрыть ничем, кроме
    # новой тренировки. Занятие преподавателя и чужая тренировка — как несуществующие.
    if user.role == "trainee" and (lesson.kind != "practice" or lesson.teacher_id != user.id):
        raise HTTPException(404, "Занятие не найдено.")
    if request_id is None and lesson.status != "running":
        raise HTTPException(409, "Завершить можно только идущее занятие.")
    saved = await db.scalar(select(SessionFinish).where(SessionFinish.session_id == session_id))
    if saved is not None:
        return schemas.Session.model_validate(saved.receipt)
    request.state.entity = "session"
    request.state.entity_id = str(session_id)
    request.state.audit_before = serialize(lesson).model_dump(mode="json")
    now = lesson.finished_at or datetime.now(UTC)
    await stop_attempts(db, session_id, now)
    lesson.status, lesson.finished_at = "finished", now
    result = serialize(lesson)
    db.add(
        SessionFinish(
            session_id=session_id,
            teacher_id=request.state.user.id,
            request_id=request_id,
            receipt=result.model_dump(mode="json"),
        )
    )
    await enqueue_job(
        db,
        kind="insights",
        payload={"session_id": str(session_id)},
        entity_id=session_id,
        version=1,
    )
    await db.flush()
    request.state.audit_after = result.model_dump(mode="json")
    await notify(db, "session.finished", session_id)
    return result


async def get_lifecycle(request: Request, session_id: UUID) -> SessionLifecycle:
    db = request.state.db
    # Снимок не должен смешивать состояние до и после finish.
    lesson = await repo.get_session(db, session_id, lock=True)
    if lesson is None:
        raise HTTPException(404, "Занятие не найдено.")
    ensure_owner(lesson, request.state.user)
    own = request.state.user.id if request.state.user.role == "trainee" else None
    if own and not any(p.user_id == own for p in lesson.participants):
        raise HTTPException(404, "Занятие не найдено.")
    query = (
        select(Assignment, Participant.user_id)
        .join(
            Participant,
            Participant.id == Assignment.participant_id,
        )
        .where(Assignment.session_id == session_id)
        .order_by(Assignment.order, Assignment.id)
    )
    if own:
        query = query.where(Participant.user_id == own)
    assignments = list((await db.execute(query)).tuples())
    owners = {a.id: user_id for a, user_id in assignments}
    cards = list(
        (
            await db.scalars(
                select(Card)
                .where(
                    Card.assignment_id.in_(owners),
                )
                .order_by(Card.appeared_at, Card.id)
            )
        ).all()
    )
    calls = list(
        (
            await db.scalars(
                select(Call)
                .where(
                    Call.card_id.in_([c.id for c in cards]),
                )
                .order_by(Call.started_at, Call.id)
            )
        ).all()
    )
    # Назначения после старта не добавляются (batches — только в черновике), поэтому
    # 0 у идущего занятия значит «все закончили»: кабинет предлагает его завершить.
    finished_cards = {c.assignment_id for c in cards if c.closed_at or c.interrupted_at}
    remaining = sum(
        1 for a, _ in assignments if a.cancelled_at is None and a.id not in finished_cards
    )
    attempts = []
    for card in cards:
        card_calls = [call for call in calls if call.card_id == card.id]
        active = next((call for call in card_calls if call.ended_at is None), None)
        recording = "none"
        if active:
            recording = "recording"
        elif any(call.audio_path is None for call in card_calls):
            recording = "upload_pending"
        elif card_calls:
            recording = "saved"
        attempts.append(
            {
                "card_id": str(card.id),
                "participant_id": str(owners[card.assignment_id]),
                "status": "completed"
                if card.closed_at
                else ("interrupted" if card.interrupted_at else "active"),
                "interrupted_at": timestamp(card.interrupted_at),
                "active_call_id": str(active.id) if active else None,
                "recording_status": recording,
            }
        )
    return SessionLifecycle(
        {
            "session_id": str(session_id),
            "status": lesson.status,
            "started_at": timestamp(lesson.started_at),
            "finished_at": timestamp(lesson.finished_at),
            "timing_policy": lesson.timing_policy,
            "cancelled_assignment_ids": [str(a.id) for a, _ in assignments if a.cancelled_at],
            "remaining_assignments": remaining,
            "attempts": attempts,
        }
    )
