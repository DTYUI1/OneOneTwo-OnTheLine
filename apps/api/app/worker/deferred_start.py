"""Переживающий перезапуск запрос «Дождаться готовности» без часов занятия."""

from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.api.sessions import repo
from app.api.sessions.service import apply_start, serialize, validate_start
from app.core.ai_resource import SCHEDULING_LOCK, running_generations
from app.core.models import AuditLog, Job, Session, User


async def start_waiting(sessions: async_sessionmaker[AsyncSession]) -> int:
    async with sessions.begin() as db:
        if not await db.scalar(select(func.pg_try_advisory_xact_lock(SCHEDULING_LOCK))):
            return 0
        return await start_waiting_locked(db)


async def start_waiting_locked(db: AsyncSession) -> int:
    """Запустить готовые ожидания под уже взятой блокировкой планирования.

    Вызывается также перед claim: следующая pending генерация не должна
    перехватить ресурс у занятия, дождавшегося своего полного пакета.
    """
    if await running_generations(db):
        return 0
    ids = list(
        await db.scalars(
            select(Session.id)
            .where(
                Session.status == "draft",
                # JSON null тоже IS NOT NULL в PostgreSQL: выбираем только
                # реальные запросы, без N+1 чтений каждого обычного черновика.
                Session.start_request["job_ids"].is_not(None),
                Session.start_request["error"].astext.is_(None),
            )
            .order_by(Session.id)
        )
    )
    started = 0
    for session_id in ids:
        row = await repo.get_session(db, session_id, lock=True)
        if (
            row is None
            or row.status != "draft"
            or row.start_request is None
            or row.start_request.get("error")
        ):
            continue
        targets = [UUID(value) for value in row.start_request["job_ids"]]
        states = list(await db.scalars(select(Job.status).where(Job.id.in_(targets))))
        # Это ожидание общего ресурса, а не зависимость от содержимого чужого пакета.
        # Stop собственной подготовки отдельно снимает start_request в finish_stop.
        if len(states) != len(targets) or any(
            state not in {"done", "failed", "cancelled"} for state in states
        ):
            continue
        owner = await db.get(User, row.teacher_id)
        try:
            if owner is None or not owner.is_active or owner.role != "teacher":
                raise HTTPException(409, "Учётная запись преподавателя недоступна.")
            assignments = await validate_start(db, row)
        except HTTPException as exc:
            message = (
                exc.detail
                if isinstance(exc.detail, str)
                else exc.detail.get("message", "Проверьте занятие перед запуском.")
            )
            row.start_request = {**row.start_request, "error": message}
            continue
        before = serialize(row).model_dump(mode="json")
        result = await apply_start(db, row, assignments)
        db.add(
            AuditLog(
                actor_id=row.teacher_id,
                action="startSession",
                entity="session",
                entity_id=str(row.id),
                before=before,
                after=result.model_dump(mode="json"),
                ip=None,
            )
        )
        started += 1
    return started
