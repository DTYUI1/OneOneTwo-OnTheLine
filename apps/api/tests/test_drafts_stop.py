"""Удаление обратимо, остановка не ждёт LLM и не запускает следующую порцию."""

import asyncio
from copy import deepcopy
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.core.contracts import read_json
from app.core.models import (
    Assignment,
    AuditLog,
    Job,
    Scenario,
    ScenarioPack,
    ScenarioPackItem,
    Session,
    User,
)
from app.worker.runtime import Worker
from fastapi.testclient import TestClient
from sqlalchemy import select

from .test_c07_materials import draft_session
from .test_lifecycle import login, run_db
from .test_scenarios import assign_scenario


def new_scenario(client, headers):
    body = deepcopy(
        read_json("contracts/openapi.draft.yaml")["components"]["schemas"]["Scenario"]["examples"][
            0
        ]
    )
    body.update(id=str(uuid4()), status="draft")
    response = client.post("/api/scenarios", json=body, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.parametrize("kind", ["session", "scenario"])
def test_delete_restore_and_audit(database_client, database_url, kind):
    client = database_client
    headers = login(client)
    row = draft_session(client, headers) if kind == "session" else new_scenario(client, headers)
    path = f"/api/{kind}s/{row['id']}"
    if kind == "scenario":
        assignment_ids = assign_scenario(database_url, row["id"])
        pack_id = uuid4()

        async def add_pack(db):
            # Legacy-назначение из helper должно быть пригодно для публичного GET.
            assignment = await db.get(Assignment, assignment_ids[2])
            assignment.planned_at = datetime.now(UTC)
            scenario = await db.get(Scenario, UUID(row["id"]))
            db.add(
                ScenarioPack(
                    id=pack_id,
                    title="Удаление из пакета",
                    created_by=scenario.author_id,
                    status="draft",
                    origin="template",
                )
            )
            await db.flush()
            db.add(ScenarioPackItem(pack_id=pack_id, scenario_id=scenario.id, order=0))

        run_db(database_url, add_pack)
    response = client.delete(path, headers=headers)
    assert response.status_code == 200, response.text
    assert client.get(path).status_code == 404
    assert row["id"] not in [x["id"] for x in client.get(f"/api/{kind}s").json()]

    if kind == "scenario":
        pack = next(p for p in client.get("/api/packs").json() if p["id"] == str(pack_id))
        assert pack["scenario_ids"] == []

    async def check(db):
        model = Session if kind == "session" else Scenario
        saved = await db.get(model, UUID(row["id"]))
        assert saved.deleted_at is not None and saved.deleted_by is not None
        audit = await db.scalar(
            select(AuditLog).where(
                AuditLog.entity_id == row["id"], AuditLog.action.like("deleteDraft%")
            )
        )
        assert audit is not None
        if kind == "scenario":
            items = list(
                await db.scalars(select(Assignment).where(Assignment.scenario_id == saved.id))
            )
            # Legacy-статус остаётся контрактным; отмену хранит cancelled_at.
            assert items and all(a.cancelled_at is not None for a in items)
            assert all(a.status == "pending" and a.batch_id is None for a in items)

    run_db(database_url, check)
    if kind == "scenario":
        assignments = client.get(f"/api/sessions/{assignment_ids[0]}/assignments")
        assert assignments.status_code == 200, assignments.text
        assert [(a["id"], a["status"]) for a in assignments.json()] == [
            (str(assignment_ids[2]), "pending")
        ]
    assert client.post(path + "/restore", headers=headers).status_code == 403
    admin = login(client, "admin")
    assert row["id"] in [x["id"] for x in client.get("/api/admin/drafts").json()]
    assert client.post(path + "/restore", headers=admin).status_code == 200
    login(client)
    assert client.get(path).status_code == 200
    if kind == "scenario":
        pack = next(p for p in client.get("/api/packs").json() if p["id"] == str(pack_id))
        assert pack["scenario_ids"] == [row["id"]]


@pytest.mark.parametrize(
    "kind,status", [("session", "running"), ("session", "finished"), ("scenario", "approved")]
)
def test_delete_only_own_drafts(database_client, database_url, kind, status):
    client = database_client
    headers = login(client)
    row = draft_session(client, headers) if kind == "session" else new_scenario(client, headers)
    model = Session if kind == "session" else Scenario
    path = f"/api/{kind}s/{row['id']}"

    async def change(db, foreign=False):
        saved = await db.get(model, UUID(row["id"]))
        saved.status = "draft" if foreign else status
        if foreign:
            user = await db.scalar(select(User).where(User.login == "admin"))
            setattr(saved, "teacher_id" if kind == "session" else "author_id", user.id)

    run_db(database_url, change)
    assert client.delete(path, headers=headers).status_code == 409

    async def foreign(db):
        await change(db, True)

    run_db(database_url, foreign)
    assert client.delete(path, headers=headers).status_code == 403
    trainee = login(client, "trainee01")
    assert client.delete(path, headers=trainee).status_code == 403


@pytest.mark.parametrize("fail_current", [False, True])
def test_stop_while_worker_holds_job_preserves_partial_pack(
    database_config, database_url, fail_current
):
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        response = client.post(
            "/api/packs/generate",
            json={"count": 3, "level": 1, "service_id": "102", "seed": 791},
            headers=headers,
        )
        assert response.status_code == 202, response.text
        job_id = UUID(response.json()["id"])

        async def run():
            worker = Worker(database_config.model_copy(update={"ai_provider": "off"}))
            try:
                # В тестовой БД могут быть другие pending задания из seed.
                async with worker.database.sessions.begin() as db:
                    for job in await db.scalars(
                        select(Job).where(Job.id != job_id, Job.status.in_(["pending", "running"]))
                    ):
                        job.status = "failed"
                first = await worker.queue.claim()
                assert first.id == job_id
                assert await worker.process(first)
                entered, release = asyncio.Event(), asyncio.Event()
                original = worker.handlers.run

                async def slow(db, kind, payload):
                    result = await original(db, kind, payload)
                    entered.set()
                    await release.wait()
                    if fail_current:
                        raise RuntimeError("Проверка сбоя текущей порции после stop")
                    return result

                worker.handlers.run = slow
                second = await worker.queue.claim()
                task = asyncio.create_task(worker.process(second))
                await asyncio.wait_for(entered.wait(), 15)
                try:
                    stopped = await asyncio.wait_for(
                        asyncio.to_thread(client.post, f"/api/jobs/{job_id}/stop", headers=headers),
                        3,
                    )
                    assert stopped.status_code == 200, stopped.text
                    assert stopped.json()["generation_state"] == "stopping"
                finally:
                    release.set()
                    await task
                assert await worker.queue.claim() is None
                async with worker.database.sessions() as db:
                    job = await db.get(Job, job_id)
                    assert job.status == "cancelled"
                    assert len(job.result["scenario_ids"]) == (1 if fail_current else 2)
                    for sid in job.result["scenario_ids"]:
                        assert (await db.get(Scenario, UUID(sid))).status == "draft"
            finally:
                await worker.close()

        asyncio.run(run())
        progress = client.get(f"/api/jobs/{job_id}/progress").json()
        assert (progress["generation_state"], progress["completed"], progress["total"]) == (
            "cancelled",
            1 if fail_current else 2,
            3,
        )


@pytest.mark.parametrize("action", ["stop", "delete"])
def test_stop_preparation_does_not_start_lesson(database_config, database_url, action):
    config = database_config.model_copy(update={"ai_provider": "local"})
    with TestClient(create_database_app(config)) as client:
        headers = login(client)
        trainee = next(u for u in client.get("/api/users").json() if u["login"] == "trainee01")
        response = client.post(
            "/api/sessions",
            headers=headers,
            json={
                "title": "Остановка подготовки",
                "settings_snapshot": client.get("/api/settings").json(),
                "participants": [
                    {
                        "user_id": trainee["id"],
                        "workstation_number": 1,
                        "dds_service_id": "102",
                        "level": 1,
                    }
                ],
                "ai_selection": {"request_id": str(uuid4()), "cards_per_participant": 2},
            },
        )
        assert response.status_code == 201, response.text
        lesson = response.json()
        job_id = UUID(lesson["ai_preparation"]["job_id"])

        async def waiting(db):
            row = await db.get(Session, UUID(lesson["id"]))
            row.start_request = {"job_ids": [str(job_id)]}

        run_db(database_url, waiting)
        if action == "delete":
            stopped = client.delete(f"/api/sessions/{lesson['id']}", headers=headers)
        else:
            stopped = client.post(f"/api/jobs/{job_id}/stop", headers=headers)
        assert stopped.status_code == 200, stopped.text

        async def run():
            worker = Worker(database_config.model_copy(update={"ai_provider": "off"}))
            try:
                claimed = await worker.queue.claim()
                assert claimed.id == job_id  # запрос остановки приоритетнее прочих заданий
                assert await worker.process(claimed)
                async with worker.database.sessions() as db:
                    row = await db.get(Session, UUID(lesson["id"]))
                    assert row.status == "draft" and row.start_request is None
                    assert row.ai_preparation["state"] == "cancelled"
                    assert (row.deleted_at is not None) == (action == "delete")
            finally:
                await worker.close()

        asyncio.run(run())


def test_stop_rejects_foreign_job_and_non_owner_role(database_client, database_url):
    client = database_client
    headers = login(client)
    response = client.post(
        "/api/packs/generate", headers=headers, json={"count": 3, "level": 1, "service_id": "102"}
    )
    job_id = response.json()["id"]
    from app.core.models import ScenarioPack

    async def foreign(db):
        job = await db.get(Job, UUID(job_id))
        pack = await db.get(ScenarioPack, UUID(job.payload["pack_id"]))
        admin = await db.scalar(select(User).where(User.login == "admin"))
        pack.created_by = admin.id

    run_db(database_url, foreign)
    assert client.post(f"/api/jobs/{job_id}/stop", headers=headers).status_code == 403
    trainee = login(client, "trainee01")
    assert client.post(f"/api/jobs/{job_id}/stop", headers=trainee).status_code == 403


def test_stop_at_final_commit_cannot_be_accepted_and_lost(database_config, monkeypatch):
    from app.worker import cancellation

    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        response = client.post(
            "/api/packs/generate",
            headers=headers,
            json={"count": 1, "level": 1, "service_id": "102"},
        )
        job_id = UUID(response.json()["id"])

        async def run():
            worker = Worker(database_config.model_copy(update={"ai_provider": "off"}))
            entered, release = asyncio.Event(), asyncio.Event()
            original, calls = cancellation.requested, 0

            async def blocked(db, id):
                nonlocal calls
                result = await original(db, id)
                if id == job_id:
                    calls += 1
                    if calls == 3:  # may_execute, перед handler, перед commit
                        entered.set()
                        await release.wait()
                return result

            monkeypatch.setattr(cancellation, "requested", blocked)
            try:
                async with worker.database.sessions.begin() as db:
                    for job in await db.scalars(
                        select(Job).where(Job.id != job_id, Job.status.in_(["pending", "running"]))
                    ):
                        job.status = "failed"
                claimed = await worker.queue.claim()
                process = asyncio.create_task(worker.process(claimed))
                await asyncio.wait_for(entered.wait(), 15)
                stop = asyncio.create_task(
                    asyncio.to_thread(client.post, f"/api/jobs/{job_id}/stop", headers=headers)
                )
                try:
                    with pytest.raises(TimeoutError):
                        await asyncio.wait_for(asyncio.shield(stop), 0.1)
                finally:
                    release.set()
                    await process
                response = await asyncio.wait_for(stop, 3)
                assert response.status_code == 409  # завершение уже выиграло короткий lock
                assert "завершена" in response.json()["message"]
            finally:
                release.set()
                await worker.close()

        asyncio.run(run())


def test_cannot_assign_materials_to_deleted_lesson(database_client):
    client = database_client
    headers = login(client)
    lesson = draft_session(client, headers)
    assert client.delete(f"/api/sessions/{lesson['id']}", headers=headers).status_code == 200
    response = client.post(
        f"/api/sessions/{lesson['id']}/materials",
        headers=headers,
        json={
            "request_id": str(uuid4()),
            "materials": [{"material_id": str(uuid4()), "version": 1}],
        },
    )
    assert response.status_code == 404


def test_delete_and_stop_finalization_use_same_lock_order(database_config, database_url):
    """Удаление держит Session; финализация не должна держать stop-lock, ожидая Session."""
    from app.worker.cancellation import finish_stop, lock_stop, lock_stop_resources, request_stop

    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        lesson = draft_session(client, headers)
        response = client.post(
            "/api/packs/generate",
            headers=headers,
            json={"count": 2, "level": 1, "service_id": "102"},
        )
        job_id = UUID(response.json()["id"])

        async def run():
            worker = Worker(database_config)
            try:
                async with worker.database.sessions.begin() as db:
                    job = await db.get(Job, job_id)
                    job.payload = {**job.payload, "session_id": lesson["id"]}
                    owner = (await db.get(Session, UUID(lesson["id"]))).teacher_id
                    await request_stop(db, job_id, owner)
                # Моделируем уже исполняемую порцию и одновременно открытое удаление.
                async with worker.database.sessions.begin() as deleting:
                    row = await deleting.get(Session, UUID(lesson["id"]), with_for_update=True)

                    async def finish():
                        async with worker.database.sessions.begin() as db:
                            job = await db.get(Job, job_id, with_for_update=True)
                            await lock_stop_resources(db, job)
                            await lock_stop(db, job.id)
                            await finish_stop(db, job)

                    task = asyncio.create_task(finish())
                    await asyncio.sleep(0.05)
                    assert await asyncio.wait_for(request_stop(deleting, job_id, row.teacher_id), 2)
                    row.deleted_at = datetime.now(UTC)
                await asyncio.wait_for(task, 3)
                async with worker.database.sessions() as db:
                    assert (await db.get(Job, job_id)).status == "cancelled"
                    assert (await db.get(Session, UUID(lesson["id"]))).deleted_at is not None
            finally:
                await worker.close()

        asyncio.run(run())


def test_empty_cancelled_generation_is_hidden_but_history_is_preserved(
    database_client, database_url
):
    from app.worker.cancellation import finish_stop

    client = database_client
    headers = login(client)
    response = client.post(
        "/api/packs/generate",
        json={"count": 1, "level": 1, "service_id": "102", "seed": 791},
        headers=headers,
    )
    assert response.status_code == 202, response.text
    job_id = UUID(response.json()["id"])
    pack_id = client.get(f"/api/jobs/{job_id}/progress").json()["pack_id"]
    assert pack_id in {p["id"] for p in client.get("/api/packs").json()}

    async def stop(db):
        job = await db.get(Job, job_id, with_for_update=True)
        await finish_stop(db, job)

    run_db(database_url, stop)
    assert pack_id not in {p["id"] for p in client.get("/api/packs").json()}
    progress = client.get(f"/api/jobs/{job_id}/progress")
    assert progress.status_code == 200
    assert progress.json()["job"]["status"] == "cancelled"
    assert progress.json()["completed"] == 0
