"""C-07: учётные записи — создание, правка, блокировка, сброс пароля (ТЗ, роль администратора).

Удаление — через корзину (foundation/trash.py): история занятий, оценок и аудита ссылается
на пользователя, а ТЗ запрещает удалять критичные данные без процедуры резервного копирования.
Блокировка и сброс пароля сразу отзывают серверные сессии; открытые WebSocket закрываются
через NOTIFY во всех процессах API.
"""

from typing import Any
from uuid import UUID, uuid4

from fastapi import HTTPException, Request
from sqlalchemy import delete, exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.foundation import schemas
from app.api.notifications import notify
from app.core.models import (
    AuthSession,
    Material,
    Participant,
    Scenario,
    ScenarioPack,
    Service,
    Session,
    TeacherOverride,
    User,
    UserDeletion,
)
from app.core.security import hash_password

REVOKED = "user.revoked"


def public(user: User) -> dict[str, Any]:
    """Поля для аудита: без хеша пароля и прочих секретов."""
    return schemas.User.model_validate(user).model_dump(mode="json")


async def check_profile(
    db: AsyncSession, role: str, workstation: int | None, service_id: str | None
) -> None:
    if role != "trainee" and (workstation is not None or service_id is not None):
        raise HTTPException(
            422,
            {
                "code": "profile_not_allowed",
                "message": "АРМ и служба задаются только обучаемому.",
                "details": {},
            },
        )
    if service_id is not None and await db.get(Service, service_id) is None:
        raise HTTPException(
            422, {"code": "unknown_service", "message": "Такой службы нет.", "details": {}}
        )


async def has_history(db: AsyncSession, user_id: UUID) -> bool:
    """Есть ли у пользователя учебная история, которую смена роли сделала бы ложной."""
    links = (
        Participant.user_id,
        Session.teacher_id,
        Scenario.author_id,
        ScenarioPack.created_by,
        Material.owner_id,
        TeacherOverride.teacher_id,
    )
    for column in links:
        if await db.scalar(select(exists().where(column == user_id))):
            return True
    return False


async def revoke(db: AsyncSession, user_id: UUID, keep: UUID | None = None) -> None:
    """Выйти из всех сессий пользователя; keep — текущая сессия того, кто меняет свой пароль."""
    query = delete(AuthSession).where(AuthSession.user_id == user_id)
    if keep is not None:
        query = query.where(AuthSession.id != keep)
    await db.execute(query)
    await notify(db, REVOKED, user_id)


async def create_user(request: Request, body: schemas.UserCreate) -> schemas.User:
    db: AsyncSession = request.state.db
    request.state.entity = "users"
    if await db.scalar(select(exists().where(User.login == body.login))):
        raise HTTPException(
            409, {"code": "login_taken", "message": "Такой логин уже есть.", "details": {}}
        )
    await check_profile(db, body.role, body.workstation_number, body.dds_service_id)
    user = User(
        id=uuid4(),
        login=body.login,
        full_name=body.full_name,
        role=body.role,
        password_hash=await hash_password(body.password),
        is_active=True,
        workstation_number=body.workstation_number,
        dds_service_id=body.dds_service_id,
    )
    db.add(user)
    await db.flush()
    request.state.entity_id = str(user.id)
    request.state.audit_after = public(user)
    return schemas.User.model_validate(user)


async def locked_user(db: AsyncSession, user_id: UUID) -> User:
    user = await db.get(User, user_id, with_for_update=True)
    if user is None:
        raise HTTPException(404, "Пользователь не найден.")
    return user


def conflict(code: str, message: str) -> HTTPException:
    return HTTPException(409, {"code": code, "message": message, "details": {}})


async def ensure_not_deleted(db: AsyncSession, user_id: UUID) -> None:
    """Правка и пароль — только у действующей учётки: из корзины сначала восстанавливают."""
    if await db.get(UserDeletion, user_id) is not None:
        raise conflict(
            "user_deleted", "Учётная запись в корзине. Сначала восстановите её в корзине."
        )


async def update_user(request: Request, user_id: UUID, body: schemas.UserUpdate) -> schemas.User:
    db: AsyncSession = request.state.db
    request.state.entity, request.state.entity_id = "users", str(user_id)
    user = await locked_user(db, user_id)
    await ensure_not_deleted(db, user.id)
    actor = request.state.user
    role_changed = body.role != user.role
    blocking = user.is_active and not body.is_active
    # Действующий администратор не снимает права сам с себя — поэтому в системе всегда
    # остаётся хотя бы один администратор, который может разблокировать остальных.
    if user.id == actor.id and (role_changed or not body.is_active):
        raise HTTPException(
            409,
            {
                "code": "self_lockout",
                "message": "Свою роль и доступ меняет другой администратор.",
                "details": {},
            },
        )
    if role_changed and await has_history(db, user.id):
        raise HTTPException(
            409,
            {
                "code": "role_has_history",
                "message": "У пользователя уже есть занятия или материалы — роль не меняется. "
                "Создайте новую учётную запись.",
                "details": {},
            },
        )
    await check_profile(db, body.role, body.workstation_number, body.dds_service_id)
    request.state.audit_before = public(user)
    user.full_name = body.full_name
    user.role = body.role
    user.workstation_number = body.workstation_number
    user.dds_service_id = body.dds_service_id
    user.is_active = body.is_active
    if blocking or role_changed:
        # Роль в уже выданной сессии не должна остаться прежней до конца её срока.
        await revoke(db, user.id)
    await db.flush()
    request.state.audit_after = public(user)
    return schemas.User.model_validate(user)


async def reset_password(
    request: Request, user_id: UUID, body: schemas.PasswordReset
) -> schemas.User:
    db: AsyncSession = request.state.db
    request.state.entity, request.state.entity_id = "users", str(user_id)
    user = await locked_user(db, user_id)
    await ensure_not_deleted(db, user.id)
    user.password_hash = await hash_password(body.password)
    own = user.id == request.state.user.id
    # Свой пароль: текущая вкладка остаётся, остальные сессии закрываются.
    await revoke(db, user.id, keep=request.state.auth_session.id if own else None)
    request.state.audit_after = {"password_reset": True, "sessions_revoked": True}
    return schemas.User.model_validate(user)
