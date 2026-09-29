from collections.abc import Callable
from typing import Any

from fastapi import Request

from app.api.problem_reports import schemas, service


async def create_problem_report(
    request: Request, body: schemas.ProblemReportInput
) -> schemas.ProblemReport:
    return await service.create(request, body)


async def list_problem_reports(request: Request) -> list[schemas.ProblemReport]:
    return await service.list_reports(request)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "createProblemReport": (create_problem_report, schemas.ProblemReport),
    "listProblemReports": (list_problem_reports, list[schemas.ProblemReport]),
}
