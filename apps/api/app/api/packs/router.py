from collections.abc import Callable
from typing import Any
from uuid import UUID

from fastapi import Request

from app.api.c01 import reject_extensions
from app.api.packs import schemas, service


async def generate_pack(request: Request, body: schemas.GenerateInput) -> schemas.Job:
    reject_extensions("generatePack", body.model_dump(exclude_unset=True), request.state.user.role)
    return await service.generate_pack(request, body)


async def get_job(request: Request, id: UUID) -> schemas.Job:
    return await service.get_job(request.state.db, id)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "generatePack": (generate_pack, schemas.Job),
    "getJob": (get_job, schemas.Job),
}
