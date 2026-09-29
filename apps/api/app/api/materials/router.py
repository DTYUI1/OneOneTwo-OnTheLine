from collections.abc import Callable
from typing import Annotated, Any
from uuid import UUID

from fastapi import File, Form, Query, Request, UploadFile
from fastapi.responses import FileResponse

from app.api.materials import service


async def list_materials(request: Request) -> list[service.MaterialView]:
    return await service.list_materials(request)


async def upload_material(
    request: Request,
    file: Annotated[UploadFile, File()],
    metadata: Annotated[str, Form()],
) -> service.MaterialView:
    return await service.upload(request, file, metadata)


async def download_material(
    request: Request, id: UUID, version: Annotated[int, Query(ge=1)]
) -> FileResponse:
    return await service.download(request, id, version)


async def assign_materials(
    request: Request, id: UUID, body: service.MaterialAssignmentInput
) -> list[service.MaterialView]:
    return await service.assign(request, id, body)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "listMaterials": (list_materials, list[service.MaterialView]),
    "uploadMaterial": (upload_material, service.MaterialView),
    "downloadMaterial": (download_material, None),
    "assignMaterials": (assign_materials, list[service.MaterialView]),
}
