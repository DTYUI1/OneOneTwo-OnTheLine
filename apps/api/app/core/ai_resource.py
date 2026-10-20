"""Общий локальный ИИ: короткая блокировка планирования и обезличенное состояние."""

from typing import Literal
from uuid import UUID

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import Job, Session

SCHEDULING_LOCK = 1120261016
EXECUTION_LOCK = 1120261017
GenerationState = Literal[
    "waiting", "queued", "generating", "ready", "failed", "stopping", "cancelled"
]


async def lock_scheduling(db: AsyncSession) -> None:
    """Одинаковый порядок для старта занятия и получения генерации worker'ом."""
    await db.execute(select(func.pg_advisory_xact_lock(SCHEDULING_LOCK)))


async def lessons_running(db: AsyncSession) -> bool:
    return (
        await db.scalar(
            select(Session.id)
            .where(
                Session.kind == "lesson",
                Session.status == "running",
            )
            .limit(1)
        )
        is not None
    )


async def running_generations(db: AsyncSession) -> list[UUID]:
    return list(
        await db.scalars(select(Job.id).where(Job.kind == "generate", Job.status == "running"))
    )


async def active_generations(db: AsyncSession) -> list[UUID]:
    """Генерации, о которых предупреждаем преподавателя: идущая порция или начатый пакет.

    Между порциями пакет на время возвращается в pending (в том числе на всю оценку
    обучаемого), но он не закончен. running_generations для этого не подходит: им
    очередь решает, можно ли получить следующую порцию.
    """
    return list(
        await db.scalars(
            select(Job.id).where(
                Job.kind == "generate",
                or_(
                    Job.status == "running",
                    and_(Job.status == "pending", Job.result["complete"].astext == "false"),
                ),
            )
        )
    )


async def generation_state(db: AsyncSession, job: Job, *, local_ai: bool) -> GenerationState:
    from app.worker.cancellation import requested

    if job.status == "cancelled":
        return "cancelled"
    if job.status in {"pending", "running"} and await requested(db, job.id):
        return "stopping"
    if job.status == "done":
        return "ready"
    if job.status == "failed":
        return "failed"
    if job.status == "running":
        return "generating"
    if (
        local_ai
        and job.payload.get("generation_policy", "after_lessons") != "now"
        and await lessons_running(db)
    ):
        return "waiting"
    return "queued"
