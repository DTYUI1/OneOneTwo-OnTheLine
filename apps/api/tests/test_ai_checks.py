"""Состояние ИИ-проверки оценки: идёт, ждёт очереди к модели (сколько впереди), не удалась."""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from app.api.evaluations.repo import ai_checks
from app.core.db import Database
from app.core.models import Job
from app.worker.queue import enqueue_job
from sqlalchemy import delete, update


def test_checks_follow_worker_queue_order(database_url):
    async def check():
        database = Database(database_url)
        running, first, second, failed, done = (uuid4() for _ in range(5))
        jobs = []
        # Оценки приходят по очереди: run_after — время постановки, как у enqueue_job.
        start = datetime.now(UTC) - timedelta(minutes=1)
        try:
            async with database.sessions.begin() as db:
                for index, (evaluation_id, status) in enumerate(
                    (
                        (running, "running"),
                        (first, "pending"),
                        (second, "pending"),
                        (failed, "failed"),
                        (done, "done"),
                    )
                ):
                    job = await enqueue_job(
                        db,
                        kind="evaluate",
                        payload={"evaluation_id": str(evaluation_id)},
                        entity_id=evaluation_id,
                    )
                    await db.execute(
                        update(Job)
                        .where(Job.id == job.id)
                        .values(status=status, run_after=start + timedelta(seconds=index))
                    )
                    jobs.append(job.id)
                # Порция генерации ждёт за проверками, как у worker: проверки — раньше.
                generation = await enqueue_job(db, kind="generate", payload={}, entity_id=uuid4())
                jobs.append(generation.id)
            async with database.sessions() as db:
                checks = await ai_checks(db, [running, first, second, failed, done])
            assert checks[running] == ("running", 0)
            assert checks[first][0] == checks[second][0] == "queued"
            # Впереди первой — хотя бы идущая проверка; вторая ждёт за первой.
            assert 1 <= checks[first][1] < checks[second][1]
            assert checks[failed] == ("failed", 0)
            assert done not in checks
        finally:
            async with database.sessions.begin() as db:
                await db.execute(delete(Job).where(Job.id.in_(jobs)))
            await database.close()

    asyncio.run(check())
