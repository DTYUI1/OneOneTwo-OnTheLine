import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from app.core.config import Settings
from app.core.db import Database
from app.core.models import (
    Assignment,
    Card,
    Job,
    Participant,
    Prediction,
    Scenario,
    Session,
    User,
)
from app.worker.queue import JobQueue, enqueue_job
from app.worker.runtime import Worker
from app.worker.scheduler import CardScheduler, make_prediction
from evalcore.defaults import CRITERIA
from sqlalchemy import func, select, update


def run(coro):
    return asyncio.run(coro)


def queue(database: Database, worker_id: str, *, lease: int = 5, attempts: int = 3):
    return JobQueue(
        database.sessions,
        worker_id,
        lease_seconds=lease,
        max_attempts=attempts,
        retry_base_seconds=1,
    )


async def clear_open_jobs(database: Database):
    async with database.sessions.begin() as db:
        await db.execute(
            update(Job)
            .where(Job.status.in_(["pending", "running"]))
            .values(status="failed", locked_by=None, locked_at=None)
        )


def test_queue_claim_is_exclusive_and_recovers_expired_lease(database_url):
    async def check():
        database = Database(database_url)
        try:
            await clear_open_jobs(database)
            ids = [uuid4(), uuid4()]
            async with database.sessions.begin() as db:
                for entity_id in ids:
                    await enqueue_job(
                        db,
                        kind="insights",
                        payload={"session_id": str(entity_id)},
                        entity_id=entity_id,
                    )
            first = await queue(database, "worker-a").claim()
            second = await queue(database, "worker-b").claim()
            assert first is not None and second is not None
            assert first.id != second.id

            async with database.sessions.begin() as db:
                row = await db.get(Job, first.id, with_for_update=True)
                row.locked_at = datetime.now(UTC) - timedelta(minutes=1)
            recovered = await queue(database, "worker-c").claim()
            assert recovered is not None
            assert recovered.id == first.id
            assert recovered.attempts == 2
        finally:
            await database.close()

    run(check())


def test_queue_idempotency_and_bounded_retries(database_url):
    async def check():
        database = Database(database_url)
        try:
            await clear_open_jobs(database)
            entity_id = uuid4()
            async with database.sessions.begin() as db:
                first = await enqueue_job(
                    db,
                    kind="insights",
                    payload={"session_id": str(entity_id)},
                    entity_id=entity_id,
                    version=7,
                )
                second = await enqueue_job(
                    db,
                    kind="insights",
                    payload={"session_id": str(entity_id)},
                    entity_id=entity_id,
                    version=7,
                )
                assert first.id == second.id
            jobs = queue(database, "worker-retry", attempts=1)
            claimed = await jobs.claim()
            assert claimed is not None
            await jobs.retry_or_fail(claimed.id, claimed.attempts)
            async with database.sessions() as db:
                row = await db.get(Job, claimed.id)
                assert row.status == "failed"
                assert row.locked_by is None and row.locked_at is None
        finally:
            await database.close()

    run(check())


def test_scheduler_writes_prediction_before_card_notification(database_url):
    async def check():
        database = Database(database_url)
        try:
            async with database.sessions.begin() as db:
                teacher = await db.scalar(select(User).where(User.login == "teacher"))
                trainee = await db.scalar(select(User).where(User.login == "trainee01"))
                scenarios = list(
                    (
                        await db.scalars(
                            select(Scenario).where(Scenario.status == "approved").limit(2)
                        )
                    ).all()
                )
                lesson = Session(
                    id=uuid4(),
                    teacher_id=teacher.id,
                    title="Worker scheduler",
                    status="running",
                    started_at=datetime.now(UTC),
                    finished_at=None,
                    settings_snapshot={
                        "reaction_normative_s": 30,
                        "handling_normative_s": 180,
                        "critical_cap": 0.5,
                        "weights": dict.fromkeys(CRITERIA, 1.0),
                        "parallel_cards": 2,
                        "hints_level": 0,
                    },
                )
                db.add(lesson)
                await db.flush()
                participant = Participant(
                    id=uuid4(),
                    session_id=lesson.id,
                    user_id=trainee.id,
                    workstation_id=1,
                    dds_service_id="102",
                    level=2,
                    rating_at_start=0.0,
                )
                db.add(participant)
                await db.flush()
                now = datetime.now(UTC) - timedelta(seconds=1)
                for order, scenario in enumerate(scenarios, 1):
                    db.add(
                        Assignment(
                            id=uuid4(),
                            session_id=lesson.id,
                            participant_id=participant.id,
                            scenario_id=scenario.id,
                            order=order,
                            planned_at=now,
                            status="pending",
                        )
                    )
            scheduler = CardScheduler(database.sessions)
            assert await scheduler.tick() == 2
            assert await scheduler.tick() == 0
            async with database.sessions() as db:
                cards = list(
                    (
                        await db.scalars(
                            select(Card).join(Assignment).where(Assignment.session_id == lesson.id)
                        )
                    ).all()
                )
                assert len(cards) == 2
                assert all(card.state == "added" for card in cards)
                assert all(card.delivered_at is None for card in cards)
                forecasts = list(
                    (
                        await db.scalars(
                            select(Prediction).where(
                                Prediction.card_id.in_([card.id for card in cards])
                            )
                        )
                    ).all()
                )
                assert len(forecasts) == 2
                appeared = {card.id: card.appeared_at for card in cards}
                assert all(item.made_at <= appeared[item.card_id] for item in forecasts)
        finally:
            await database.close()

    run(check())


def test_legacy_prediction_fallback_uses_passed_snapshot():
    # При theta=b=-2 вероятности равны 0.5, ожидаемое время равно нормативу.
    participant = Participant(rating_at_start=-2)
    scenario = Scenario(
        id=uuid4(),
        version=1,
        level=1,
        weight=1,
        incident_type_code="2020000",
        target_service_id="102",
        card={},
        reference={},
        complications=[],
    )
    snapshot = {"handling_normative_s": 100}
    first = make_prediction(participant, scenario, snapshot)
    snapshot["handling_normative_s"] = 180
    second = make_prediction(participant, scenario, snapshot)
    assert first == {
        "p_success": 0.5,
        "expected_score": 0.5,
        "expected_time_s": 100,
        "p_timeout": 0.5,
        "model_version": "worker-irt-fallback-v1",
        "b_scenario": -2,
    }
    assert second == {**first, "expected_time_s": 180}
    assert make_prediction(participant, scenario, {}) == second


def test_generate_handler_finishes_job_idempotently(database_url, tmp_path):
    async def check():
        config = Settings(
            _env_file=None,
            database_url=database_url,
            audio_dir=tmp_path,
            ai_provider="off",
        )
        worker = Worker(config, worker_id="worker-generate")
        try:
            await clear_open_jobs(worker.database)
            pack_id = uuid4()
            async with worker.database.sessions.begin() as db:
                job = await enqueue_job(
                    db,
                    kind="generate",
                    payload={
                        "pack_id": str(pack_id),
                        "count": 2,
                        "level": 1,
                        "service_id": "102",
                        "seed": 42,
                    },
                    entity_id=pack_id,
                )
                job_id = job.id
            claimed = await worker.queue.claim()
            assert claimed is not None and claimed.id == job_id
            assert await worker.process(claimed)
            async with worker.database.sessions() as db:
                row = await db.get(Job, job_id)
                assert row.status == "done"
                scenario_ids = [UUID(value) for value in row.result["scenario_ids"]]
                assert len(scenario_ids) == 2
                assert (
                    await db.scalar(
                        select(func.count())
                        .select_from(Scenario)
                        .where(Scenario.id.in_(scenario_ids))
                    )
                    == 2
                )
                generated = list(
                    (await db.scalars(select(Scenario).where(Scenario.id.in_(scenario_ids)))).all()
                )
                assert all("MVP-STUB" in item.teacher_comment for item in generated)
        finally:
            await worker.close()

    run(check())
