from collections.abc import Callable
from typing import Any
from uuid import UUID

from fastapi import Request

from app.api.content import correction, service
from app.api.packs.schemas import Job


async def preview_scenario(
    request: Request, body: service.ScenarioPreviewInput
) -> service.ScenarioPreviewView:
    return await service.preview(request, body)


async def get_job_progress(request: Request, id: UUID) -> service.JobProgressView:
    return await service.job_progress(request, id)


async def approve_pack(
    request: Request, id: UUID, body: service.PackApprovalInput
) -> service.PackApprovalView:
    return await service.approve_pack(request, id, body)


async def get_scenario_content(request: Request, id: UUID) -> service.ScenarioContentView:
    return await service.scenario_content(request, id)


async def regenerate_scenario(request: Request, id: UUID, body: correction.CorrectionInput) -> Job:
    return await correction.regenerate(request, id, body)


async def stop_generation(request: Request, id: UUID) -> service.JobProgressView:
    from fastapi import HTTPException

    from app.core.models import Job, ScenarioPack
    from app.worker.cancellation import request_stop

    db = request.state.db
    job = await db.get(Job, id)
    if job is None or job.kind != "generate" or not job.payload.get("pack_id"):
        raise HTTPException(404, "Генерация не найдена.")
    pack = await db.get(ScenarioPack, UUID(job.payload["pack_id"]))
    if pack is None or pack.created_by != request.state.user.id:
        raise HTTPException(403, "Остановить генерацию может только её автор.")
    if job.payload.get("previous_scenario_id"):
        raise HTTPException(409, "Это пересоздание отдельного сценария, а не генерация пакета.")
    if job.status not in {"pending", "running", "cancelled"}:
        raise HTTPException(409, "Генерация уже завершена.")
    if not await request_stop(db, id, request.state.user.id):
        raise HTTPException(409, "Генерация уже завершена.")
    request.state.entity, request.state.entity_id = "job", str(id)
    request.state.audit_after = {"stop_requested": True}
    return await service.job_progress(request, id)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "regenerateScenario": (regenerate_scenario, Job),
    "previewScenario": (preview_scenario, service.ScenarioPreviewView),
    "stopGeneration": (stop_generation, service.JobProgressView),
    "getJobProgress": (get_job_progress, service.JobProgressView),
    "approvePack": (approve_pack, service.PackApprovalView),
    "getScenarioContent": (get_scenario_content, service.ScenarioContentView),
}
