from collections.abc import Callable
from typing import Any
from uuid import UUID

from fastapi import Request, Response

from app.api.evaluations import schemas, service


async def list_evaluations(request: Request) -> list[schemas.Evaluation]:
    return await service.list_evaluations(request)


async def get_evaluation(request: Request, id: UUID) -> schemas.Evaluation:
    return await service.get_evaluation(request, id)


async def create_override(request: Request, body: schemas.OverrideInput) -> schemas.Evaluation:
    return await service.create_override(request, body)


async def get_session_report(request: Request, id: UUID) -> schemas.Report:
    return await service.get_session_report(request, id)


async def export_session_csv(request: Request, id: UUID) -> Response:
    return await service.export_session_csv(request, id)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "listEvaluations": (list_evaluations, list[schemas.Evaluation]),
    "getEvaluation": (get_evaluation, schemas.Evaluation),
    "createOverride": (create_override, schemas.Evaluation),
    "getSessionReport": (get_session_report, schemas.Report),
    "exportSessionCsv": (export_session_csv, str),
}
