"""Жизненный цикл worker: scheduler + PostgreSQL jobs, без HTTP."""

import logging
import os
import socket
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from app.api.foundation.trash import purge_due
from app.core.config import ROOT, Settings
from app.core.db import Database
from app.core.models import Job, WorkerHeartbeat
from app.worker.jobs import JobHandlers
from app.worker.providers import (
    LocalFasterWhisperSTT,
    LocalLlamaCpp,
    MockLLM,
    NullEmbeddings,
    NullLLM,
    NullSTT,
    PrerenderedTTS,
)
from app.worker.providers.interfaces import LLMProvider, STTProvider
from app.worker.providers.judge import CommentJudge, LocalLlamaJudge, NullJudge
from app.worker.queue import ClaimedJob, JobQueue
from app.worker.scheduler import CardScheduler
from app.worker.training import TrainingScheduler

logger = logging.getLogger(__name__)
# Корзина C-07 проверяется реже выдачи карточек: копия появляется раз в сутки или по кнопке.
PURGE_INTERVAL_SECONDS = 30.0


class Worker:
    def __init__(self, config: Settings, *, worker_id: str | None = None) -> None:
        self.config = config
        self.worker_id = worker_id or f"{socket.gethostname()}:{os.getpid()}"
        self.database = Database(config.database_url)
        self.queue = JobQueue(
            self.database.sessions,
            self.worker_id,
            lease_seconds=config.worker_lease_seconds,
            max_attempts=config.worker_max_attempts,
            retry_base_seconds=config.worker_retry_base_seconds,
        )
        self.scheduler = CardScheduler(self.database.sessions, batch_size=config.worker_batch_size)
        self.training_scheduler = TrainingScheduler(self.database.sessions)
        self.next_purge = 0.0
        llm: LLMProvider
        judge: CommentJudge = NullJudge()
        if config.ai_provider == "local":
            judge = LocalLlamaJudge(
                base_url=config.llm_base_url,
                model=config.llm_model,
                prompt_path=ROOT / "apps/api/app/worker/prompts/comment_judge_system.md",
                schema_path=ROOT / "apps/api/app/worker/prompts/comment_judge.schema.json",
                timeout_seconds=config.judge_timeout_seconds,
                max_tokens=config.llm_max_tokens,
            )
            llm = LocalLlamaCpp(
                base_url=config.llm_base_url,
                model=config.llm_model,
                prompt_path=ROOT / "apps/api/app/worker/prompts/scenario_narrative_system.md",
                schema_path=ROOT / "contracts/scenario-narrative.schema.json",
                timeout_seconds=config.llm_timeout_seconds,
                temperature=config.llm_temperature,
                max_tokens=config.llm_max_tokens,
            )
        elif config.ai_provider == "mock":
            llm = MockLLM()
        else:
            llm = NullLLM()
        stt: STTProvider
        if config.stt_provider == "local":
            stt = LocalFasterWhisperSTT(
                base_url=config.stt_base_url, timeout_seconds=config.stt_timeout_seconds
            )
        else:
            stt = NullSTT()
        self.handlers = JobHandlers(
            llm=llm,
            embeddings=NullEmbeddings(),
            stt=stt,
            tts=PrerenderedTTS(ROOT / "data"),
            audio_dir=Path(config.audio_dir),
            judge=judge,
        )

    async def close(self) -> None:
        await self.database.close()

    async def heartbeat(self) -> None:
        now = datetime.now(UTC)
        statement = (
            insert(WorkerHeartbeat)
            .values(worker_id=self.worker_id, updated_at=now)
            .on_conflict_do_update(
                index_elements=[WorkerHeartbeat.worker_id], set_={"updated_at": now}
            )
        )
        async with self.database.sessions.begin() as db:
            await db.execute(statement)

    async def process(self, claimed: ClaimedJob) -> bool:
        try:
            async with self.database.sessions.begin() as db:
                row = await db.scalar(
                    select(Job)
                    .where(
                        Job.id == claimed.id,
                        Job.status == "running",
                        Job.locked_by == self.worker_id,
                    )
                    .with_for_update()
                )
                if row is None:
                    return False
                row.result = await self.handlers.run(db, row.kind, row.payload)
                row.status = "done"
                row.error = None
                row.locked_by = None
                row.locked_at = None
            logger.info("job_done", extra={"job_id": str(claimed.id), "kind": claimed.kind})
            return True
        except Exception:
            logger.exception("job_failed", extra={"job_id": str(claimed.id), "kind": claimed.kind})
            await self.queue.retry_or_fail(claimed.id, claimed.attempts)
            return False

    async def purge(self) -> int:
        """Обезличить учётки из корзины, уже попавшие в резервную копию (C-07)."""
        if time.monotonic() < self.next_purge:
            return 0
        self.next_purge = time.monotonic() + PURGE_INTERVAL_SECONDS
        try:
            async with self.database.sessions.begin() as db:
                purged = await purge_due(db)
        except Exception:
            # Сбой корзины не должен останавливать выдачу карточек; повтор — через интервал.
            logger.exception("trash_purge_failed")
            return 0
        if purged:
            logger.info("trash_purged", extra={"users": purged})
        return purged

    async def schedule(self) -> bool:
        """Heartbeat, выдача карточек и сведений бригад — без ожидания долгих заданий."""
        await self.heartbeat()
        cards = await self.scheduler.tick()
        messages = await self.training_scheduler.tick()
        await self.purge()
        return cards > 0 or messages > 0

    async def work(self) -> bool:
        """Одно задание очереди; ИИ-оценка может идти до минуты."""
        claimed = await self.queue.claim()
        if claimed is None:
            return False
        await self.process(claimed)
        return True

    async def tick(self) -> bool:
        scheduled = await self.schedule()
        worked = await self.work()
        return scheduled or worked

    async def job(self, job_id: UUID) -> Job | None:
        async with self.database.sessions() as db:
            return await db.get(Job, job_id)
