"""Порции: commit N/M, восстановление, общий слот и оценка между сценариями."""

import asyncio
import copy
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.core.models import Job, Scenario, ScenarioPack, ScenarioPackItem, Session, Setting, User
from app.worker.queue import enqueue_job
from app.worker.runtime import Worker
from fastapi.testclient import TestClient
from sqlalchemy import func, select, update

from .test_lifecycle import login
from .test_scenario_generation import ScriptedLLM
from .test_worker import clear_open_jobs

pytestmark = pytest.mark.usefixtures("clean_generated_content")


async def pack_job(worker, count):
    await clear_open_jobs(worker.database)
    async with worker.database.sessions.begin() as db:
        teacher = await db.scalar(select(User).where(User.login == "teacher"))
        pack = ScenarioPack(
            id=uuid4(), title="Порции", status="draft", origin="template", created_by=teacher.id
        )
        db.add(pack)
        await db.flush()
        job = await enqueue_job(
            db,
            kind="generate",
            entity_id=pack.id,
            payload={
                "pack_id": str(pack.id),
                "count": count,
                "service_id": "GKH",
                "level": 1,
                "seed": 0,
                "generation_policy": "now",
            },
        )
        return job.id, pack.id


def test_progress_is_committed_and_restart_resumes_missing_scenarios(database_config):
    async def check():
        config = database_config.model_copy(update={"ai_provider": "local"})
        worker = Worker(config, worker_id="before-restart")
        worker.handlers.llm = ScriptedLLM()
        job_id, pack_id = await pack_job(worker, 3)
        try:
            claimed = await worker.queue.claim()
            assert await worker.process(claimed)
            # Новое соединение видит первый сценарий до готовности всего пакета.
            async with worker.database.sessions() as db:
                job = await db.get(Job, job_id)
                assert job.status == "pending" and not job.result["complete"]
                assert len(job.result["scenario_ids"]) == 1 and job.attempts == 0
                first_id = UUID(job.result["scenario_ids"][0])
                first_metadata = copy.deepcopy(
                    (await db.get(Scenario, first_id)).generation_metadata
                )
                assert (await db.get(ScenarioPack, pack_id)).status == "draft"
            await worker.close()
            worker = Worker(config, worker_id="after-restart")
            worker.handlers.llm = ScriptedLLM()
            # Сбой после следующего claim, но до исполнения: аренда восстанавливается.
            claimed = await worker.queue.claim()
            assert claimed.id == job_id and claimed.attempts == 1
            async with worker.database.sessions.begin() as db:
                await db.execute(
                    update(Job)
                    .where(Job.id == job_id)
                    .values(
                        locked_at=datetime.now(UTC) - timedelta(hours=1),
                    )
                )
            await worker.close()
            worker = Worker(config, worker_id="lease-recovery")
            worker.handlers.llm = ScriptedLLM()
            recovered = await worker.queue.claim()
            assert recovered.id == job_id and recovered.attempts == 2
            assert await worker.process(recovered)
            async with worker.database.sessions() as db:
                assert len((await db.get(Job, job_id)).result["scenario_ids"]) == 2
            assert await worker.work()
            async with worker.database.sessions.begin() as db:
                job = await db.get(Job, job_id)
                assert job.status == "done" and job.result["complete"]
                assert len(job.result["scenario_ids"]) == 3
                assert job.result["scenario_ids"][0] == str(first_id)
                assert (await db.get(Scenario, first_id)).generation_metadata == first_metadata
                assert (
                    await db.scalar(
                        select(func.count())
                        .select_from(ScenarioPackItem)
                        .where(ScenarioPackItem.pack_id == pack_id)
                    )
                    == 3
                )
                calls = worker.handlers.llm.calls
                replay = await worker.handlers.handle_generate(db, job.payload)
                assert replay == job.result and worker.handlers.llm.calls == calls
        finally:
            await worker.close()

    asyncio.run(check())


def test_successful_portions_do_not_exhaust_attempts(database_config):
    async def check():
        config = database_config.model_copy(
            update={"ai_provider": "local", "worker_max_attempts": 1}
        )
        worker = Worker(config)
        worker.handlers.llm = ScriptedLLM()
        try:
            job_id, _ = await pack_job(worker, 6)
            for completed in range(1, 7):
                claim = await worker.queue.claim()
                assert claim.id == job_id and claim.attempts == 1
                assert await worker.process(claim)
                async with worker.database.sessions() as db:
                    row = await db.get(Job, job_id)
                    assert len(row.result["scenario_ids"]) == completed
                    assert row.status == ("done" if completed == 6 else "pending")
                    assert row.attempts == (1 if completed == 6 else 0)
        finally:
            await worker.close()

    asyncio.run(check())


def test_two_workers_share_model_and_evaluation_runs_between_portions(database_config):
    async def check():
        config = database_config.model_copy(update={"ai_provider": "local"})
        generator, judge = Worker(config, worker_id="generator"), Worker(config, worker_id="judge")
        entered, release = asyncio.Event(), asyncio.Event()
        order = []

        async def generate(db, kind, payload):
            order.append("generate")
            entered.set()
            await release.wait()
            return {"scenario_ids": [], "complete": False}

        async def evaluate(db, kind, payload):
            order.append("evaluate")
            return {"checked": True}

        generator.handlers.run, judge.handlers.run = generate, evaluate
        try:
            job_id, _ = await pack_job(generator, 2)
            claimed = await generator.queue.claim()
            process = asyncio.create_task(generator.process(claimed))
            await entered.wait()
            async with judge.database.sessions.begin() as db:
                evaluation = await enqueue_job(
                    db,
                    kind="evaluate",
                    payload={"card_id": str(uuid4()), "evaluation_id": str(uuid4())},
                    entity_id=uuid4(),
                )
                evaluation_id = evaluation.id
            claim = await judge.queue.claim()
            assert claim.id == evaluation_id
            # Другой worker не начинает второй HTTP-запрос к тому же локальному ИИ.
            assert not await asyncio.wait_for(judge.process(claim), timeout=2)
            async with judge.database.sessions() as db:
                assert (await db.get(Job, evaluation_id)).attempts == 0
            # Heartbeat и scheduler не ждут блокировку ресурса и длинный handler.
            await asyncio.wait_for(generator.schedule(), timeout=2)
            release.set()
            assert await process
            claim = await judge.queue.claim()
            assert claim.id == evaluation_id  # generation старше, но оценка раньше
            # Оценка уже получена вторым worker, но ещё не захватила слот.
            # Генерация, успевшая получить следующую порцию, уступает и в этой гонке.
            early_generation = await generator.queue.claim()
            assert early_generation.id == job_id
            assert not await generator.process(early_generation)
            assert await judge.process(claim)
            claim = await generator.queue.claim()
            assert claim.id == job_id
            assert await generator.process(claim)
            assert order == ["generate", "evaluate", "generate"]
        finally:
            release.set()
            await generator.close()
            await judge.close()

    asyncio.run(check())


def test_partial_ai_preparation_does_not_assign_or_start(database_config):
    config = database_config.model_copy(update={"ai_provider": "local"})
    with TestClient(create_database_app(config)) as client:
        headers = login(client)
        trainee = next(u for u in client.get("/api/users").json() if u["login"] == "trainee03")
        created = client.post(
            "/api/sessions",
            headers=headers,
            json={
                "title": "Проверка частичной подготовки",
                "settings_snapshot": client.get("/api/settings").json(),
                "participants": [
                    {
                        "user_id": trainee["id"],
                        "workstation_number": 3,
                        "dds_service_id": "GKH",
                        "level": 1,
                    }
                ],
                "ai_selection": {
                    "request_id": str(uuid4()),
                    "cards_per_participant": 2,
                    "generation_policy": "now",
                },
            },
        )
        assert created.status_code == 201, created.text
        lesson_id = created.json()["id"]
        job_id = UUID(created.json()["ai_preparation"]["job_id"])

        async def portion():
            worker = Worker(config)
            worker.handlers.llm = ScriptedLLM()
            try:
                async with worker.database.sessions.begin() as db:
                    await db.execute(
                        update(Job)
                        .where(Job.id != job_id, Job.status.in_(["pending", "running"]))
                        .values(status="failed", locked_at=None, locked_by=None)
                    )
                claim = await worker.queue.claim()
                assert claim.id == job_id
                assert await worker.process(claim)
            finally:
                await worker.close()

        asyncio.run(portion())
        partial = client.get(f"/api/sessions/{lesson_id}").json()
        assert (
            partial["ai_preparation"]["completed"] == 1 and partial["ai_preparation"]["total"] == 2
        )
        assert partial["ai_preparation"]["state"] != "ready"
        assert partial["started_at"] is None and partial["status"] == "draft"
        assert client.get(f"/api/sessions/{lesson_id}/assignment-batches").json() == []
        assert client.post(f"/api/sessions/{lesson_id}/start", headers=headers).status_code == 409
        asyncio.run(portion())  # новый Worker продолжает оставшееся после commit
        ready = client.get(f"/api/sessions/{lesson_id}").json()
        assert (
            ready["ai_preparation"]["state"] == "ready"
            and ready["ai_preparation"]["completed"] == 2
        )
        batches = client.get(f"/api/sessions/{lesson_id}/assignment-batches").json()
        assert len(batches) == 1 and len(batches[0]["assignments"]) == 2
        assert all(a["due_at"] is None for a in batches[0]["assignments"])


def test_new_lesson_defers_remaining_portions_without_losing_progress(database_config):
    async def check():
        worker = Worker(database_config.model_copy(update={"ai_provider": "local"}))
        worker.handlers.llm = ScriptedLLM()
        try:
            job_id, pack_id = await pack_job(worker, 2)
            async with worker.database.sessions.begin() as db:
                row = await db.get(Job, job_id)
                row.payload = {**row.payload, "generation_policy": "after_lessons"}
            assert await worker.work()
            async with worker.database.sessions.begin() as db:
                row = await db.get(Job, job_id)
                first = row.result["scenario_ids"]
                assert len(first) == 1 and row.attempts == 0
                pack = await db.get(ScenarioPack, pack_id)
                lesson = Session(
                    teacher_id=pack.created_by,
                    title="Новое занятие между порциями",
                    kind="lesson",
                    status="running",
                    settings_snapshot=await db.scalar(
                        select(Setting.value).where(Setting.key == "training")
                    ),
                )
                db.add(lesson)
                await db.flush()
                lesson_id = lesson.id
            assert await worker.queue.claim() is None
            async with worker.database.sessions.begin() as db:
                row = await db.get(Job, job_id)
                assert row.result["scenario_ids"] == first and row.attempts == 0
                (await db.get(Session, lesson_id)).status = "finished"
            assert await worker.work()
            async with worker.database.sessions() as db:
                row = await db.get(Job, job_id)
                assert row.status == "done" and len(row.result["scenario_ids"]) == 2
                assert row.result["scenario_ids"][:1] == first
        finally:
            await worker.close()

    asyncio.run(check())
