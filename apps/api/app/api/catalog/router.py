from collections.abc import Callable
from typing import Any

from fastapi import Request

from app.api.catalog import schemas, service


async def services(request: Request) -> list[schemas.Service]:
    return await service.list_services(request.state.db)


async def update_service(request: Request, id: str, body: schemas.ServiceUpdate) -> schemas.Service:
    return await service.update_service(request, id, body)


async def incident_types(request: Request) -> list[schemas.IncidentType]:
    return await service.list_incident_types(request.state.db)


async def packs(request: Request) -> list[schemas.Pack]:
    return await service.list_packs(request.state.db)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "listServices": (services, list[schemas.Service]),
    "updateService": (update_service, schemas.Service),
    "listIncidentTypes": (incident_types, list[schemas.IncidentType]),
    "listPacks": (packs, list[schemas.Pack]),
}
