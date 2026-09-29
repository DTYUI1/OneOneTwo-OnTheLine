"""Сценарии: постоянное хранение, контракт, права и защита истории занятий."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.core.config import ROOT
from app.core.contracts import read_json, validate_json
from app.core.db import Database
from app.core.models import Assignment, AuditLog, Participant, Scenario, Session, User
from fastapi.testclient import TestClient
from sqlalchemy import delete, select


def run_db(url, action):
    async def run():
        database = Database(url)
        try:
            async with database.sessions.begin() as db:
                return await action(db)
        finally:
            await database.close()

    return asyncio.run(run())


def login(client, role="teacher"):
    response = client.post("/api/auth/login", json={"login": role, "password": "test-password"})
    assert response.status_code == 200, response.text
    return {"X-CSRF-Token": client.cookies["csrf"]}


def test_incomplete_reference_can_be_drafted_but_not_approved(database_client, scenario):
    headers = login(database_client)
    scenario["reference"]["expected_flow"] = []
    created = database_client.post("/api/scenarios", json=scenario, headers=headers)
    assert created.status_code == 201, created.text
    scenario["status"] = "approved"
    rejected = database_client.put(
        f"/api/scenarios/{scenario['id']}", json=scenario, headers=headers
    )
    assert rejected.status_code == 422, rejected.text
    assert "решение" in rejected.json()["message"]
    loaded = database_client.get(f"/api/scenarios/{scenario['id']}").json()
    assert loaded["status"] == "draft"
    scenario["reference"]["expected_flow"] = ["received", "rejected", "redirected"]
    scenario["reference"]["expected_service_ids"] = ["101"]
    accepted = database_client.put(
        f"/api/scenarios/{scenario['id']}", json=scenario, headers=headers
    )
    assert accepted.status_code == 200, accepted.text


@pytest.fixture
def scenario(database_url):
    body = deepcopy(
        read_json("contracts/openapi.draft.yaml")["components"]["schemas"]["Scenario"]["examples"][
            0
        ]
    )
    body.update(id=str(uuid4()), status="draft", origin="imported")
    yield body

    async def remove(db):
        await db.execute(delete(Scenario).where(Scenario.id == UUID(body["id"])))

    run_db(database_url, remove)


def assign_scenario(database_url, scenario_id):
    session_id, participant_id, assignment_id = uuid4(), uuid4(), uuid4()

    async def assign(db):
        teacher = await db.scalar(select(User).where(User.login == "teacher"))
        trainee = await db.scalar(select(User).where(User.login == "trainee01"))
        db.add(
            Session(
                id=session_id,
                teacher_id=teacher.id,
                title="Учебное занятие",
                status="draft",
                settings_snapshot={},
            )
        )
        await db.flush()
        db.add(
            Participant(
                id=participant_id,
                session_id=session_id,
                user_id=trainee.id,
                workstation_id=1,
                dds_service_id="101",
                level=1,
                rating_at_start=0,
            )
        )
        await db.flush()
        db.add(
            Assignment(
                id=assignment_id,
                session_id=session_id,
                participant_id=participant_id,
                scenario_id=UUID(scenario_id),
                order=1,
                status="pending",
            )
        )

    run_db(database_url, assign)
    return session_id, participant_id, assignment_id


def remove_assignment(database_url, ids):
    session_id, participant_id, assignment_id = ids

    async def remove(db):
        await db.execute(delete(Assignment).where(Assignment.id == assignment_id))
        await db.execute(delete(Participant).where(Participant.id == participant_id))
        await db.execute(delete(Session).where(Session.id == session_id))

    run_db(database_url, remove)


@pytest.mark.parametrize("role,code", [(None, 401), ("trainee01", 403)])
def test_scenario_access(database_client, scenario, role, code):
    client = database_client
    headers = login(client, role) if role else {}
    for method, path in [
        ("GET", "/api/scenarios"),
        ("GET", f"/api/scenarios/{scenario['id']}"),
        ("POST", "/api/scenarios"),
        ("PUT", f"/api/scenarios/{scenario['id']}"),
        ("POST", f"/api/scenarios/{scenario['id']}/retire"),
    ]:
        assert client.request(method, path, json=scenario, headers=headers).status_code == code


def test_seeded_scenarios_and_missing_ids(database_client):
    client = database_client
    login(client)
    expected = [
        read_json(path.relative_to(ROOT).as_posix())["scenario"]
        for path in (ROOT / "data/golden_scenarios").glob("*.json")
    ]
    response = client.get("/api/scenarios")
    assert response.status_code == 200
    # БД общая для набора: другие тесты создают собственные занятия и сценарии.
    seeded_ids = {item["id"] for item in expected}
    assert [item for item in response.json() if item["id"] in seeded_ids] == sorted(
        expected, key=lambda item: item["id"]
    )
    for body in response.json():
        validate_json(body, "https://arm112.local/contracts/scenario.schema.json")
        assert client.get(f"/api/scenarios/{body['id']}").json() == body
    assert client.get(f"/api/scenarios/{uuid4()}").status_code == 404
    assert client.get("/api/scenarios/not-a-uuid").status_code == 422


@pytest.mark.parametrize("role", ["teacher"])
def test_create_update_persist_and_audit(
    database_client, database_config, database_url, scenario, role
):
    client = database_client
    headers = login(client, role)
    path = f"/api/scenarios/{scenario['id']}"
    assert client.post("/api/scenarios", json=scenario).status_code == 403
    created = client.post("/api/scenarios", json=scenario, headers=headers)
    assert created.status_code == 201, created.text
    assert created.json() == scenario
    assert client.post("/api/scenarios", json=scenario, headers=headers).status_code == 409
    changed = {**scenario, "teacher_comment": "Исправленный учебный эталон", "status": "approved"}
    assert client.put(path, json=changed).status_code == 403
    updated = client.put(path, json=changed, headers=headers)
    assert updated.status_code == 200, updated.text
    expected = {**changed, "version": scenario["version"] + 1}
    assert updated.json() == expected
    assert client.put(path, json=changed, headers=headers).status_code == 409
    with TestClient(create_database_app(database_config)) as second:
        login(second)
        assert second.get(path).json() == expected

    async def check(db):
        author = await db.scalar(select(User).where(User.login == role))
        row = await db.get(Scenario, UUID(scenario["id"]))
        assert row.author_id == author.id
        logs = list(
            (
                await db.scalars(
                    select(AuditLog)
                    .where(AuditLog.entity_id == scenario["id"])
                    .order_by(AuditLog.ts)
                )
            ).all()
        )
        created_log = next(
            log for log in logs if log.action == "createScenario" and log.after == scenario
        )
        assert created_log.actor_id == author.id
        assert created_log.before is None
        updated_log = next(
            log for log in logs if log.action == "updateScenario" and log.after == expected
        )
        assert updated_log.before == scenario
        assert updated_log.actor_id == author.id
        for log in logs:
            for snapshot in (log.before, log.after):
                if snapshot is not None:
                    validate_json(
                        snapshot,
                        "https://arm112.local/contracts/storage.schema.json#/$defs/AuditSnapshot",
                    )

    run_db(database_url, check)


def test_create_new_version_uses_get_then_post(database_client, database_url, scenario):
    client = database_client
    headers = login(client)
    assert client.post("/api/scenarios", json=scenario, headers=headers).status_code == 201
    source = client.get(f"/api/scenarios/{scenario['id']}")
    assert source.status_code == 200
    copied_id = uuid4()
    copied = {
        **source.json(),
        "id": str(copied_id),
        "version": 1,
        "status": "draft",
        "teacher_comment": "Новая версия учебного сценария",
    }
    try:
        created = client.post("/api/scenarios", json=copied, headers=headers)
        assert created.status_code == 201, created.text
        assert created.json() == copied
        assert client.get(f"/api/scenarios/{copied_id}").json() == copied
        assert client.get(f"/api/scenarios/{scenario['id']}").json() == scenario

        async def check(db):
            rows = list(
                (
                    await db.scalars(select(AuditLog).where(AuditLog.entity_id == str(copied_id)))
                ).all()
            )
            assert len(rows) == 1
            assert rows[0].action == "createScenario"
            assert rows[0].before is None
            assert rows[0].after == copied

        run_db(database_url, check)
    finally:

        async def remove(db):
            await db.execute(delete(Scenario).where(Scenario.id == copied_id))

        run_db(database_url, remove)


@pytest.mark.parametrize(
    "field,value",
    [
        ("level", 5),
        ("weight", True),
        ("version", "1"),
        ("origin", "unknown"),
        ("complications", ["unknown"]),
        ("extra", "not allowed"),
        ("incident_type_code", "missing-type"),
        ("target_service_id", "missing-service"),
        ("card", {}),
        ("reference", {}),
    ],
)
def test_invalid_scenario_is_not_saved(database_client, scenario, field, value):
    client = database_client
    headers = login(client)
    response = client.post("/api/scenarios", json={**scenario, field: value}, headers=headers)
    assert response.status_code == 422, response.text
    assert set(response.json()) == {"code", "message", "details"}
    assert client.get(f"/api/scenarios/{scenario['id']}").status_code == 404


def test_update_rejections_preserve_previous_value(database_client, scenario):
    client = database_client
    headers = login(client)
    path = f"/api/scenarios/{scenario['id']}"
    assert client.put(path, json=scenario, headers=headers).status_code == 404
    assert client.post("/api/scenarios", json=scenario, headers=headers).status_code == 201
    for change in [
        {"id": str(uuid4())},
        {"target_service_id": "missing-service"},
        {"reference": {**scenario["reference"], "expected_call": {}}},
        {"card": {**scenario["card"], "extra": "not allowed"}},
    ]:
        response = client.put(path, json={**scenario, **change}, headers=headers)
        assert response.status_code == 422, response.text
        assert client.get(path).json() == scenario


def test_concurrent_updates_detect_stale_version(database_config, database_client, scenario):
    headers = login(database_client)
    assert database_client.post("/api/scenarios", json=scenario, headers=headers).status_code == 201
    path = f"/api/scenarios/{scenario['id']}"
    # Разные auth_session: конкурентность не должна случайно обеспечиваться lock авторизации.
    with TestClient(create_database_app(database_config)) as second:
        second_headers = login(second, "teacher")
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(database_client.put, path, json=scenario, headers=headers)
            other = pool.submit(second.put, path, json=scenario, headers=second_headers)
            assert sorted([first.result().status_code, other.result().status_code]) == [200, 409]
    assert database_client.get(path).json()["version"] == scenario["version"] + 1


def test_assigned_scenario_is_immutable(database_client, database_url, scenario):
    client = database_client
    headers = login(client)
    assert client.post("/api/scenarios", json=scenario, headers=headers).status_code == 201
    assignment_ids = assign_scenario(database_url, scenario["id"])
    try:
        path = f"/api/scenarios/{scenario['id']}"
        assert client.put(path, json=scenario, headers=headers).status_code == 409
        assert client.get(path).json() == scenario
    finally:
        remove_assignment(database_url, assignment_ids)


@pytest.mark.parametrize("role", ["teacher"])
def test_retire_assigned_scenario_is_atomic_and_audited(
    database_client, database_url, scenario, role
):
    client = database_client
    headers = login(client, role)
    approved = {**scenario, "status": "approved"}
    assert client.post("/api/scenarios", json=approved, headers=headers).status_code == 201
    assignment_ids = assign_scenario(database_url, scenario["id"])
    path = f"/api/scenarios/{scenario['id']}/retire"
    try:
        assert client.post(path).status_code == 403
        retired = client.post(path, headers=headers)
        assert retired.status_code == 200, retired.text
        expected = {**approved, "status": "retired", "version": approved["version"] + 1}
        assert retired.json() == expected
        assert client.get(f"/api/scenarios/{scenario['id']}").json() == expected
        assert client.post(path, headers=headers).status_code == 409

        async def check(db):
            assignment = await db.get(Assignment, assignment_ids[2])
            assert assignment is not None
            assert assignment.scenario_id == UUID(scenario["id"])
            logs = list(
                (
                    await db.scalars(
                        select(AuditLog)
                        .where(
                            AuditLog.entity_id == scenario["id"],
                            AuditLog.action == "retireScenario",
                        )
                        .order_by(AuditLog.ts)
                    )
                ).all()
            )
            assert logs[0].before == approved
            assert logs[0].after == expected
            assert logs[1].before is None
            assert logs[1].after == {"status_code": 409}

        run_db(database_url, check)
    finally:
        remove_assignment(database_url, assignment_ids)
