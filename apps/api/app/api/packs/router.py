import asyncio
from collections.abc import Callable
from typing import Annotated, Any
from uuid import UUID

from fastapi import HTTPException, Query, Request

from app.api.c01 import reject_extensions
from app.api.content.service import JobProgressView
from app.api.packs import schemas, service
from app.worker.generators.themes import CATEGORIES, Category


async def generate_pack(request: Request, body: schemas.GenerateInput) -> schemas.Job:
    reject_extensions("generatePack", body.model_dump(exclude_unset=True), request.state.user.role)
    return await service.generate_pack(request, body)


async def get_job(request: Request, id: UUID) -> schemas.Job:
    return await service.get_job(request.state.db, id)


async def resource_state(request: Request) -> schemas.AIResourceState:
    return await service.resource_state(request)


async def generation_jobs(request: Request) -> list[JobProgressView]:
    return await service.generation_jobs(request)


async def generation_variety(
    request: Request,
    service_id: str,
    level: Annotated[int, Query(ge=1, le=4)],
    categories: Annotated[list[Category] | None, Query()] = None,
    trainee_login: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
) -> schemas.GenerationVariety:
    categories = categories or []
    from app.worker.generators.gameplay import template_candidates
    from app.worker.generators.validation import GenerationRejected

    try:
        count = len(template_candidates(service_id, level, tuple(categories)))
    except GenerationRejected as exc:
        raise HTTPException(422, str(exc)) from exc
    from app.worker.generators import variant_paths
    from app.worker.generators.storage import gameplay_history

    variants = await asyncio.to_thread(variant_paths.options, service_id, level, tuple(categories))
    trainee = (
        await service.trainee_by_login(request.state.db, trainee_login) if trainee_login else None
    )
    history = await gameplay_history(
        request.state.db,
        author_id=request.state.user.id,
        participant_id=trainee.id if trainee else None,
        all_lessons=True,
    )
    used = await asyncio.to_thread(variant_paths.usage, history, service_id, level)
    return schemas.GenerationVariety(
        count=count,
        variants_total=len(variants),
        variants_left=sum(not used[sig] for sig in variants),
    )


async def generation_categories() -> dict[str, str]:
    return CATEGORIES


async def search_generation_trainees(
    request: Request,
    login: Annotated[str, Query(min_length=1, max_length=100)],
    service_id: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
) -> list[schemas.GenerationTrainee]:
    return await service.search_trainees(request, login, service_id)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "searchGenerationTrainees": (search_generation_trainees, list[schemas.GenerationTrainee]),
    "getGenerationCategories": (generation_categories, dict[str, str]),
    "getGenerationVariety": (generation_variety, schemas.GenerationVariety),
    "generatePack": (generate_pack, schemas.Job),
    "getJob": (get_job, schemas.Job),
    "getAIResourceState": (resource_state, schemas.AIResourceState),
    "listGenerationJobs": (generation_jobs, list[JobProgressView]),
}
