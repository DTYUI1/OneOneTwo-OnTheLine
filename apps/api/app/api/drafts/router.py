from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

from fastapi import HTTPException, Request
from sqlalchemy import select

from app.api.foundation.schemas import ContractModel
from app.core.models import Assignment, Job, Scenario, Session
from app.worker.cancellation import request_stop


class DraftItem(ContractModel):
    id: UUID
    kind: Literal["session", "scenario"]
    title: str
    deleted_at: datetime
    deleted_by: UUID


class DraftResult(ContractModel):
    id: UUID


async def change(request: Request, id: UUID, kind: str, *, restore: bool = False) -> DraftResult:
    db = request.state.db
    model = Session if kind == "session" else Scenario
    row = await db.scalar(select(model).where(model.id == id).with_for_update())
    if row is None:
        raise HTTPException(404, "Черновик не найден.")
    owner = row.teacher_id if kind == "session" else row.author_id
    if not restore and owner != request.state.user.id:
        raise HTTPException(403, "Удалить черновик может только его автор.")
    if row.status != "draft":
        raise HTTPException(
            409,
            "Удалить можно только черновик. "
            "Начатое занятие или утверждённый сценарий удалять нельзя.",
        )
    if restore and row.deleted_at is None:
        raise HTTPException(409, "Черновик не удалён.")
    request.state.entity, request.state.entity_id = kind, str(id)
    request.state.audit_before = {
        "deleted_at": row.deleted_at.isoformat() if row.deleted_at else None
    }
    now = datetime.now(UTC)
    row.deleted_at = None if restore else now
    row.deleted_by = None if restore else request.state.user.id
    if not restore:
        if kind == "session":
            row.start_request = None
            if row.ai_preparation:
                job = await db.get(Job, UUID(row.ai_preparation["job_id"]))
                if job and job.status in {"pending", "running"}:
                    await request_stop(db, job.id, request.state.user.id)
        else:
            # Удаление занятия обратимо: его назначения сохраняются без изменений.
            # Удаление сценария отменяет только ещё не начатые задания с этим сценарием.
            assignments = (
                select(Assignment)
                .join(Session, Session.id == Assignment.session_id)
                .where(
                    Session.status == "draft",
                    Assignment.cancelled_at.is_(None),
                    Assignment.scenario_id == id,
                )
            )
            for assignment in await db.scalars(assignments.with_for_update(of=Assignment)):
                assignment.cancelled_at = now
                # Legacy Assignment не имеет cancelled; отмена видна в lifecycle.
                if assignment.batch_id is not None:
                    assignment.status = "cancelled"
    request.state.audit_after = {
        "deleted_at": row.deleted_at.isoformat() if row.deleted_at else None,
        "deleted_by": str(row.deleted_by) if row.deleted_by else None,
    }
    await db.flush()
    return DraftResult(id=id)


async def delete_session(request: Request, id: UUID) -> DraftResult:
    return await change(request, id, "session")


async def delete_scenario(request: Request, id: UUID) -> DraftResult:
    return await change(request, id, "scenario")


async def restore_session(request: Request, id: UUID) -> DraftResult:
    return await change(request, id, "session", restore=True)


async def restore_scenario(request: Request, id: UUID) -> DraftResult:
    return await change(request, id, "scenario", restore=True)


async def list_deleted(request: Request) -> list[DraftItem]:
    result = []
    models: list[tuple[type[Session] | type[Scenario], Literal["session", "scenario"]]] = [
        (Session, "session"),
        (Scenario, "scenario"),
    ]
    for model, kind in models:
        for row in await request.state.db.scalars(
            select(model).where(model.deleted_at.is_not(None)).order_by(model.deleted_at.desc())
        ):
            result.append(
                DraftItem(
                    id=row.id,
                    kind=kind,
                    title=row.title
                    if kind == "session"
                    else row.card.get("incident_class", "Сценарий"),
                    deleted_at=row.deleted_at,
                    deleted_by=row.deleted_by,
                )
            )
    return result


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "deleteDraftSession": (delete_session, DraftResult),
    "deleteDraftScenario": (delete_scenario, DraftResult),
    "restoreDraftSession": (restore_session, DraftResult),
    "restoreDraftScenario": (restore_scenario, DraftResult),
    "listDeletedDrafts": (list_deleted, list[DraftItem]),
}
