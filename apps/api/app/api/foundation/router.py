import copy
import secrets
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from app.api.foundation import repo, schemas, service, trash
from app.api.foundation import users as users_service
from app.core.security import csrf_digest, read_token


def require_roles(*roles: str, public: bool = False) -> Callable[[Request], Awaitable[None]]:
    async def check(request: Request) -> None:
        if public:
            return
        sid, user_id = read_token(request.cookies.get("session", ""), request.app.state.config)
        found = await repo.authenticate(request.state.db, sid, user_id)
        if found is None:
            raise HTTPException(401, "Войдите в систему.")
        session, user = found
        request.state.user = user
        request.state.auth_session = session
        request.state.actor_id = user.id
        if user.role not in roles:
            raise HTTPException(403, "Недостаточно прав.")
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            csrf = request.headers.get("X-CSRF-Token", "")
            cookie = request.cookies.get("csrf", "")
            if (
                not csrf
                or not secrets.compare_digest(csrf.encode(), cookie.encode())
                or not secrets.compare_digest(csrf_digest(csrf), session.csrf_hash)
            ):
                raise HTTPException(403, "Неверный CSRF-токен.")

    return check


async def login(request: Request, body: schemas.Login, response: Response) -> schemas.User:
    return await service.login(request, body, response)


async def logout(request: Request, response: Response) -> schemas.User:
    return await service.logout(request, response)


async def me(request: Request) -> schemas.User:
    return schemas.User.model_validate(request.state.user)


async def users(request: Request) -> list[schemas.User]:
    # Удалённые тоже в списке (с deleted_at): отчёты и журнал находят человека по id.
    deleted = await trash.deleted_at(request.state.db)
    return [trash.view(user, deleted.get(user.id)) for user in await repo.users(request.state.db)]


async def update_settings(request: Request, body: schemas.Settings) -> schemas.Settings:
    return await service.update_settings(request, body)


async def create_user(request: Request, body: schemas.UserCreate) -> schemas.User:
    return await users_service.create_user(request, body)


async def update_user(request: Request, id: UUID, body: schemas.UserUpdate) -> schemas.User:
    return await users_service.update_user(request, id, body)


async def reset_user_password(
    request: Request, id: UUID, body: schemas.PasswordReset
) -> schemas.User:
    return await users_service.reset_password(request, id, body)


async def trash_user(request: Request, id: UUID, body: schemas.TrashInput) -> schemas.User:
    return await trash.trash_user(request, id, body)


async def restore_user(request: Request, id: UUID) -> schemas.User:
    return await trash.restore_user(request, id)


async def list_trash(request: Request) -> schemas.TrashList:
    return await trash.list_trash(request)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "login": (login, schemas.User),
    "logout": (logout, schemas.User),
    "me": (me, schemas.User),
    "listUsers": (users, list[schemas.User]),
    "createUser": (create_user, schemas.User),
    "updateUser": (update_user, schemas.User),
    "resetUserPassword": (reset_user_password, schemas.User),
    "trashUser": (trash_user, schemas.User),
    "restoreUser": (restore_user, schemas.User),
    "listTrash": (list_trash, schemas.TrashList),
    "getSettings": (service.get_settings, schemas.Settings),
    "updateSettings": (update_settings, schemas.Settings),
    "health": (service.health, schemas.Health),
    "adminHealth": (service.health, schemas.Health),
}


def make_router(
    spec: dict[str, Any],
    endpoints: dict[str, tuple[Callable[..., Any], Any]],
) -> APIRouter:
    routes = APIRouter()
    for path, methods in spec["paths"].items():
        for method, operation in methods.items():
            if operation["operationId"] not in endpoints:
                continue
            handler, response_model = endpoints[operation["operationId"]]
            responses = copy.deepcopy(operation["responses"])
            for code, response in responses.items():
                if code.startswith("2"):
                    for content in response.get("content", {}).values():
                        # Схема успеха должна происходить из response_model, а не из draft.
                        content.pop("schema", None)
            extra = {key: operation[key] for key in ("security", "x-roles")}
            if "parameters" in operation:
                # Path-параметры выводятся из сигнатуры: повторение нарушит OpenAPI.
                extra["parameters"] = [
                    item for item in operation["parameters"] if item["in"] != "path"
                ]
            if "requestBody" in operation:
                json_content = operation["requestBody"]["content"].get("application/json")
                if json_content and "example" in json_content:
                    extra["requestBody"] = {
                        "content": {"application/json": {"example": json_content["example"]}}
                    }
            routes.add_api_route(
                path,
                handler,
                methods=[method.upper()],
                operation_id=operation["operationId"],
                response_model=response_model,
                status_code=int(next(code for code in responses if code.startswith("2"))),
                summary=operation["summary"],
                description=operation.get("description"),
                tags=operation["tags"],
                dependencies=[
                    Depends(require_roles(*operation["x-roles"], public=not operation["security"]))
                ],
                responses={int(code): value for code, value in responses.items()},
                openapi_extra=extra,
            )
    return routes
