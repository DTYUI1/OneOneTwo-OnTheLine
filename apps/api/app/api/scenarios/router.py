from collections.abc import Callable
from typing import Any
from uuid import UUID

from fastapi import Request

from app.api.scenarios import schemas, service


async def list_scenarios(request: Request) -> list[schemas.Scenario]:
    return await service.list_scenarios(request.state.db)


async def get_scenario(request: Request, id: UUID) -> schemas.Scenario:
    return await service.get_scenario(request.state.db, id)


async def create_scenario(request: Request, body: schemas.Scenario) -> schemas.Scenario:
    return await service.create_scenario(request, body)


async def update_scenario(request: Request, id: UUID, body: schemas.Scenario) -> schemas.Scenario:
    return await service.update_scenario(request, id, body)


async def retire_scenario(request: Request, id: UUID) -> schemas.Scenario:
    return await service.retire_scenario(request, id)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "listScenarios": (list_scenarios, list[schemas.Scenario]),
    "getScenario": (get_scenario, schemas.Scenario),
    "createScenario": (create_scenario, schemas.Scenario),
    "updateScenario": (update_scenario, schemas.Scenario),
    "retireScenario": (retire_scenario, schemas.Scenario),
}
