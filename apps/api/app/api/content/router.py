from collections.abc import Callable
from typing import Any
from uuid import UUID

from fastapi import Request

from app.api.content import service


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


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "previewScenario": (preview_scenario, service.ScenarioPreviewView),
    "getJobProgress": (get_job_progress, service.JobProgressView),
    "approvePack": (approve_pack, service.PackApprovalView),
    "getScenarioContent": (get_scenario_content, service.ScenarioContentView),
}
