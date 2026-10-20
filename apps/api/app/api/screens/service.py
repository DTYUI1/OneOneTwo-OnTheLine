"""HTTP показа экрана (HQ-017): кто кого может попросить и остановить. Кадры — `hub.py`."""

from uuid import UUID

from fastapi import HTTPException, Request

from app.api.screens import schemas
from app.api.screens.hub import ScreenHub
from app.api.sessions import repo as session_repo
from app.api.sessions.service import ensure_owner
from app.core.models import Session, User


def _hub(request: Request) -> ScreenHub:
    hub: ScreenHub = request.app.state.screens
    return hub


async def _lesson(request: Request, session_id: UUID) -> Session:
    """Занятие, видимое пользователю: автор-преподаватель или обучаемый из состава."""
    user: User = request.state.user
    lesson = await session_repo.get_session(request.state.db, session_id)
    if lesson is None:
        raise HTTPException(404, "Занятие не найдено.")
    ensure_owner(lesson, user)
    if user.role == "trainee" and not any(p.user_id == user.id for p in lesson.participants):
        raise HTTPException(404, "Занятие не найдено.")
    return lesson


def _audit(request: Request, session_id: UUID, user_id: UUID, state: str) -> None:
    # В журнал — кто и чей показ, без кадров (ПДн, CONTRIBUTING §8).
    request.state.entity = "screen_share"
    request.state.entity_id = str(user_id)
    request.state.audit_after = {"session_id": str(session_id), "state": state}


async def list_screens(request: Request, session_id: UUID) -> list[schemas.ScreenShare]:
    user: User = request.state.user
    await _lesson(request, session_id)
    await _hub(request).sweep()
    return [
        schemas.ScreenShare.model_validate(_hub(request).view(share))
        for share in _hub(request).session_shares(session_id)
        if user.role == "teacher" or share.user_id == user.id
    ]


async def request_share(request: Request, session_id: UUID, user_id: UUID) -> schemas.ScreenShare:
    lesson = await _lesson(request, session_id)
    if lesson.status != "running" or lesson.kind != "lesson":
        raise HTTPException(409, "Смотреть экран можно только в идущем занятии.")
    if not any(p.user_id == user_id for p in lesson.participants):
        raise HTTPException(422, "Обучаемого нет в составе занятия.")
    share = await _hub(request).request(session_id, lesson.teacher_id, user_id)
    _audit(request, session_id, user_id, "requested")
    return schemas.ScreenShare.model_validate(_hub(request).view(share))


async def stop_share(request: Request, session_id: UUID, user_id: UUID) -> schemas.ScreenShare:
    user: User = request.state.user
    await _lesson(request, session_id)
    if user.role == "trainee" and user_id != user.id:
        # Обучаемый останавливает только свой показ; чужой для него не существует.
        raise HTTPException(404, "Показ не найден.")
    payload = await _hub(request).stop(session_id, user_id)
    _audit(request, session_id, user_id, "stopped")
    return schemas.ScreenShare.model_validate(payload)
