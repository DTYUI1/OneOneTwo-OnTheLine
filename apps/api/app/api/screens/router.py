from collections.abc import Callable
from typing import Any
from uuid import UUID

from fastapi import Request

from app.api.screens import schemas, service


async def list_screens(request: Request, id: UUID) -> list[schemas.ScreenShare]:
    return await service.list_screens(request, id)


async def request_screen(request: Request, id: UUID, user_id: UUID) -> schemas.ScreenShare:
    return await service.request_share(request, id, user_id)


async def stop_screen(request: Request, id: UUID, user_id: UUID) -> schemas.ScreenShare:
    return await service.stop_share(request, id, user_id)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "listSessionScreens": (list_screens, list[schemas.ScreenShare]),
    "requestScreenShare": (request_screen, schemas.ScreenShare),
    "stopScreenShare": (stop_screen, schemas.ScreenShare),
}
