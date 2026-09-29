from collections.abc import Callable
from typing import Annotated, Any
from uuid import UUID

from fastapi import Query, Request, Response

from app.api.training import audio, service


async def list_brigades(request: Request, id: str) -> list[service.BrigadeView]:
    return await service.catalog(request, id)


async def list_targets(request: Request, id: str) -> list[service.CallTargetView]:
    return await service.catalog(request, id, targets=True)


async def get_training(request: Request, id: UUID) -> service.TrainingView:
    return await service.get_training(request, id)


async def download_audio(
    request: Request, id: UUID, delivery_id: UUID, version: Annotated[int, Query(ge=1)]
) -> Response:
    return await audio.download(request, id, delivery_id, version)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "listBrigades": (list_brigades, list[service.BrigadeView]),
    "listCallTargets": (list_targets, list[service.CallTargetView]),
    "getCardTraining": (get_training, service.TrainingView),
    "downloadInformationAudio": (download_audio, None),
}
