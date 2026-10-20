"""Отметки администратора не меняют статус, результат или повторные попытки задания."""

import hashlib
import json
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import HTTPException, Query, Request
from pydantic import Field
from sqlalchemy import and_, func, select

from app.api.foundation.schemas import ContractModel
from app.core.models import Job, JobErrorRead


class JobErrorView(ContractModel):
    id: UUID
    kind: str
    attempts: int
    last_attempt_at: datetime
    message: str
    version: str
    read_at: datetime | None
    read_by: UUID | None


class JobErrorsPage(ContractModel):
    items: list[JobErrorView]
    total: int
    unread: int


class ReadJobError(ContractModel):
    version: str = Field(pattern=r"^[a-f0-9]{64}$")


def matches():
    return and_(
        JobErrorRead.job_id == Job.id,
        JobErrorRead.attempts == Job.attempts,
        JobErrorRead.run_after == Job.run_after,
        JobErrorRead.error.is_not_distinct_from(Job.error),
    )


def unread_condition():
    return ~select(JobErrorRead.job_id).where(matches()).correlate(Job).exists()


def version(job: Job) -> str:
    value = [str(job.id), job.attempts, job.run_after.astimezone(UTC).isoformat(), job.error]
    return hashlib.sha256(json.dumps(value, ensure_ascii=False).encode()).hexdigest()


def view(job: Job, receipt: JobErrorRead | None) -> JobErrorView:
    return JobErrorView(
        id=job.id,
        kind=job.kind,
        attempts=job.attempts,
        last_attempt_at=job.run_after,
        message=job.error or "Причина ошибки не сохранена.",
        version=version(job),
        read_at=receipt.read_at if receipt else None,
        read_by=receipt.read_by if receipt else None,
    )


async def list_job_errors(
    request: Request,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    state: Literal["all", "unread", "read"] = "all",
) -> JobErrorsPage:
    db = request.state.db
    condition = Job.status == "failed"
    unread = int(
        await db.scalar(select(func.count()).select_from(Job).where(condition, unread_condition()))
        or 0
    )
    if state == "unread":
        condition = and_(condition, unread_condition())
    elif state == "read":
        condition = and_(condition, ~unread_condition())
    total = int(await db.scalar(select(func.count()).select_from(Job).where(condition)) or 0)
    rows = (
        await db.execute(
            select(Job, JobErrorRead)
            .outerjoin(JobErrorRead, matches())
            .where(condition)
            .order_by(Job.run_after.desc(), Job.id.desc())
            .offset(offset)
            .limit(limit)
        )
    ).all()
    return JobErrorsPage(
        items=[view(job, receipt) for job, receipt in rows], total=total, unread=unread
    )


async def read_job_error(request: Request, id: UUID, body: ReadJobError) -> JobErrorView:
    db = request.state.db
    job = await db.scalar(select(Job).where(Job.id == id).with_for_update())
    if job is None:
        raise HTTPException(404, "Задание не найдено.")
    if job.status != "failed" or version(job) != body.version:
        raise HTTPException(
            409, "Состояние задания изменилось. Обновите журнал и прочитайте новое сообщение."
        )
    receipt = await db.get(JobErrorRead, id)
    if receipt is None:
        receipt = JobErrorRead(job_id=id)
        db.add(receipt)
    if receipt.read_at is None or (receipt.attempts, receipt.run_after, receipt.error) != (
        job.attempts,
        job.run_after,
        job.error,
    ):
        receipt.attempts = job.attempts
        receipt.run_after = job.run_after
        receipt.error = job.error
        receipt.read_at = datetime.now(UTC)
        receipt.read_by = request.state.user.id
    request.state.entity = "job_error_reads"
    request.state.entity_id = str(id)
    request.state.audit_after = {"read": True, "version": body.version}
    await db.flush()
    return view(job, receipt)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "listJobErrors": (list_job_errors, JobErrorsPage),
    "readJobError": (read_job_error, JobErrorView),
}
