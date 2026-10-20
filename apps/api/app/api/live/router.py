"""Ход занятия: пауза и сообщение ученику — contracts/live-lesson.md (TC-12).

Как и выключатель модуля 112, операции вне openapi.json. Пауза держит scheduler
(worker/scheduler.py), а при снятии сдвигает сроки ещё не выданных карточек.
"""

from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func, select, update

from app.api.foundation.router import require_roles
from app.api.sessions import repo
from app.core.models import Assignment, Card, Participant, Session, TeacherMessage

router = APIRouter(prefix="/api", include_in_schema=False)
teacher = [Depends(require_roles("teacher"))]
trainee = [Depends(require_roles("trainee"))]

TEXT_MAX = 500


class PauseInput(BaseModel):
    participant_id: UUID | None = None


class LivePause(BaseModel):
    paused_at: datetime | None
    participants: dict[UUID, datetime]


class MessageInput(BaseModel):
    user_id: UUID
    text: str


class Message(BaseModel):
    id: UUID
    session_id: UUID
    user_id: UUID
    text: str
    sent_at: datetime
    read_at: datetime | None


class Live(LivePause):
    messages: list[Message]


async def _running(request: Request, session_id: UUID) -> Session:
    """Идущее занятие этого преподавателя; строка заблокирована, как в scheduler."""
    row = await repo.get_session(request.state.db, session_id, lock=True)
    if row is None or row.teacher_id != request.state.user.id or row.kind != "lesson":
        raise HTTPException(404, "Занятие не найдено.")
    if row.status != "running":
        raise HTTPException(409, "Занятие не идёт.")
    return row


def _participant(row: Session, user_id: UUID) -> Participant:
    found = next((item for item in row.participants if item.user_id == user_id), None)
    if found is None:
        raise HTTPException(422, "Этого ученика нет в занятии.")
    return found


def _pause_view(row: Session) -> LivePause:
    return LivePause(
        paused_at=row.paused_at,
        participants={
            item.user_id: item.paused_at for item in row.participants if item.paused_at is not None
        },
    )


def _message(row: TeacherMessage) -> Message:
    return Message(
        id=row.id,
        session_id=row.session_id,
        user_id=row.user_id,
        text=row.text,
        sent_at=row.sent_at,
        read_at=row.read_at,
    )


async def _shift_due(
    request: Request, row: Session, shift: timedelta, user_id: UUID | None
) -> None:
    """Сроки ещё не выданных карточек — на длину паузы позже."""
    query = (
        update(Assignment)
        .where(
            Assignment.session_id == row.id,
            Assignment.status == "pending",
            Assignment.cancelled_at.is_(None),
            ~select(Card.id).where(Card.assignment_id == Assignment.id).exists(),
        )
        .values(due_at=func.coalesce(Assignment.due_at, Assignment.planned_at) + shift)
    )
    if user_id is not None:
        query = query.where(
            Assignment.participant_id
            == select(Participant.id)
            .where(Participant.session_id == row.id, Participant.user_id == user_id)
            .scalar_subquery()
        )
    await request.state.db.execute(query)


@router.post("/sessions/{session_id}/pause", operation_id="live_pause", dependencies=teacher)
async def pause(session_id: UUID, body: PauseInput, request: Request) -> LivePause:
    row = await _running(request, session_id)
    now = datetime.now(UTC)
    if row.paused_at is not None:
        raise HTTPException(409, "Занятие уже на паузе.")
    if body.participant_id is None:
        row.paused_at = now
    else:
        participant = _participant(row, body.participant_id)
        if participant.paused_at is not None:
            raise HTTPException(409, "Ученик уже на паузе.")
        participant.paused_at = now
    request.state.entity = "session"
    request.state.entity_id = str(row.id)
    await request.state.db.flush()
    return _pause_view(row)


@router.post("/sessions/{session_id}/resume", operation_id="live_resume", dependencies=teacher)
async def resume(session_id: UUID, body: PauseInput, request: Request) -> LivePause:
    row = await _running(request, session_id)
    now = datetime.now(UTC)
    if body.participant_id is None:
        if row.paused_at is None:
            raise HTTPException(409, "Занятие не на паузе.")
        shift = now - row.paused_at
        await _shift_due(request, row, shift, None)
        # Пауза ученика, начатая раньше, этот отрезок уже не учтёт второй раз.
        for item in row.participants:
            if item.paused_at is not None:
                item.paused_at += shift
        row.paused_at = None
    else:
        if row.paused_at is not None:
            raise HTTPException(409, "Сначала снимите паузу занятия.")
        participant = _participant(row, body.participant_id)
        if participant.paused_at is None:
            raise HTTPException(409, "Ученик не на паузе.")
        await _shift_due(request, row, now - participant.paused_at, participant.user_id)
        participant.paused_at = None
    request.state.entity = "session"
    request.state.entity_id = str(row.id)
    await request.state.db.flush()
    return _pause_view(row)


@router.post(
    "/sessions/{session_id}/messages",
    operation_id="live_message_send",
    status_code=201,
    dependencies=teacher,
)
async def send_message(session_id: UUID, body: MessageInput, request: Request) -> Message:
    row = await _running(request, session_id)
    text = body.text.strip()
    if not 1 <= len(text) <= TEXT_MAX:
        raise HTTPException(422, f"Сообщение — от 1 до {TEXT_MAX} знаков.")
    _participant(row, body.user_id)
    message = TeacherMessage(
        session_id=row.id,
        user_id=body.user_id,
        teacher_id=request.state.user.id,
        text=text,
        sent_at=datetime.now(UTC),
        read_at=None,
    )
    request.state.db.add(message)
    await request.state.db.flush()
    request.state.entity = "teacher_message"
    request.state.entity_id = str(message.id)
    return _message(message)


@router.get("/sessions/{session_id}/live", operation_id="live_view", dependencies=teacher)
async def live(session_id: UUID, request: Request) -> Live:
    row = await repo.get_session(request.state.db, session_id)
    if row is None or row.teacher_id != request.state.user.id or row.kind != "lesson":
        raise HTTPException(404, "Занятие не найдено.")
    messages = await request.state.db.scalars(
        select(TeacherMessage)
        .where(TeacherMessage.session_id == row.id)
        .order_by(TeacherMessage.sent_at, TeacherMessage.id)
    )
    return Live(**_pause_view(row).model_dump(), messages=[_message(item) for item in messages])


@router.get("/messages", operation_id="live_messages", dependencies=trainee)
async def own_messages(request: Request) -> list[Message]:
    rows = await request.state.db.scalars(
        select(TeacherMessage)
        .join(Session, Session.id == TeacherMessage.session_id)
        .where(TeacherMessage.user_id == request.state.user.id, Session.status == "running")
        .order_by(TeacherMessage.sent_at, TeacherMessage.id)
    )
    return [_message(item) for item in rows]


@router.post("/messages/{message_id}/read", operation_id="live_message_read", dependencies=trainee)
async def read(message_id: UUID, request: Request) -> Message:
    row = await request.state.db.get(TeacherMessage, message_id, with_for_update=True)
    if row is None or row.user_id != request.state.user.id:
        raise HTTPException(404, "Сообщение не найдено.")
    if row.read_at is None:
        row.read_at = datetime.now(UTC)
    request.state.entity = "teacher_message"
    request.state.entity_id = str(row.id)
    return _message(row)
