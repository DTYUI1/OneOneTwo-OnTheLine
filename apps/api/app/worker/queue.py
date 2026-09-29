"""PostgreSQL-очередь с короткой арендой и атомарным получением задания."""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.models import Job


@dataclass(frozen=True)
class ClaimedJob:
    id: UUID
    kind: str
    payload: dict[str, Any]
    attempts: int


def job_key(kind: str, entity_id: str | UUID, version: str | int) -> str:
    """Единый ключ контракта `(kind, entity_id, version)`."""
    return f"{kind}:{entity_id}:{version}"


async def enqueue_job(
    db: AsyncSession,
    *,
    kind: str,
    payload: dict[str, Any],
    entity_id: str | UUID,
    version: str | int = 1,
) -> Job:
    """Идемпотентно создать job, не откатывая внешнюю транзакцию при гонке."""
    key = job_key(kind, entity_id, version)
    job_id = uuid4()
    statement = (
        insert(Job)
        .values(
            id=job_id,
            kind=kind,
            payload=payload,
            status="pending",
            attempts=0,
            locked_by=None,
            locked_at=None,
            idempotency_key=key,
            result=None,
            error=None,
        )
        .on_conflict_do_nothing(index_elements=[Job.idempotency_key])
        .returning(Job.id)
    )
    inserted = await db.scalar(statement)
    row = await db.get(Job, inserted or job_id) if inserted is not None else None
    if row is None:
        row = await db.scalar(select(Job).where(Job.idempotency_key == key))
    if row is None:  # pragma: no cover - защищает от нарушения изоляции/схемы
        raise RuntimeError("Не удалось создать или прочитать задание.")
    return row


class JobQueue:
    def __init__(
        self,
        sessions: async_sessionmaker[AsyncSession],
        worker_id: str,
        *,
        lease_seconds: int,
        max_attempts: int,
        retry_base_seconds: int,
    ) -> None:
        self.sessions = sessions
        self.worker_id = worker_id
        self.lease = timedelta(seconds=lease_seconds)
        self.max_attempts = max_attempts
        self.retry_base_seconds = retry_base_seconds

    async def claim(self) -> ClaimedJob | None:
        async with self.sessions.begin() as db:
            # Часы — базы: run_after по умолчанию ставит она же (now()). Сравнение с
            # часами процесса ломается, когда они расходятся с часами БД, например
            # тесты на хосте против базы в VM colima (~0,1 с).
            now = (await db.execute(select(func.now()))).scalar_one()
            expired = now - self.lease
            await db.execute(
                update(Job)
                .where(
                    Job.status == "running",
                    or_(Job.locked_at.is_(None), Job.locked_at <= expired),
                    Job.attempts >= self.max_attempts,
                )
                .values(
                    status="failed",
                    locked_by=None,
                    locked_at=None,
                    error="Задание превысило допустимое число попыток.",
                )
            )
            row = await db.scalar(
                select(Job)
                .where(
                    Job.attempts < self.max_attempts,
                    or_(
                        and_(Job.status == "pending", Job.run_after <= now),
                        and_(
                            Job.status == "running",
                            or_(Job.locked_at.is_(None), Job.locked_at <= expired),
                        ),
                    ),
                )
                .order_by(Job.run_after, Job.id)
                .with_for_update(skip_locked=True)
                .limit(1)
            )
            if row is None:
                return None
            row.status = "running"
            row.attempts += 1
            row.locked_by = self.worker_id
            row.locked_at = now
            row.error = None
            await db.flush()
            return ClaimedJob(row.id, row.kind, row.payload, row.attempts)

    async def retry_or_fail(self, job_id: UUID, attempts: int) -> None:
        terminal = attempts >= self.max_attempts
        delay = self.retry_base_seconds * (2 ** max(0, attempts - 1))
        async with self.sessions.begin() as db:
            await db.execute(
                update(Job)
                .where(
                    Job.id == job_id,
                    Job.status == "running",
                    Job.locked_by == self.worker_id,
                )
                .values(
                    status="failed" if terminal else "pending",
                    run_after=datetime.now(UTC) + timedelta(seconds=delay),
                    locked_by=None,
                    locked_at=None,
                    error=(
                        "Задание завершилось ошибкой после допустимого числа попыток."
                        if terminal
                        else "Ошибка обработки; назначена повторная попытка."
                    ),
                )
            )
