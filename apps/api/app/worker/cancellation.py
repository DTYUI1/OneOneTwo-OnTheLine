"""Остановка между порциями; запрос не блокируется на строке исполняемого job."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import (
    Assignment,
    Job,
    JobCancellation,
    Scenario,
    ScenarioPack,
    ScenarioPackItem,
    Session,
)


async def requested(db: AsyncSession, job_id: UUID) -> bool:
    return await db.get(JobCancellation, job_id) is not None


async def lock_stop(db: AsyncSession, job_id: UUID) -> None:
    """Короткий общий lock: запись запроса stop и фиксация результата порции."""
    await db.execute(
        select(func.pg_advisory_xact_lock(func.hashtextextended(f"stop-generation:{job_id}", 0)))
    )


async def request_stop(db: AsyncSession, job_id: UUID, user_id: UUID) -> bool:
    await lock_stop(db, job_id)
    status = await db.scalar(select(Job.status).where(Job.id == job_id))
    if status not in {"pending", "running", "cancelled"}:
        return False
    await db.execute(
        insert(JobCancellation).values(job_id=job_id, requested_by=user_id).on_conflict_do_nothing()
    )
    return True


async def lock_stop_resources(db: AsyncSession, job: Job) -> None:
    """Worker: Job → Pack → Session → stop lock. Delete: Session → stop lock."""
    if job.kind != "generate" or not job.payload.get("pack_id"):
        return
    await db.get(ScenarioPack, UUID(job.payload["pack_id"]), with_for_update=True)
    if job.payload.get("session_id"):
        await db.get(Session, UUID(job.payload["session_id"]), with_for_update=True)


async def finish_stop(db: AsyncSession, job: Job) -> None:
    """Вызывается с блокировкой Job; сохраняет готовое и исключает отложенный старт."""
    pack_id = UUID(job.payload["pack_id"])
    await db.get(ScenarioPack, pack_id, with_for_update=True)
    scenarios = list(
        await db.scalars(
            select(Scenario)
            .join(ScenarioPackItem, ScenarioPackItem.scenario_id == Scenario.id)
            .where(ScenarioPackItem.pack_id == pack_id)
        )
    )
    # Stop завершает задание очереди, а не отменяет решения преподавателя о контенте.
    # Уже сохранённые версии сценариев и состояние пакета остаются неизменными.
    if job.payload.get("session_id"):
        lesson = await db.get(Session, UUID(job.payload["session_id"]), with_for_update=True)
        if (
            lesson
            and lesson.status == "draft"
            and lesson.ai_preparation is not None
            and UUID(lesson.ai_preparation["job_id"]) == job.id
            and lesson.ai_preparation["state"] != "cancelled"
        ):
            lesson.start_request = None
            lesson.ai_preparation = {
                **lesson.ai_preparation,
                "state": "cancelled",
                "completed": len(scenarios),
            }
            # Stop не владеет ручными назначениями и не должен повторно отменить
            # раздачу, которую преподаватель добавил после завершённой остановки.
            for assignment in await db.scalars(
                select(Assignment)
                .where(
                    Assignment.session_id == lesson.id,
                    Assignment.scenario_id.in_([scenario.id for scenario in scenarios]),
                    Assignment.cancelled_at.is_(None),
                )
                .order_by(Assignment.id)
                .with_for_update()
            ):
                assignment.cancelled_at = datetime.now(UTC)
                # Legacy Assignment не имеет cancelled; отмена видна в lifecycle.
                if assignment.batch_id is not None:
                    assignment.status = "cancelled"
    job.status = "cancelled"
    job.locked_by = job.locked_at = None
    job.error = None
    job.result = {
        "scenario_ids": [str(s.id) for s in scenarios],
        "complete": False,
        "cancelled": True,
    }
