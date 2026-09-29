"""Проверка HTTP-каталога на PostgreSQL, включая изменения после seed."""

import asyncio
from uuid import uuid4

import pytest
from app.core.config import ROOT
from app.core.contracts import read_json, validate_json
from app.core.db import Database
from app.core.models import IncidentType, ScenarioPack, ScenarioPackItem, Service
from sqlalchemy import delete, select, update

PATHS = ["/api/services", "/api/incident-types", "/api/packs"]


def login(client, name="admin"):
    response = client.post("/api/auth/login", json={"login": name, "password": "test-password"})
    assert response.status_code == 200, response.text


def run_db(url, action):
    async def run():
        database = Database(url)
        try:
            async with database.sessions.begin() as db:
                return await action(db)
        finally:
            await database.close()

    return asyncio.run(run())


@pytest.mark.parametrize("path", PATHS)
def test_catalog_requires_login(database_client, path):
    assert database_client.get(path).status_code == 401


@pytest.mark.parametrize("role", ["trainee01", "teacher", "admin"])
def test_catalog_roles_and_seeded_responses(database_client, role):
    client = database_client
    login(client, role)
    services = client.get("/api/services")
    assert services.status_code == 200
    assert services.json() == sorted(
        read_json("data/phonebook.json"), key=lambda item: item["code"]
    )
    for item in services.json():
        validate_json(item, "urn:openapi#/components/schemas/Service")

    incidents = client.get("/api/incident-types")
    assert incidents.status_code == 200
    expected = [
        {key: row[key] for key in ("code", "name", "group_name", "main_service_code")}
        for row in read_json("data/classifier.json")["incident_types"]
    ]
    assert incidents.json() == sorted(expected, key=lambda item: item["code"])
    assert len(incidents.json()) == 1283
    assert "raw" not in incidents.json()[0]
    validate_json(incidents.json()[0], "urn:openapi#/components/schemas/IncidentType")

    packs = client.get("/api/packs")
    # Пакеты сценариев — учебный контент преподавателя; администратору не нужны (C-07).
    if role in {"trainee01", "admin"}:
        assert packs.status_code == 403
        return
    assert packs.status_code == 200
    expected_packs = [
        read_json(path.relative_to(ROOT).as_posix())
        for path in (ROOT / "data/packs").glob("*.json")
    ]
    assert packs.json() == sorted(expected_packs, key=lambda item: item["id"])
    for item in packs.json():
        validate_json(item, "urn:openapi#/components/schemas/Pack")


def test_catalog_reads_current_database_values(database_client, database_url):
    client = database_client
    login(client)
    original = next(row for row in client.get("/api/services").json() if row["id"] == "101")
    incident_code = "0000000"

    async def change(db):
        await db.execute(
            update(Service)
            .where(Service.id == "101")
            .values(
                name="Переименованная учебная служба",
                is_active=False,
            )
        )
        example = await db.scalar(select(IncidentType).limit(1))
        values = {
            column.name: getattr(example, column.name) for column in IncidentType.__table__.columns
        }
        values.update(code=incident_code, name="Новый учебный тип", raw={"private": "internal"})
        db.add(IncidentType(**values))

    async def restore(db):
        await db.execute(
            update(Service)
            .where(Service.id == "101")
            .values(
                name=original["name"],
                is_active=original["is_active"],
            )
        )
        await db.execute(delete(IncidentType).where(IncidentType.code == incident_code))

    run_db(database_url, change)
    try:
        services = client.get("/api/services").json()
        changed = next(row for row in services if row["id"] == "101")
        assert changed["name"] == "Переименованная учебная служба"
        assert changed["is_active"] is False
        incidents = client.get("/api/incident-types").json()
        assert incidents[0]["code"] == incident_code
        assert incidents[0]["name"] == "Новый учебный тип"
        assert set(incidents[0]) == {"code", "name", "group_name", "main_service_code"}
        assert "X-Mock-Response" not in client.get("/api/services").headers
    finally:
        run_db(database_url, restore)


def test_packs_preserve_item_order_and_empty_packs(database_client, database_url):
    client = database_client
    login(client, "teacher")
    scenario_ids = client.get("/api/packs").json()[0]["scenario_ids"]
    # UUID-порядок отличается от порядка назначения; пустой пакет не должен исчезать при JOIN.
    ordered = [scenario_ids[2], scenario_ids[0], scenario_ids[1]]
    filled_id, empty_id = uuid4(), uuid4()

    async def insert(db):
        db.add_all(
            [
                ScenarioPack(
                    id=filled_id, title="Порядок сценариев", status="draft", origin="imported"
                ),
                ScenarioPack(id=empty_id, title="Пустой пакет", status="retired", origin="llm"),
            ]
        )
        await db.flush()
        for index, scenario_id in enumerate(ordered):
            db.add(ScenarioPackItem(pack_id=filled_id, scenario_id=scenario_id, order=index * 10))

    async def remove(db):
        await db.execute(delete(ScenarioPackItem).where(ScenarioPackItem.pack_id == filled_id))
        await db.execute(delete(ScenarioPack).where(ScenarioPack.id.in_([filled_id, empty_id])))

    run_db(database_url, insert)
    try:
        response = client.get("/api/packs")
        assert response.status_code == 200
        packs = response.json()
        assert [pack["id"] for pack in packs] == sorted(pack["id"] for pack in packs)
        by_id = {pack["id"]: pack for pack in packs}
        assert by_id[str(filled_id)]["scenario_ids"] == ordered
        assert by_id[str(filled_id)]["status"] == "draft"
        assert by_id[str(empty_id)]["scenario_ids"] == []
        assert by_id[str(empty_id)]["status"] == "retired"
        assert all(
            set(pack) == {"id", "title", "status", "scenario_ids", "origin"} for pack in packs
        )
    finally:
        run_db(database_url, remove)
