"""PR109 G01–G05: HTTP-проекции и фиксация жизненного цикла в PostgreSQL."""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from app.api.database import create_database_app
from app.core.contracts import validate_json
from app.core.models import Assignment, Job, Scenario, ScenarioPack, ScenarioPackItem, Session
from app.worker.runtime import Worker
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from .test_lifecycle import login, run_db

pytestmark = pytest.mark.usefixtures("clean_generated_content")


@pytest.fixture
def lifecycle_config(database_config, database_url):
    async def idle(db):
        await db.execute(
            update(Session).where(Session.status == "running").values(status="finished")
        )
        await db.execute(
            update(Job)
            .where(Job.status.in_(["pending", "running"]))
            .values(status="failed", locked_by=None, locked_at=None)
        )

    run_db(database_url, idle)
    return database_config.model_copy(update={"ai_provider": "local"})


def new_lesson(client, headers, *, ai=False):
    from uuid import uuid4

    trainee = next(u for u in client.get("/api/users").json() if u["login"] == "trainee01")
    body = {
        "title": "Регрессия жизненного цикла",
        "settings_snapshot": client.get("/api/settings").json(),
        "participants": [
            {"user_id": trainee["id"], "workstation_number": 1, "dds_service_id": "102", "level": 1}
        ],
    }
    if ai:
        body["ai_selection"] = {"request_id": str(uuid4()), "cards_per_participant": 1}
    response = client.post("/api/sessions", headers=headers, json=body)
    assert response.status_code == 201, response.text
    return response.json()


def assign(client, headers, lesson, *, batch=False, order=1, scenario=None):
    from uuid import uuid4

    scenario = scenario or next(
        s
        for s in client.get("/api/scenarios").json()
        if s["status"] == "approved" and s["target_service_id"] == "102"
    )
    item = {
        "participant_id": lesson["participants"][0]["user_id"],
        "scenario_id": scenario["id"],
        "order": order,
    }
    if batch:
        item.update(
            scenario_version=scenario["version"], delay_from_start_s=0, delivery_mode="profile"
        )
        path, body = "/assignments/batch", {"request_id": str(uuid4()), "items": [item]}
    else:
        item["planned_at"] = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
        path, body = "/assignments", item
    response = client.post(f"/api/sessions/{lesson['id']}{path}", headers=headers, json=body)
    assert response.status_code == 201, response.text
    return response.json()["assignments"][0] if batch else response.json()


def process_job(config, job_id):
    async def run():
        worker = Worker(config.model_copy(update={"ai_provider": "off"}))
        try:
            claimed = await worker.queue.claim()
            assert claimed is not None and str(claimed.id) == job_id
            assert await worker.process(claimed)
        finally:
            await worker.close()

    asyncio.run(run())


def assignments_snapshot(database_url, lesson_id):
    async def read(db):
        rows = await db.scalars(select(Assignment).where(Assignment.session_id == UUID(lesson_id)))
        return {
            str(row.id): {
                column.name: getattr(row, column.name) for column in Assignment.__table__.columns
            }
            for row in rows
        }

    return run_db(database_url, read)


@pytest.mark.parametrize("source", ["legacy", "batch", "ready_ai"])
def test_g01_restore_preserves_assignments_and_prior_cancellations(
    lifecycle_config, database_url, source
):
    with TestClient(create_database_app(lifecycle_config)) as client:
        headers = login(client)
        lesson = new_lesson(client, headers, ai=source == "ready_ai")
        lesson_id = lesson["id"]
        if source == "ready_ai":
            process_job(lifecycle_config, lesson["ai_preparation"]["job_id"])
            assert (
                client.get(f"/api/sessions/{lesson_id}").json()["ai_preparation"]["state"]
                == "ready"
            )
        else:
            assign(client, headers, lesson, batch=source == "batch")
            cancelled = assign(client, headers, lesson, batch=source == "batch", order=2)

            async def cancel_old(db):
                row = await db.get(Assignment, UUID(cancelled["id"]))
                row.cancelled_at = datetime.now(UTC) - timedelta(days=1)
                if row.batch_id is not None:
                    row.status = "cancelled"

            run_db(database_url, cancel_old)
        before = assignments_snapshot(database_url, lesson_id)
        assert before
        for _ in range(2):
            assert client.delete(f"/api/sessions/{lesson_id}", headers=headers).status_code == 200
            assert client.get(f"/api/sessions/{lesson_id}").status_code == 404
            assert client.delete(f"/api/sessions/{lesson_id}", headers=headers).status_code == 200
            admin = login(client, "admin")
            assert (
                client.post(f"/api/sessions/{lesson_id}/restore", headers=admin).status_code == 200
            )
            headers = login(client)
            assert assignments_snapshot(database_url, lesson_id) == before
            response = client.get(f"/api/sessions/{lesson_id}/assignments")
            assert response.status_code == 200, response.text
            for row in response.json():
                validate_json(row, "urn:openapi#/components/schemas/Assignment")
        response = client.post(f"/api/sessions/{lesson_id}/start", headers=headers)
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "running"


@pytest.mark.parametrize("winner", ["restore", "stop"])
def test_g01_restore_stop_race_preserves_unrelated_assignments(
    lifecycle_config, database_url, monkeypatch, winner
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from time import monotonic, sleep
    from uuid import uuid4

    from app.api.drafts import router as drafts
    from app.api.sessions import repo, schemas
    from app.api.sessions.preparation import initialize_preparation
    from app.worker import cancellation
    from sqlalchemy import text

    entered, release = Event(), Event()
    with TestClient(create_database_app(lifecycle_config)) as client:
        headers = login(client)
        lesson = new_lesson(client, headers)
        assign(client, headers, lesson)
        assign(client, headers, lesson, batch=True, order=2)
        before = assignments_snapshot(database_url, lesson["id"])

        async def preparation(db):
            row = await repo.get_session(db, UUID(lesson["id"]), lock=True)
            await initialize_preparation(db, row, schemas.AISelection(request_id=uuid4()))
            return row.ai_preparation["job_id"]

        job_id = run_db(database_url, preparation)
        assert client.delete(f"/api/sessions/{lesson['id']}", headers=headers).status_code == 200
        admin = login(client, "admin")
        original = drafts.change if winner == "restore" else cancellation.finish_stop

        async def paused(*args, **kwargs):
            result = await original(*args, **kwargs)
            entered.set()
            assert await asyncio.to_thread(release.wait, 10)
            return result

        if winner == "restore":
            monkeypatch.setattr(drafts, "change", paused)
        else:
            monkeypatch.setattr(cancellation, "finish_stop", paused)

        def restore():
            response = client.post(f"/api/sessions/{lesson['id']}/restore", headers=admin)
            assert response.status_code == 200, response.text

        def stop():
            process_job(lifecycle_config, job_id)

        async def blocked(db):
            return await db.scalar(
                text(
                    "SELECT count(*) FROM pg_stat_activity WHERE "
                    "datname = current_database() AND wait_event_type = 'Lock'"
                )
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(restore if winner == "restore" else stop)
            second = None
            try:
                assert entered.wait(5)
                second = pool.submit(stop if winner == "restore" else restore)
                deadline = monotonic() + 5
                while not run_db(database_url, blocked) and monotonic() < deadline:
                    sleep(0.01)
                assert run_db(database_url, blocked) > 0
                assert not second.done()
            finally:
                release.set()
            first.result(timeout=10)
            assert second is not None
            second.result(timeout=10)
        assert assignments_snapshot(database_url, lesson["id"]) == before
        headers = login(client)
        response = client.post(f"/api/sessions/{lesson['id']}/start", headers=headers)
        assert response.status_code == 200, response.text


def test_g02_repeated_stop_does_not_cancel_manual_assignments(lifecycle_config, database_url):
    from app.worker.cancellation import finish_stop

    with TestClient(create_database_app(lifecycle_config)) as client:
        headers = login(client)
        lesson = new_lesson(client, headers, ai=True)
        job_id = lesson["ai_preparation"]["job_id"]
        assert client.post(f"/api/jobs/{job_id}/stop", headers=headers).status_code == 200
        process_job(lifecycle_config, job_id)
        assign(client, headers, lesson)
        assign(client, headers, lesson, batch=True, order=2)
        before = assignments_snapshot(database_url, lesson["id"])

        async def repeat(db):
            job = await db.get(Job, UUID(job_id), with_for_update=True)
            await finish_stop(db, job)

        run_db(database_url, repeat)
        assert assignments_snapshot(database_url, lesson["id"]) == before
        response = client.post(f"/api/sessions/{lesson['id']}/start", headers=headers)
        assert response.status_code == 200, response.text


@pytest.mark.parametrize("foreign_owner", [False, True])
def test_g05_cancelled_other_generation_releases_deferred_start(
    lifecycle_config, database_url, foreign_owner
):
    from uuid import uuid4

    from app.core.ai_resource import lock_scheduling
    from app.core.models import AuditLog, User
    from app.worker.deferred_start import start_waiting_locked

    with TestClient(create_database_app(lifecycle_config)) as client:
        headers = login(client)
        lesson = new_lesson(client, headers)
        assign(client, headers, lesson)
        response = client.post(
            "/api/packs/generate",
            headers=headers,
            json={"count": 2, "level": 1, "service_id": "102", "seed": 119},
        )
        assert response.status_code == 202, response.text
        job_id = response.json()["id"]
        process_job(lifecycle_config, job_id)
        if foreign_owner:
            other_login = "lifecycle-" + uuid4().hex

            async def ownership(db):
                teacher = await db.scalar(select(User).where(User.login == "teacher"))
                other = User(
                    login=other_login,
                    password_hash=teacher.password_hash,
                    role="teacher",
                    full_name="Другой преподаватель",
                    is_active=True,
                )
                db.add(other)
                await db.flush()
                job = await db.get(Job, UUID(job_id))
                (await db.get(ScenarioPack, UUID(job.payload["pack_id"]))).created_by = other.id

            run_db(database_url, ownership)
        response = client.post(
            f"/api/sessions/{lesson['id']}/start", headers=headers, json={"mode": "wait"}
        )
        assert response.status_code == 200 and response.json()["start_pending"], response.text
        if foreign_owner:
            headers = login(client, other_login)
        assert client.post(f"/api/jobs/{job_id}/stop", headers=headers).status_code == 200
        process_job(lifecycle_config, job_id)

        async def start(db):
            await lock_scheduling(db)
            return await start_waiting_locked(db)

        assert run_db(database_url, start) == 1
        assert run_db(database_url, start) == 0
        login(client)
        response = client.get(f"/api/sessions/{lesson['id']}")
        assert response.json()["status"] == "running"
        assert not response.json()["start_pending"] and response.json()["start_error"] is None

        async def audits(db):
            return len(
                list(
                    await db.scalars(
                        select(AuditLog).where(
                            AuditLog.entity_id == lesson["id"], AuditLog.action == "startSession"
                        )
                    )
                )
            )

        # Один HTTP-запрос wait и один фактический старт worker.
        assert run_db(database_url, audits) == 2


def test_g05_own_stopped_preparation_never_autostarts(lifecycle_config, database_url):
    from app.core.ai_resource import lock_scheduling
    from app.worker.deferred_start import start_waiting_locked

    with TestClient(create_database_app(lifecycle_config)) as client:
        headers = login(client)
        lesson = new_lesson(client, headers, ai=True)
        job_id = lesson["ai_preparation"]["job_id"]

        async def waiting(db):
            (await db.get(Session, UUID(lesson["id"]))).start_request = {"job_ids": [job_id]}

        run_db(database_url, waiting)
        assert client.post(f"/api/jobs/{job_id}/stop", headers=headers).status_code == 200
        process_job(lifecycle_config, job_id)
        # Даже после ручного наполнения старый wait не должен воскресать.
        assign(client, headers, lesson)

        async def start(db):
            await lock_scheduling(db)
            assert (await db.get(Session, UUID(lesson["id"]))).start_request is None
            return await start_waiting_locked(db)

        assert run_db(database_url, start) == 0
        assert client.get(f"/api/sessions/{lesson['id']}").json()["status"] == "draft"


@pytest.mark.parametrize("action", ["retire", "delete_scenario", "finish_stop"])
def test_g04_legacy_cancellation_keeps_assignment_api_valid(lifecycle_config, database_url, action):
    from uuid import uuid4

    with TestClient(create_database_app(lifecycle_config), raise_server_exceptions=False) as client:
        headers = login(client)
        lesson = new_lesson(client, headers, ai=action == "finish_stop")
        scenario = dict(
            next(
                s
                for s in client.get("/api/scenarios").json()
                if s["status"] == "approved" and s["target_service_id"] == "102"
            )
        )
        scenario["id"] = str(uuid4())
        created = client.post("/api/scenarios", headers=headers, json=scenario)
        assert created.status_code == 201, created.text
        scenario = created.json()
        if action == "finish_stop":

            async def legacy_mode(db):
                (await db.get(Session, UUID(lesson["id"]))).ai_preparation = None

            run_db(database_url, legacy_mode)
        legacy = assign(client, headers, lesson, scenario=scenario)
        batch = assign(client, headers, lesson, batch=True, order=2, scenario=scenario)
        if action == "delete_scenario":

            async def old_draft(db):
                (await db.get(Scenario, UUID(scenario["id"]))).status = "draft"

            run_db(database_url, old_draft)
            response = client.delete(f"/api/scenarios/{scenario['id']}", headers=headers)
        elif action == "retire":
            response = client.post(f"/api/scenarios/{scenario['id']}/retire", headers=headers)
        else:
            job_id = lesson["ai_preparation"]["job_id"]

            async def restore_preparation(db):
                (await db.get(Session, UUID(lesson["id"]))).ai_preparation = lesson[
                    "ai_preparation"
                ]
                job = await db.get(Job, UUID(job_id))
                db.add(
                    ScenarioPackItem(
                        pack_id=UUID(job.payload["pack_id"]),
                        scenario_id=UUID(scenario["id"]),
                        order=1,
                    )
                )

            run_db(database_url, restore_preparation)
            response = client.post(f"/api/jobs/{job_id}/stop", headers=headers)
            assert response.status_code == 200, response.text
            process_job(lifecycle_config, job_id)
        assert response.status_code == 200, response.text
        response = client.get(f"/api/sessions/{lesson['id']}/assignments")
        assert response.status_code == 200, response.text
        assert response.json()[0]["id"] == legacy["id"]
        validate_json(response.json()[0], "urn:openapi#/components/schemas/Assignment")
        saved = assignments_snapshot(database_url, lesson["id"])
        assert saved[legacy["id"]]["cancelled_at"] is not None
        assert saved[legacy["id"]]["status"] == "pending"
        assert saved[batch["id"]]["cancelled_at"] is not None
        assert saved[batch["id"]]["status"] == "cancelled"
        lifecycle = client.get(f"/api/sessions/{lesson['id']}/lifecycle")
        assert lifecycle.status_code == 200, lifecycle.text
        validate_json(lifecycle.json(), "urn:openapi#/components/schemas/SessionLifecycle")
        assert set(lifecycle.json()["cancelled_assignment_ids"]) == {legacy["id"], batch["id"]}
        assert lifecycle.json()["remaining_assignments"] == 0


@pytest.mark.parametrize("pack_status", ["draft", "approved"])
def test_g03_stop_preserves_teacher_decisions_versions_and_pack(
    lifecycle_config, database_url, pack_status
):
    with TestClient(create_database_app(lifecycle_config)) as client:
        headers = login(client)
        response = client.post(
            "/api/packs/generate",
            headers=headers,
            json={"count": 3, "level": 1, "service_id": "102", "seed": 789},
        )
        assert response.status_code == 202, response.text
        job_id = response.json()["id"]
        process_job(lifecycle_config, job_id)
        process_job(lifecycle_config, job_id)
        progress = client.get(f"/api/jobs/{job_id}/progress").json()
        pack_id = progress["pack_id"]
        from uuid import uuid4

        response = client.post(
            f"/api/packs/{pack_id}/approve",
            headers=headers,
            json={
                "request_id": str(uuid4()),
                "scenarios": [
                    {"scenario_id": sid, "version": 1} for sid in progress["scenario_ids"]
                ],
            },
        )
        assert response.status_code == 200, response.text
        retired_id, approved_id = progress["scenario_ids"]
        response = client.post(f"/api/scenarios/{retired_id}/retire", headers=headers)
        assert response.status_code == 200, response.text
        lesson = new_lesson(client, headers)
        approved = client.get(f"/api/scenarios/{approved_id}").json()
        assign(client, headers, lesson, scenario=approved)

        async def snapshot(db):
            pack = await db.get(ScenarioPack, UUID(pack_id))
            scenarios = list(
                await db.scalars(
                    select(Scenario)
                    .join(ScenarioPackItem, ScenarioPackItem.scenario_id == Scenario.id)
                    .where(ScenarioPackItem.pack_id == pack.id)
                    .order_by(Scenario.id)
                )
            )
            return {
                "pack": {c.name: getattr(pack, c.name) for c in ScenarioPack.__table__.columns},
                "scenarios": {
                    str(s.id): {c.name: getattr(s, c.name) for c in Scenario.__table__.columns}
                    for s in scenarios
                },
            }

        async def persist_pack_status(db):
            # Поддерживаем оба сохранённых состояния пакета, в том числе auto-admit.
            (await db.get(ScenarioPack, UUID(pack_id))).status = pack_status

        run_db(database_url, persist_pack_status)
        before = run_db(database_url, snapshot)
        assert client.post(f"/api/jobs/{job_id}/stop", headers=headers).status_code == 200
        process_job(lifecycle_config, job_id)
        assert run_db(database_url, snapshot) == before
        response = client.post(f"/api/sessions/{lesson['id']}/start", headers=headers)
        assert response.status_code == 200, response.text


@pytest.mark.parametrize("batch", [False, True])
def test_g02_stopped_preparation_allows_manual_fill_and_start(lifecycle_config, batch):
    with TestClient(create_database_app(lifecycle_config)) as client:
        headers = login(client)
        lesson = new_lesson(client, headers, ai=True)
        job_id = lesson["ai_preparation"]["job_id"]
        response = client.post(f"/api/jobs/{job_id}/stop", headers=headers)
        assert response.status_code == 200, response.text
        # До фиксации stop назначения по-прежнему принадлежат генератору.
        assert client.get(f"/api/sessions/{lesson['id']}").json()["ai_preparation"] is not None
        process_job(lifecycle_config, job_id)
        stopped = client.get(f"/api/sessions/{lesson['id']}").json()
        assign(client, headers, lesson, batch=batch)
        # Старый UI открывает ручную раздачу именно по nullable-полю Session.
        assert stopped["ai_preparation"] is None
        progress = client.get(f"/api/jobs/{job_id}/progress")
        assert progress.status_code == 200
        assert progress.json()["generation_state"] == "cancelled"
        validate_json(progress.json(), "urn:openapi#/components/schemas/JobProgress")
        response = client.post(f"/api/sessions/{lesson['id']}/start", headers=headers)
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "running"
