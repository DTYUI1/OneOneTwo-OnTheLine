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
from app.core.models import Assignment, AuditLog, Participant, Scenario, Session, Setting, User
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
    body.update(
        id=str(uuid4()),
        status="draft",
        origin="imported",
        coherence_unchecked=False,
        is_manual=False,
        variant_label="",
    )
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
                settings_snapshot=await db.scalar(
                    select(Setting.value).where(Setting.key == "training")
                ),
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
        {
            **read_json(path.relative_to(ROOT).as_posix())["scenario"],
            "coherence_unchecked": False,
            "variant_label": "",
            "is_manual": read_json(path.relative_to(ROOT).as_posix())["scenario"]["origin"]
            in {"template", "trainee"},
        }
        for path in (ROOT / "data/golden_scenarios").glob("*.json")
    ]
    response = client.get("/api/scenarios")
    assert response.status_code == 200
    # БД общая для набора: другие тесты создают собственные занятия и сценарии.
    seeded_ids = {item["id"] for item in expected}
    assert [
        {k: v for k, v in item.items() if k != "created_at"}
        for item in response.json()
        if item["id"] in seeded_ids
    ] == sorted(expected, key=lambda item: item["id"])
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
    assert {k: v for k, v in created.json().items() if k != "created_at"} == scenario
    scenario = created.json()
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
        assert created.json()["created_at"] != source.json()["created_at"]
        copied["created_at"] = created.json()["created_at"]
        assert created.json() == copied
        assert client.get(f"/api/scenarios/{copied_id}").json() == copied
        assert client.get(f"/api/scenarios/{scenario['id']}").json() == source.json()

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
    scenario = client.get(f"/api/scenarios/{scenario['id']}").json()
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
    scenario = {**scenario, "teacher_comment": "Конкурентное изменение"}
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
    scenario = client.get(f"/api/scenarios/{scenario['id']}").json()
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
    approved = client.get(f"/api/scenarios/{approved['id']}").json()
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


def test_invalid_call_reports_field_and_preserves_valid_optional_call(database_client, scenario):
    headers = login(database_client)
    scenario["reference"]["expected_call"]["required"] = False
    bad = deepcopy(scenario)
    bad["reference"]["expected_call"] = {"required": False}
    response = database_client.post("/api/scenarios", headers=headers, json=bad)
    assert response.status_code == 422
    assert "reference.expected_call" in response.json()["details"]["errors"][0]["reason"]
    assert "service_id" in response.json()["details"]["errors"][0]["reason"]
    assert database_client.post("/api/scenarios", headers=headers, json=scenario).status_code == 201


def test_creation_date_is_server_owned_and_returned_in_lists(database_client, scenario):
    headers = login(database_client)
    scenario["created_at"] = "2000-01-01T00:00:00Z"
    response = database_client.post("/api/scenarios", json=scenario, headers=headers)
    assert response.status_code == 201, response.text
    created = response.json()
    assert created["created_at"] and not created["created_at"].startswith("2000-")
    updated = {**created, "created_at": "2001-01-01T00:00:00Z"}
    response = database_client.put(f"/api/scenarios/{created['id']}", json=updated, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["created_at"] == created["created_at"]
    listed = next(
        x for x in database_client.get("/api/scenarios").json() if x["id"] == created["id"]
    )
    assert listed["created_at"] == created["created_at"]
    packs = database_client.get("/api/packs").json()
    assert packs and all(pack["created_at"] for pack in packs)


def test_exact_trainee_is_not_lost_beyond_search_limit(database_client, database_url):
    login(database_client)

    async def add(db):
        original = await db.scalar(select(User).where(User.login == "trainee03"))
        for index in range(21):
            db.add(
                User(
                    id=uuid4(),
                    login=f"a-trainee03-{index:02}",
                    full_name="Совпадение поиска",
                    role="trainee",
                    password_hash=original.password_hash,
                    dds_service_id=original.dds_service_id,
                )
            )

    run_db(database_url, add)
    response = database_client.get("/api/packs/generation-trainees", params={"login": "trainee03"})
    assert response.status_code == 200
    assert len(response.json()) == 20
    assert response.json()[0]["login"] == "trainee03"


def test_repeated_approval_without_changes_preserves_version(database_client, scenario):
    headers = login(database_client)
    created = database_client.post("/api/scenarios", json=scenario, headers=headers).json()
    path = f"/api/scenarios/{created['id']}"
    approved = database_client.put(path, json={**created, "status": "approved"}, headers=headers)
    assert approved.status_code == 200, approved.text
    saved = approved.json()
    assert saved["version"] == created["version"] + 1
    for _ in range(2):
        repeated = database_client.put(path, json=saved, headers=headers)
        assert repeated.status_code == 200, repeated.text
        assert repeated.json() == saved
    changed = database_client.put(
        path, json={**saved, "teacher_comment": "Новые замечания"}, headers=headers
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["version"] == saved["version"] + 1


def test_training_exercises_hidden_and_protected(database_client, database_url):
    from .test_c04_completion import seed_training

    seed_training(database_url)
    from app.core.training_exercises import TRAINING_EXERCISE_IDS

    headers = login(database_client)
    visible = database_client.get("/api/scenarios").json()
    assert not ({UUID(row["id"]) for row in visible} & TRAINING_EXERCISE_IDS)
    for scenario_id in TRAINING_EXERCISE_IDS:
        path = f"/api/scenarios/{scenario_id}"
        source = database_client.get(path)
        assert source.status_code == 200
        assert database_client.put(path, json=source.json(), headers=headers).status_code == 409
        assert database_client.post(f"{path}/retire", headers=headers).status_code == 409
        assert database_client.get(path).json() == source.json()


def test_seed_restores_only_archived_training_exercise(database_url, database_config):
    from .test_c04_completion import seed_training

    seed_training(database_url)
    from app.api.sessions.practice import tutorial_scenario_id
    from app.seed.training import seed_audio_demo

    async def check(db):
        row = await db.get(Scenario, tutorial_scenario_id("102"))
        old_version = row.version
        row.status = "retired"
        await db.flush()
        await seed_audio_demo(db, database_config.information_audio_dir)
        assert row.status == "approved"
        assert row.version == old_version + 1
        await seed_audio_demo(db, database_config.information_audio_dir)
        assert row.version == old_version + 1

    run_db(database_url, check)


def test_approval_without_required_call(database_client, scenario):
    headers = login(database_client)
    scenario["reference"]["expected_call"] = {
        "required": False,
        "service_id": scenario["target_service_id"],
        "phone_ext": "112",
        "before_s": 180,
    }
    created = database_client.post("/api/scenarios", json=scenario, headers=headers)
    assert created.status_code == 201, created.text
    value = created.json()
    approved = database_client.put(
        f"/api/scenarios/{value['id']}",
        json={**value, "status": "approved"},
        headers=headers,
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["reference"]["expected_call"]["required"] is False


def test_generation_search_matches_names_and_returns_only_active_trainees(
    database_client, database_url
):
    ids = [uuid4() for _ in range(3)]
    logins = [f"name-search-{id.hex[:12]}" for id in ids]
    full_name = "Поисковый Артём Проверочный"

    async def create(db):
        original = await db.scalar(select(User).where(User.login == "trainee03"))
        for index, id in enumerate(ids):
            db.add(
                User(
                    id=id,
                    login=logins[index],
                    full_name=full_name,
                    role="teacher" if index == 2 else "trainee",
                    is_active=index != 1,
                    password_hash=original.password_hash,
                    dds_service_id=original.dds_service_id,
                )
            )

    async def clean(db):
        await db.execute(delete(User).where(User.id.in_(ids)))

    run_db(database_url, create)
    try:
        login(database_client)
        for query in (full_name, "артём", "поисковый", logins[0]):
            response = database_client.get(
                "/api/packs/generation-trainees", params={"login": query}
            )
            assert response.status_code == 200, response.text
            found = response.json()
            found_ids = {user["id"] for user in found}
            assert str(ids[0]) in found_ids
            assert not found_ids.intersection({str(ids[1]), str(ids[2])})
            matched = next(user for user in found if user["id"] == str(ids[0]))
            assert matched["full_name"] == full_name
            assert matched["login"] == logins[0]
        assert (
            database_client.get(
                "/api/packs/generation-trainees", params={"login": "Поисковый%"}
            ).json()
            == []
        )
    finally:
        run_db(database_url, clean)


@pytest.mark.parametrize(
    ("origin", "metadata", "manual"),
    [
        ("template", None, True),
        ("template", {"constructor": {}}, False),
        ("llm", None, False),
        ("imported", None, False),
        ("trainee", None, True),
    ],
)
def test_manual_flag_is_server_owned(
    database_client, database_url, scenario, origin, metadata, manual
):
    headers = login(database_client)
    scenario.update(origin=origin, is_manual=False)
    response = database_client.post("/api/scenarios", json=scenario, headers=headers)
    assert response.status_code == 201, response.text
    sid = response.json()["id"]

    async def set_metadata(db):
        row = await db.get(Scenario, UUID(sid))
        row.generation_metadata = metadata

    run_db(database_url, set_metadata)
    saved = database_client.get(f"/api/scenarios/{sid}").json()
    assert saved["is_manual"] is manual
    saved["is_manual"] = not manual
    updated = database_client.put(f"/api/scenarios/{sid}", json=saved, headers=headers)
    assert updated.status_code == 200, updated.text
    assert updated.json()["is_manual"] is manual
    listed = next(s for s in database_client.get("/api/scenarios").json() if s["id"] == sid)
    assert listed["is_manual"] is manual
