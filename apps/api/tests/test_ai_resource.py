"""Общий ИИ: серверная отсрочка, все преподаватели, гонки и восстановление."""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.core.contracts import validate_json
from app.core.models import Job, Session, User
from app.worker.queue import enqueue_job
from app.worker.runtime import Worker
from evalcore.defaults import CRITERIA
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from .test_lifecycle import login, run_db
from .test_worker import clear_open_jobs

pytestmark = pytest.mark.usefixtures("clean_generated_content")


@pytest.fixture
def local_config(database_config):
    # Только случайная тестовая БД conftest; состояния других тестов не должны
    # подменять проверяемую конкуренцию с конкретными занятиями и jobs.
    async def idle(db):
        await db.execute(
            update(Session).where(Session.status == "running").values(status="finished")
        )
        await db.execute(
            update(Job)
            .where(Job.status.in_(["pending", "running"]))
            .values(
                status="failed",
                locked_by=None,
                locked_at=None,
            )
        )

    run_db(database_config.database_url, idle)
    return database_config.model_copy(update={"ai_provider": "local"})


def ready_lesson(client, headers):
    trainee = next(row for row in client.get("/api/users").json() if row["login"] == "trainee01")
    scenario = next(
        row for row in client.get("/api/scenarios").json() if row["status"] == "approved"
    )
    created = client.post(
        "/api/sessions",
        headers=headers,
        json={
            "title": "Проверка общей модели",
            "settings_snapshot": client.get("/api/settings").json(),
            "participants": [
                {
                    "user_id": trainee["id"],
                    "workstation_number": 1,
                    "dds_service_id": scenario["target_service_id"],
                    "level": 1,
                }
            ],
        },
    )
    assert created.status_code == 201, created.text
    lesson_id = created.json()["id"]
    assigned = client.post(
        f"/api/sessions/{lesson_id}/assignments",
        headers=headers,
        json={
            "participant_id": trainee["id"],
            "scenario_id": scenario["id"],
            "order": 1,
            "planned_at": (datetime.now(UTC) + timedelta(minutes=5)).isoformat(),
        },
    )
    assert assigned.status_code == 201, assigned.text
    return lesson_id


def test_generation_request_replay_persists_waiting_and_is_private(local_config, database_url):
    with TestClient(create_database_app(local_config)) as client:
        headers = login(client)
        lesson_id = ready_lesson(client, headers)
        assert client.post(f"/api/sessions/{lesson_id}/start", headers=headers).status_code == 200
        assert client.get("/api/ai/resource").json() == {
            "local_ai": True,
            "lesson_running": True,
            "generation_running": False,
        }
        body = {
            "count": 2,
            "level": 1,
            "service_id": "GKH",
            "seed": 77,
            "generation_policy": "after_lessons",
            "generation_request_id": str(uuid4()),
        }
        first = client.post("/api/packs/generate", headers=headers, json=body)
        assert first.status_code == 202, first.text
        job_id = first.json()["id"]
        # Двойной клик и повтор того же тела имеют один пакет и один job.
        assert client.post("/api/packs/generate", headers=headers, json=body).json()["id"] == job_id
        assert (
            client.post(
                "/api/packs/generate", headers=headers, json={**body, "count": 3}
            ).status_code
            == 409
        )
        progress = client.get(f"/api/jobs/{job_id}/progress").json()
        assert progress["generation_state"] == "waiting" and progress["completed"] == 0
        validate_json(progress, "urn:openapi#/components/schemas/JobProgress")
        # Отложенный pending не занимает модель и не препятствует другому старту.
        second = ready_lesson(client, headers)
        assert client.post(f"/api/sessions/{second}/start", headers=headers).status_code == 200
    with TestClient(create_database_app(local_config)) as restarted:
        login(restarted)
        assert any(
            p["job"]["id"] == job_id and p["generation_state"] == "waiting"
            for p in restarted.get("/api/packs/generation-jobs").json()
        )
        login(restarted, "trainee01")
        assert restarted.get("/api/ai/resource").status_code == 403
        assert restarted.get("/api/packs/generation-jobs").status_code == 403
        assert (
            restarted.post(
                "/api/packs/generate",
                headers={"X-CSRF-Token": restarted.cookies["csrf"]},
                json=body,
            ).status_code
            == 403
        )

    async def verify(db):
        row = await db.get(Job, UUID(job_id))
        assert row.status == "pending" and row.attempts == 0

    run_db(database_url, verify)


def test_queue_waits_all_teachers_and_rechecks_after_claim(local_config):
    async def check():
        worker = Worker(local_config, worker_id="deferred-resource")
        try:
            await clear_open_jobs(worker.database)
            async with worker.database.sessions.begin() as db:
                teacher = await db.scalar(select(User).where(User.login == "teacher"))
                other = User(
                    login="other-" + uuid4().hex,
                    password_hash=teacher.password_hash,
                    role="teacher",
                    full_name="Другой преподаватель",
                    is_active=True,
                )
                db.add(other)
                await db.flush()
                lessons = [
                    Session(
                        teacher_id=owner,
                        title="Конфликт",
                        kind="lesson",
                        status="running",
                        settings_snapshot={
                            "reaction_normative_s": 30,
                            "handling_normative_s": 180,
                            "critical_cap": 0.5,
                            "weights": {key: 1 for key in CRITERIA},
                            "parallel_cards": 1,
                            "hints_level": 1,
                        },
                    )
                    for owner in (teacher.id, other.id)
                ]
                practice = Session(
                    teacher_id=teacher.id,
                    title="Старая практика",
                    kind="practice",
                    status="running",
                    settings_snapshot=lessons[0].settings_snapshot,
                )
                db.add_all([*lessons, practice])
                deferred = await enqueue_job(db, kind="generate", payload={}, entity_id=uuid4())
                deferred_id = deferred.id
                immediate = await enqueue_job(
                    db, kind="generate", payload={"generation_policy": "now"}, entity_id=uuid4()
                )
                immediate_id = immediate.id
            claimed = await worker.queue.claim()
            assert claimed.id == immediate_id
            async with worker.database.sessions.begin() as db:
                await db.execute(
                    update(Job)
                    .where(Job.id == immediate_id)
                    .values(status="done", locked_by=None, locked_at=None)
                )
                await db.execute(
                    update(Session).where(Session.id == lessons[0].id).values(status="finished")
                )
            assert await worker.queue.claim() is None  # чужое занятие ещё идёт
            async with worker.database.sessions.begin() as db:
                row = await db.get(Job, deferred_id)
                assert row.attempts == 0 and row.status == "pending"
                await db.execute(
                    update(Session).where(Session.id == lessons[1].id).values(status="finished")
                )
            claimed = await worker.queue.claim()
            assert claimed.id == deferred_id  # practice не мешает
            # Занятие началось после claim; последняя проверка возвращает job без ошибки.
            async with worker.database.sessions.begin() as db:
                await db.execute(
                    update(Session).where(Session.id == lessons[0].id).values(status="running")
                )
            assert not await worker.queue.may_execute(claimed)
            async with worker.database.sessions.begin() as db:
                row = await db.get(Job, deferred_id)
                assert row.status == "pending" and row.attempts == 0 and row.error is None
                # Новое занятие продлевает ожидание, перезапуск worker его не отменяет.
            await worker.close()
            worker = Worker(local_config, worker_id="resource-after-restart")
            assert await worker.queue.claim() is None
            async with worker.database.sessions.begin() as db:
                await db.execute(
                    update(Session).where(Session.id == lessons[0].id).values(status="finished")
                )
            claimed = await worker.queue.claim()
            assert claimed.id == deferred_id and claimed.attempts == 1
            assert await worker.queue.may_execute(claimed)
        finally:
            await worker.close()

    asyncio.run(check())


@pytest.mark.parametrize("choice", ["wait", "now", "cancel"])
def test_lesson_start_choices_and_recovery(local_config, database_url, choice):
    with TestClient(create_database_app(local_config)) as client:
        headers = login(client)
        lesson_id = ready_lesson(client, headers)

        async def busy(db):
            row = await enqueue_job(db, kind="generate", payload={}, entity_id=uuid4())
            row.status, row.locked_by, row.locked_at = "running", "other-worker", datetime.now(UTC)
            return row.id

        job_id = run_db(database_url, busy)
        conflict = client.post(f"/api/sessions/{lesson_id}/start", headers=headers)
        assert conflict.status_code == 409 and conflict.json()["code"] == "ai_generation_busy"
        if choice == "cancel":
            waiting = client.post(
                f"/api/sessions/{lesson_id}/start", headers=headers, json={"mode": "wait"}
            )
            assert waiting.json()["start_pending"]
        result = client.post(
            f"/api/sessions/{lesson_id}/start",
            headers=headers,
            json={"mode": choice, "request_id": str(uuid4())},
        )
        assert result.status_code == 200, result.text
        result = result.json()
        if choice == "now":
            assert result["status"] == "running" and result["started_at"]
            return
        assert result["status"] == "draft" and result["started_at"] is None
        assert result["start_pending"] == (choice == "wait")
    with TestClient(create_database_app(local_config)) as restarted:
        headers = login(restarted)
        assert restarted.get(f"/api/sessions/{lesson_id}").json()["start_pending"] == (
            choice == "wait"
        )

    async def resume():
        worker = Worker(local_config)
        try:
            # Pending после первой порции тоже не значит, что весь пакет готов.
            async with worker.database.sessions.begin() as db:
                row = await db.get(Job, job_id)
                row.status, row.locked_by, row.locked_at = "pending", None, None
                lesson = await db.get(Session, UUID(lesson_id))
                if choice == "wait":
                    validate_json(lesson.start_request, "urn:lesson-start-request")
            await worker.schedule()
            async with worker.database.sessions.begin() as db:
                assert (await db.get(Session, UUID(lesson_id))).status == "draft"
                (await db.get(Job, job_id)).status = "done"
        finally:
            await worker.close()
        # Новый процесс восстанавливает сохранённый запрос без вкладки/API.
        recovered = Worker(local_config)
        try:
            await recovered.schedule()
        finally:
            await recovered.close()

    asyncio.run(resume())
    with TestClient(create_database_app(local_config)) as restarted:
        login(restarted)
        value = restarted.get(f"/api/sessions/{lesson_id}").json()
        assert value["status"] == ("running" if choice == "wait" else "draft")
        assert not value["start_pending"]


def test_start_between_generation_chunks_still_warns(local_config, database_url):
    # Между порциями пакет снова pending, пока, например, идёт оценка обучаемого.
    # Это не конец генерации: старт занятия предупреждает, ожидание держится до done.
    with TestClient(create_database_app(local_config)) as client:
        headers = login(client)
        lesson_id = ready_lesson(client, headers)

        async def partial(db):
            row = await enqueue_job(db, kind="generate", payload={}, entity_id=uuid4())
            row.result = {"scenario_ids": [str(uuid4())], "complete": False}
            return row.id

        job_id = run_db(database_url, partial)
        assert client.get("/api/ai/resource").json()["generation_running"] is True
        conflict = client.post(f"/api/sessions/{lesson_id}/start", headers=headers)
        assert conflict.status_code == 409 and conflict.json()["code"] == "ai_generation_busy"
        waiting = client.post(
            f"/api/sessions/{lesson_id}/start", headers=headers, json={"mode": "wait"}
        )
        assert waiting.status_code == 200 and waiting.json()["start_pending"]

    async def finish():
        worker = Worker(local_config)
        try:
            await worker.schedule()
            async with worker.database.sessions.begin() as db:
                assert (await db.get(Session, UUID(lesson_id))).status == "draft"
                row = await db.get(Job, job_id)
                row.status, row.result = "done", {"scenario_ids": [], "complete": True}
            await worker.schedule()
            async with worker.database.sessions() as db:
                assert (await db.get(Session, UUID(lesson_id))).status == "running"
        finally:
            await worker.close()

    asyncio.run(finish())


def test_off_resource_does_not_warn_or_defer(database_config):
    with TestClient(create_database_app(database_config)) as client:
        login(client)
        assert client.get("/api/ai/resource").json() == {
            "local_ai": False,
            "lesson_running": False,
            "generation_running": False,
        }


@pytest.mark.parametrize("explicit_now", [False, True])
def test_automatic_preparation_waits_unless_teacher_explicitly_chooses_now(
    local_config, database_url, explicit_now
):
    with TestClient(create_database_app(local_config)) as client:
        headers = login(client)
        running_id = ready_lesson(client, headers)
        assert client.post(f"/api/sessions/{running_id}/start", headers=headers).status_code == 200
        running = client.get(f"/api/sessions/{running_id}").json()
        selection = {"request_id": str(uuid4()), "cards_per_participant": 1}
        if explicit_now:
            selection["generation_policy"] = "now"
        created = client.post(
            "/api/sessions",
            headers=headers,
            json={
                "title": "Следующее ИИ-занятие",
                "participants": running["participants"],
                "settings_snapshot": running["settings_snapshot"],
                "ai_selection": selection,
            },
        )
        assert created.status_code == 201, created.text
        value = client.get(f"/api/sessions/{created.json()['id']}").json()["ai_preparation"]
        assert value["state"] == ("queued" if explicit_now else "waiting")

        async def verify(db):
            job = await db.get(Job, UUID(value["job_id"]))
            assert job.attempts == 0 and job.status == "pending"
            assert job.payload["generation_policy"] == ("now" if explicit_now else "after_lessons")

        run_db(database_url, verify)


def test_waiting_start_precedes_another_queued_generation(local_config, database_url):
    with TestClient(create_database_app(local_config)) as client:
        headers = login(client)
        lesson_id = ready_lesson(client, headers)

        async def busy(db):
            target = await enqueue_job(db, kind="generate", payload={}, entity_id=uuid4())
            target.status = "running"
            target.locked_by, target.locked_at = "original-generator", datetime.now(UTC)
            return target.id

        target_id = run_db(database_url, busy)
        response = client.post(
            f"/api/sessions/{lesson_id}/start", headers=headers, json={"mode": "wait"}
        )
        assert response.json()["start_pending"]

        async def finish_and_claim():
            worker = Worker(local_config)
            try:
                async with worker.database.sessions.begin() as db:
                    next_job = await enqueue_job(db, kind="generate", payload={}, entity_id=uuid4())
                    next_id = next_job.id
                # Второй worker не получает pending генерацию, пока предыдущий
                # пакет занимает ресурс: иначе он закрыл бы окно старта занятия.
                assert await worker.queue.claim() is None
                async with worker.database.sessions.begin() as db:
                    (await db.get(Job, target_id)).status = "done"
                # Между завершением старого пакета и следующим claim scheduler
                # ещё не успел тикнуть. Pending сам по себе не блокирует старт.
                assert await worker.queue.claim() is None
                async with worker.database.sessions() as db:
                    assert (await db.get(Job, next_id)).attempts == 0
            finally:
                await worker.close()

        asyncio.run(finish_and_claim())
        lesson = client.get(f"/api/sessions/{lesson_id}").json()
        assert lesson["status"] == "running" and not lesson["start_pending"]
