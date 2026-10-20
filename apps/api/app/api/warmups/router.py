from collections.abc import Callable
from typing import Any

from fastapi import Request

from app.api.warmups import schemas, service


async def create_warmup_result(
    request: Request, body: schemas.WarmupResultInput
) -> schemas.WarmupResult:
    return await service.create(request, body)


async def list_warmup_results(request: Request) -> list[schemas.WarmupResult]:
    return await service.list_results(request)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "createWarmupResult": (create_warmup_result, schemas.WarmupResult),
    "listWarmupResults": (list_warmup_results, list[schemas.WarmupResult]),
}
