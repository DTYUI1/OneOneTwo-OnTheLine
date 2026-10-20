"""PostgreSQL-очередь с короткой арендой и атомарным получением задания."""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import and_, case, func, or_, select, true, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.ai_resource import lessons_running, lock_scheduling, running_generations
from app.core.models import Job, JobCancellation


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
        local_ai: bool = False,
    ) -> None:
        self.sessions = sessions
        self.worker_id = worker_id
        self.lease = timedelta(seconds=lease_seconds)
        self.max_attempts = max_attempts
        self.retry_base_seconds = retry_base_seconds
        self.local_ai = local_ai

    async def claim(self) -> ClaimedJob | None:
        async with self.sessions.begin() as db:
            if self.local_ai:
                await lock_scheduling(db)
            # Часы — базы: run_after по умолчанию ставит она же (now()). Сравнение с
            # часами процесса ломается, когда они расходятся с часами БД, например
            # тесты на хосте против базы в VM colima (~0,1 с).
            now = (await db.execute(select(func.now()))).scalar_one()
            expired = now - self.lease
            exhausted = (
                select(Job.id)
                .where(
                    Job.status == "running",
                    or_(Job.locked_at.is_(None), Job.locked_at <= expired),
                    Job.attempts >= self.max_attempts,
                    Job.id.not_in(select(JobCancellation.job_id)),
                )
                .with_for_update(skip_locked=True)
            )
            # Длинный живой handler удерживает строку до commit. Даже на последней
            # попытке нельзя ни повторить его, ни ждать блокировку и тормозить очередь.
            await db.execute(
                update(Job)
                .where(Job.id.in_(exhausted))
                .values(
                    status="failed",
                    locked_by=None,
                    locked_at=None,
                    error="Задание превысило допустимое число попыток.",
                )
            )
            if self.local_ai:
                from app.worker.deferred_start import start_waiting_locked

                # После полного пакета запускаем сохранённое ожидание раньше
                # следующей pending генерации, даже если scheduler ещё не тикнул.
                await start_waiting_locked(db)
            cancelled = Job.id.in_(select(JobCancellation.job_id))
            eligible = []
            if self.local_ai and await running_generations(db):
                # Не получаем второй pending generate заранее: иначе другой worker
                # мог бы занять освободившийся слот раньше готового отложенного старта.
                # Просроченный running по-прежнему доступен для восстановления аренды.
                eligible.append(or_(Job.kind != "generate", Job.status == "running"))
            if self.local_ai and await lessons_running(db):
                eligible.append(
                    or_(Job.kind != "generate", Job.payload["generation_policy"].astext == "now")
                )
            row = await db.scalar(
                select(Job)
                .where(
                    or_(cancelled, and_(*eligible)) if eligible else true(),
                    or_(cancelled, Job.attempts < self.max_attempts),
                    or_(
                        and_(Job.status == "pending", or_(cancelled, Job.run_after <= now)),
                        and_(
                            Job.status == "running",
                            or_(Job.locked_at.is_(None), Job.locked_at <= expired),
                        ),
                    ),
                )
                # Сохраняем порядок прочих jobs (включая транскрипцию), но вся
                # готовая оценка имеет преимущество перед следующей порцией генерации.
                .order_by(
                    case((cancelled, -1), (Job.kind == "generate", 1), else_=0),
                    Job.run_after,
                    Job.id,
                )
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

    async def may_execute(self, claimed: ClaimedJob) -> bool:
        """Повторная проверка после claim, до долгого запроса и без длинного lock.

        Новое занятие могло появиться до этого worker'а. Возврат в ожидание
        снимает расход попытки; ожидание не ошибка обработки.
        """
        from app.worker.cancellation import requested

        async with self.sessions() as db:
            if await requested(db, claimed.id):
                return True
        if (
            not self.local_ai
            or claimed.kind != "generate"
            or claimed.payload.get("generation_policy") == "now"
        ):
            return True
        async with self.sessions.begin() as db:
            await lock_scheduling(db)
            if not await lessons_running(db):
                return True
            await db.execute(
                update(Job)
                .where(
                    Job.id == claimed.id,
                    Job.status == "running",
                    Job.locked_by == self.worker_id,
                )
                .values(
                    status="pending",
                    locked_by=None,
                    locked_at=None,
                    attempts=func.greatest(Job.attempts - 1, 0),
                    error=None,
                )
            )
            return False

    async def retry_or_fail(
        self, job_id: UUID, attempts: int, *, reason: str | None = None, retryable: bool = True
    ) -> None:
        terminal = not retryable or attempts >= self.max_attempts
        delay = self.retry_base_seconds * (2 ** max(0, attempts - 1))
        async with self.sessions.begin() as db:
            from app.worker.cancellation import (
                finish_stop,
                lock_stop,
                lock_stop_resources,
                requested,
            )

            row = await db.scalar(
                select(Job)
                .where(Job.id == job_id, Job.status == "running", Job.locked_by == self.worker_id)
                .with_for_update()
            )
            if row is None:
                return
            await lock_stop_resources(db, row)
            await lock_stop(db, job_id)
            if await requested(db, job_id):
                await finish_stop(db, row)
                return
            row.status = "failed" if terminal else "pending"
            row.run_after = datetime.now(UTC) + timedelta(seconds=delay)
            row.locked_by = row.locked_at = None
            row.error = reason or (
                "Задание завершилось ошибкой после допустимого числа попыток."
                if terminal
                else "Ошибка обработки; назначена повторная попытка."
            )
