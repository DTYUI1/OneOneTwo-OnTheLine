from collections.abc import Callable
from typing import Any
from uuid import UUID

from fastapi import Request

from app.api.injects import schemas, service


async def list_injects(request: Request, id: UUID) -> schemas.InjectOverview:
    return await service.overview(request, id)


async def create_inject(
    request: Request, id: UUID, body: schemas.InjectInput
) -> schemas.InjectReceipt:
    return await service.inject(request, id, body)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "listSessionInjects": (list_injects, schemas.InjectOverview),
    "createSessionInject": (create_inject, schemas.InjectReceipt),
}
