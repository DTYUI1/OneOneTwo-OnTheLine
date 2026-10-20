"""Каталог сценариев обучаемого (17.10): все проработанные сценарии — с событиями и
ветками — и тренировка выбранного сценария за диспетчера его службы."""

import json
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.api.sessions.practice import (
    file_titles,
    needs_teacher_contact,
    parallel_scenario_id,
    practice_candidate,
    tutorial_scenario_id,
)
from app.core.config import ROOT
from app.core.contracts import validate_json
from app.core.models import Assignment, Scenario, ScenarioTrainingPlan
from app.seed.scenarios import file_scenario_id
from evalcore.defaults import DEFAULT_PHONE_CONTACTS
from fastapi.testclient import TestClient
from sqlalchemy import select

from .test_c04_completion import seed_training
from .test_lifecycle import login, run_db
from .test_progress import issued

TRAINEE = "trainee03"
# Бытовой сценарий ЖКХ со звонком заявителю (HQ-019): номер карточки.
HOUSEHOLD_CARD = "70008501"
EVENT_KINDS = {"clarify", "request_service", "silence", "alarm", "readback_error"}
SERVICES = [item["id"] for item in json.loads((ROOT / "data/phonebook.json").read_text("utf-8"))]


def scenario_rows(database_url: str) -> dict[UUID, tuple[Scenario, dict | None]]:
    """Все сценарии базы с планом текущей версии (или None)."""

    async def read(db):
        rows: dict[UUID, tuple[Scenario, dict | None]] = {}
        for scenario in await db.scalars(select(Scenario)):
            plan = await db.scalar(
                select(ScenarioTrainingPlan.plan)
                .where(
                    ScenarioTrainingPlan.scenario_id == scenario.id,
                    ScenarioTrainingPlan.scenario_version <= scenario.version,
                )
                .order_by(ScenarioTrainingPlan.scenario_version.desc())
                .limit(1)
            )
            rows[scenario.id] = (scenario, plan)
        return rows

    return run_db(database_url, read)


def set_status(database_url: str, scenario_id: UUID, status: str) -> None:
    async def write(db):
        (await db.get(Scenario, scenario_id)).status = status

    run_db(database_url, write)


def catalog(client: TestClient) -> list[dict]:
    response = client.get("/api/practice/catalog")
    assert response.status_code == 200, response.text
    return response.json()


def test_catalog_lists_only_worked_out_scenarios(database_config, database_url):
    seed_training(database_url)
    rows = scenario_rows(database_url)
    with TestClient(create_database_app(database_config)) as client:
        login(client, TRAINEE)
        items = catalog(client)
    assert items
    ids = {UUID(item["id"]) for item in items}
    for item in items:
        validate_json(item, "urn:openapi#/components/schemas/PracticeScenario")
        scenario, plan = rows[UUID(item["id"])]
        assert scenario.status == "approved"
        assert practice_candidate(scenario)
        assert plan is not None and plan.get("events"), item["title"]
        assert item["trains"] and set(item["trains"]) <= EVENT_KINDS
        assert len(item["trains"]) == len(set(item["trains"]))
        assert item["service_id"] == scenario.target_service_id
        assert item["level"] == scenario.level
        assert item["description"]
    # Названия — из файлов data/scenarios: в базе их нет.
    titles = file_titles()
    assert any(titles.get(UUID(item["id"])) == item["title"] for item in items)
    # Линейные (без событий), снятые с выдачи, упражнения и параллельная смена — не в каталоге.
    linear = [sid for sid, (_, plan) in rows.items() if plan and not plan.get("events")]
    assert linear and not ids & set(linear)
    retired = {sid for sid, (scenario, _) in rows.items() if scenario.status == "retired"}
    assert not ids & retired
    for service in SERVICES:
        assert tutorial_scenario_id(service) not in ids
        assert parallel_scenario_id(service) not in ids
    # Порядок — служба, уровень, название.
    keys = [(item["service_id"], item["level"], item["title"]) for item in items]
    assert keys == sorted(keys)


def test_catalog_is_identical_for_trainee_and_teacher(database_config, database_url):
    seed_training(database_url)
    with TestClient(create_database_app(database_config)) as client:
        login(client, TRAINEE)
        trainee_catalog = catalog(client)
        login(client, "teacher")
        assert catalog(client) == trainee_catalog
        scenarios_response = client.get("/api/scenarios")
        assert scenarios_response.status_code == 200, scenarios_response.text
        scenarios = {item["id"]: item for item in scenarios_response.json()}
        assert trainee_catalog
        assert {item["id"] for item in trainee_catalog} < scenarios.keys()
        for item in trainee_catalog:
            scenario = scenarios[item["id"]]
            assert scenario["status"] == "approved"
            assert scenario["version"] == item["version"]
            assert scenario["target_service_id"] == item["service_id"]
            assert scenario["level"] == item["level"]
            assert "reference" not in item
        lift = next(
            item
            for item in trainee_catalog
            if scenarios[item["id"]]["card"]["number"] == "70008602"
        )
        assert lift["id"] == str(file_scenario_id("lift-location-moslift-2"))
        assert lift["version"] == 2
        assert lift["title"] == "Застрявший лифт: уточнить подъезд и кабину"
        call = scenarios[lift["id"]]["reference"]["expected_call"]
        assert call["required"] is True
        assert call["contact_role"] == "caller"


def test_start_practice_with_catalog_scenario(database_config, database_url):
    seed_training(database_url)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        own = client.get("/api/auth/me").json()["dds_service_id"]
        items = catalog(client)
        # Сценарий чужой службы: обучаемый на тренировке — диспетчер службы сценария.
        chosen = next((item for item in items if item["service_id"] != own), items[0])
        response = client.post(f"/api/practice?scenario={chosen['id']}", headers=headers)
        assert response.status_code == 200, response.text
        session = response.json()
        validate_json(session, "urn:openapi#/components/schemas/Session")
        assert session["kind"] == "practice"
        assert session["title"] == f"Тренировка по каталогу: {chosen['title']}"
        settings = session["settings_snapshot"]
        assert settings["hints_level"] == 0
        assert settings["spelling_hints"] is True
        assert settings["parallel_cards"] == 1
        [participant] = session["participants"]
        assert participant["dds_service_id"] == chosen["service_id"]
        assert participant["level"] == chosen["level"]
        [(level, tutorial, service)] = issued(database_url, session["id"])
        assert (level, tutorial, service) == (chosen["level"], False, chosen["service_id"])
        # Следующая тренировка закрывает прежнюю — как у ступеней.
        again = client.post(f"/api/practice?scenario={chosen['id']}", headers=headers)
        assert again.status_code == 200, again.text
        sessions = {item["id"]: item for item in client.get("/api/sessions").json()}
        assert sessions[session["id"]]["status"] == "finished"


def test_start_practice_rejects_bad_scenario(database_config, database_url):
    seed_training(database_url)
    rows = scenario_rows(database_url)
    linear = next(
        sid
        for sid, (scenario, plan) in rows.items()
        if scenario.status == "approved" and plan and not plan.get("events")
    )
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        chosen = catalog(client)[0]
        both = client.post(f"/api/practice?step=1&scenario={chosen['id']}", headers=headers)
        assert both.status_code == 422, both.text
        repeat_and_catalog = client.post(
            f"/api/practice?scenario_id={chosen['id']}&scenario={chosen['id']}", headers=headers
        )
        assert repeat_and_catalog.status_code == 422, repeat_and_catalog.text
        missing = client.post(f"/api/practice?scenario={uuid4()}", headers=headers)
        assert missing.status_code == 404
        assert missing.json()["code"] == "scenario_not_found"
        for outside in (linear, tutorial_scenario_id("101")):
            response = client.post(f"/api/practice?scenario={outside}", headers=headers)
            assert response.status_code == 409, response.text
            assert response.json()["code"] == "scenario_not_in_catalog"
        assert client.post("/api/practice?scenario=nope", headers=headers).status_code == 422
        # Снятый с выдачи сценарий пропадает из каталога и не запускается.
        retired = UUID(chosen["id"])
        set_status(database_url, retired, "retired")
        try:
            assert retired not in {UUID(item["id"]) for item in catalog(client)}
            response = client.post(f"/api/practice?scenario={retired}", headers=headers)
            assert response.status_code == 409
        finally:
            set_status(database_url, retired, "approved")


def household_scenario(database_url: str) -> Scenario:
    """Бытовой сценарий со звонком заявителю («Котёнок в вентиляционной шахте») текущей версии."""
    found = [
        scenario
        for scenario, _ in scenario_rows(database_url).values()
        if scenario.status == "approved"
        and str((scenario.card or {}).get("number")) == HOUSEHOLD_CARD
    ]
    assert found, HOUSEHOLD_CARD
    return max(found, key=lambda item: item.version)


def test_catalog_offers_caller_scenario_and_adds_him_to_phone(database_config, database_url):
    """Сценарий со звонком заявителю — в каталоге, и тренировка сама даёт номер заявителя.

    Преподавателя в тренировке нет, поэтому абонент «Заявитель» появляется в телефоне ДДС
    службы сценария (HQ-019, `practice_phone_contacts`); у других служб список прежний."""
    seed_training(database_url)
    scenario = household_scenario(database_url)
    assert needs_teacher_contact(scenario)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        items = {UUID(item["id"]): item for item in catalog(client)}
        assert scenario.id in items, "сценарий со звонком заявителю — в каталоге"
        assert "clarify" in items[scenario.id]["trains"]
        response = client.post(f"/api/practice?scenario={scenario.id}", headers=headers)
        assert response.status_code == 200, response.text
        session = response.json()
        validate_json(session, "urn:openapi#/components/schemas/Session")
        contacts = session["settings_snapshot"]["phone_contacts"]
        assert set(contacts) == {scenario.target_service_id}
        own = contacts[scenario.target_service_id]
        assert [item["role"] for item in own[:-1]] == [
            item["role"] for item in DEFAULT_PHONE_CONTACTS
        ]
        assert own[-1] == {"role": "caller", "name": "Заявитель", "number": "405"}
        # Характер не задан: его берут из сценария.
        assert "character" not in own[-1]
        # Выдан он сам, за диспетчера своей службы (характер заявителя — из сценария,
        # `test_caller_line`).
        assert issued(database_url, session["id"]) == [
            (scenario.level, False, scenario.target_service_id)
        ]


def test_soft_deleted_approved_scenario_is_unavailable_in_catalog(database_config, database_url):
    seed_training(database_url)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        before = catalog(client)
        chosen = before[0]
        sessions_before = client.get("/api/sessions").json()

        async def mark_deleted(db):
            scenario = await db.get(Scenario, UUID(chosen["id"]))
            assert scenario.status == "approved" and scenario.deleted_at is None
            scenario.deleted_at = datetime.now(UTC)

        async def restore(db):
            (await db.get(Scenario, UUID(chosen["id"]))).deleted_at = None

        run_db(database_url, mark_deleted)
        try:
            trainee_catalog = catalog(client)
            response = client.post(f"/api/practice?scenario={chosen['id']}", headers=headers)
            sessions_after = client.get("/api/sessions").json()
            login(client, "teacher")
            teacher_catalog = catalog(client)
            studio = client.get("/api/scenarios")
            assert studio.status_code == 200, studio.text
            assert chosen["id"] not in {item["id"] for item in studio.json()}
            assert (
                chosen["id"] in {item["id"] for item in trainee_catalog},
                chosen["id"] in {item["id"] for item in teacher_catalog},
                response.status_code,
            ) == (False, False, 404)
            assert response.json()["code"] == "scenario_not_found"
            assert (
                trainee_catalog
                == teacher_catalog
                == [item for item in before if item["id"] != chosen["id"]]
            )
            assert sessions_after == sessions_before
        finally:
            run_db(database_url, restore)
        assert catalog(client) == before


def test_catalog_requires_login_and_does_not_grant_admin_training_access(database_client):
    assert database_client.get("/api/practice/catalog").status_code == 401
    login(database_client, "admin")
    # Администратор не наследует роль преподавателя (C-07).
    assert database_client.get("/api/practice/catalog").status_code == 403
    assert database_client.get("/api/scenarios").status_code == 403


@pytest.mark.parametrize("role", ["teacher", "admin"])
def test_catalog_access_does_not_grant_practice_start(database_client, role):
    login(database_client, TRAINEE)
    chosen = catalog(database_client)[0]
    headers = login(database_client, role)
    for path in ("/api/practice", f"/api/practice?scenario={chosen['id']}"):
        response = database_client.post(path, headers=headers)
        assert response.status_code == 403, response.text


def test_every_catalog_scenario_can_be_assigned_by_teacher(
    database_client, database_url, clean_generated_content
):
    client = database_client
    headers = login(client, "teacher")
    items = catalog(client)
    users = client.get("/api/users")
    assert users.status_code == 200, users.text
    trainee = next(user for user in users.json() if user["login"] == TRAINEE)
    settings = client.get("/api/settings")
    assert settings.status_code == 200, settings.text
    session_ids = []
    assigned = []
    for service_id in sorted({item["service_id"] for item in items}):
        created = client.post(
            "/api/sessions",
            headers=headers,
            json={
                "title": "Проверка общего каталога",
                "participants": [
                    {
                        "user_id": trainee["id"],
                        "workstation_number": 1,
                        "dds_service_id": service_id,
                        "level": 1,
                    }
                ],
                "settings_snapshot": settings.json(),
            },
        )
        assert created.status_code == 201, created.text
        session_id = created.json()["id"]
        session_ids.append(UUID(session_id))
        response = client.post(
            f"/api/sessions/{session_id}/assignments/batch",
            headers=headers,
            json={
                "request_id": str(uuid4()),
                "items": [
                    {
                        "participant_id": trainee["id"],
                        "scenario_id": item["id"],
                        "scenario_version": item["version"],
                        "order": order,
                        "delay_from_start_s": 0,
                        "delivery_mode": "profile",
                    }
                    for order, item in enumerate(
                        (item for item in items if item["service_id"] == service_id), start=1
                    )
                ],
            },
        )
        assert response.status_code == 201, response.text
        saved = client.get(f"/api/sessions/{session_id}/assignment-batches")
        assert saved.status_code == 200, saved.text
        assert saved.json() == [response.json()]
        assigned.extend(saved.json()[0]["assignments"])
    expected = {(item["id"], item["version"]) for item in items}
    assert len(assigned) == len(items) == len(expected)
    assert {(item["scenario_id"], item["scenario_version"]) for item in assigned} == expected

    async def pinned_versions(db):
        return [
            (str(row.scenario_id), row.scenario_version)
            for row in await db.scalars(
                select(Assignment).where(Assignment.session_id.in_(session_ids))
            )
        ]

    persisted = run_db(database_url, pinned_versions)
    assert len(persisted) == len(items)
    assert set(persisted) == expected
