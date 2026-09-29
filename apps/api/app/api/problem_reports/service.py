from fastapi import Request

from app.api.problem_reports import repo, schemas
from app.core.models import ProblemReport, User


def serialize(report: ProblemReport, author: User) -> schemas.ProblemReport:
    # Роль и категория в БД ограничены CHECK; model_validate сверит их с Literal.
    return schemas.ProblemReport.model_validate(
        {
            "id": report.id,
            "author_id": report.author_id,
            "author_name": author.full_name,
            "author_role": report.author_role,
            "category": report.category,
            "text": report.text,
            "page": report.page,
            "created_at": report.created_at,
        }
    )


async def create(request: Request, body: schemas.ProblemReportInput) -> schemas.ProblemReport:
    db = request.state.db
    user: User = request.state.user
    report = ProblemReport(
        author_id=user.id,
        author_role=user.role,
        category=body.category,
        text=body.text,
        page=body.page,
    )
    db.add(report)
    await db.flush()
    await db.refresh(report)
    # В журнал аудита — только факт и категория: текст может содержать ПДн.
    request.state.entity = "problem_report"
    request.state.entity_id = str(report.id)
    request.state.audit_after = {"category": report.category, "page": report.page}
    return serialize(report, user)


async def list_reports(request: Request) -> list[schemas.ProblemReport]:
    return [serialize(report, author) for report, author in await repo.latest(request.state.db)]
