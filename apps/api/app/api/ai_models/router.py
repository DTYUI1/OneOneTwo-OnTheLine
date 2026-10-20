from collections.abc import Callable
from typing import Any

from fastapi import Request

from app.api.ai_models import schemas, service


async def get_ai_models(request: Request) -> schemas.AIModels:
    return await service.view(request)


async def set_active_ai_model(request: Request, body: schemas.AIModelChoice) -> schemas.AIModels:
    return await service.choose(request, body)


async def set_ai_gpu_notice(request: Request, body: schemas.AIGpuNotice) -> schemas.AIModels:
    return await service.set_notice(request, body)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "getAIModels": (get_ai_models, schemas.AIModels),
    "setActiveAIModel": (set_active_ai_model, schemas.AIModels),
    "setAIGpuNotice": (set_ai_gpu_notice, schemas.AIModels),
}
