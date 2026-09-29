"""C-07, NFR-12: администратор включает и выключает службы ДДС.

Выключенная служба не попадает в новые занятия и пакеты; пока она участвует в идущем
занятии, выключить её нельзя — это было бы вмешательство в учебный процесс (ТЗ).
"""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from app.api.catalog.service import running_sessions_with
from app.core.contracts import validate_json
from app.core.db import Database
from app.core.models import AuditLog, Session
from sqlalchemy import func, select, update


def headers_for(client, name):
    response = client.post("/api/auth/login", json={"login": name, "password": "test-password"})
    assert response.status_code == 200, response.text
    return {
        "cookie": "; ".join(f"{key}={value}" for key, value in client.cookies.items()),
        "X-CSRF-Token": client.cookies["csrf"],
    }


def run_db(url, action):
    async def run():
        database = Database(url)
        try:
            async with database.sessions.begin() as db:
                return await action(db)
        finally:
            await database.close()

    return asyncio.run(run())


def toggle(client, headers, service_id, active):
    return client.put(f"/api/services/{service_id}", json={"is_active": active}, headers=headers)


def lesson_body(client, headers, service_id):
    users = {item["login"]: item for item in client.get("/api/users", headers=headers).json()}
    return {
        "title": f"Службы {uuid4()}",
        "participants": [
            {
                "user_id": users["trainee02"]["id"],
                "workstation_number": 2,
                "dds_service_id": service_id,
                "level": 1,
            }
        ],
        "settings_snapshot": client.get("/api/settings", headers=headers).json(),
    }


def test_admin_disables_and_enables_service(database_client, database_url):
    client = database_client
    admin = headers_for(client, "admin")
    off = toggle(client, admin, "MOSLIFT", False)
    assert off.status_code == 200, off.text
    validate_json(off.json(), "urn:openapi#/components/schemas/Service")
    assert off.json()["is_active"] is False
    listed = {item["id"]: item for item in client.get("/api/services", headers=admin).json()}
    assert listed["MOSLIFT"]["is_active"] is False
    try:
        teacher = headers_for(client, "teacher")
        lesson = client.post(
            "/api/sessions", json=lesson_body(client, teacher, "MOSLIFT"), headers=teacher
        )
        assert lesson.status_code == 422, lesson.text
        pack = client.post(
            "/api/packs/generate",
            json={"count": 1, "level": 1, "service_id": "MOSLIFT", "seed": 1},
            headers=teacher,
        )
        assert pack.status_code == 422, pack.text
    finally:
        admin = headers_for(client, "admin")
        on = toggle(client, admin, "MOSLIFT", True)
    assert on.status_code == 200 and on.json()["is_active"] is True

    async def audit(db):
        rows = (
            await db.scalars(
                select(AuditLog)
                .where(AuditLog.action == "updateService", AuditLog.entity_id == "MOSLIFT")
                .order_by(AuditLog.ts)
            )
        ).all()
        assert [row.after for row in rows[-2:]] == [{"is_active": False}, {"is_active": True}]
        assert rows[-2].before == {"is_active": True}

    run_db(database_url, audit)


def test_only_admin_toggles_and_input_is_strict(database_client):
    client = database_client
    for name in ("teacher", "trainee01"):
        assert toggle(client, headers_for(client, name), "GKH", False).status_code == 403
    admin = headers_for(client, "admin")
    assert toggle(client, admin, "NOPE", False).status_code == 404
    extra = client.put(
        "/api/services/GKH", json={"is_active": False, "name": "Другое"}, headers=admin
    )
    assert extra.status_code == 422
    assert (
        client.put("/api/services/GKH", json={"is_active": "no"}, headers=admin).status_code == 422
    )
    listed = {item["id"]: item for item in client.get("/api/services", headers=admin).json()}
    assert listed["GKH"]["is_active"] is True


def test_service_in_running_lesson_cannot_be_disabled(database_client, database_url):
    client = database_client
    teacher = headers_for(client, "teacher")
    scenario = next(
        item
        for item in client.get("/api/scenarios", headers=teacher).json()
        if item["status"] == "approved"
    )

    async def finish_leftovers(db):
        # БД общая для всех тестов: занятия, не завершённые другими тестами, тоже держат службы.
        busy = await running_sessions_with(db, "104")
        busy |= await running_sessions_with(db, scenario["target_service_id"])
        if busy:
            await db.execute(
                update(Session)
                .where(Session.id.in_(busy))
                .values(status="finished", finished_at=func.now())
            )

    run_db(database_url, finish_leftovers)
    body = lesson_body(client, teacher, "104")
    lesson = client.post("/api/sessions", json=body, headers=teacher)
    assert lesson.status_code == 201, lesson.text
    lesson_id = lesson.json()["id"]
    assigned = client.post(
        f"/api/sessions/{lesson_id}/assignments",
        headers=teacher,
        json={
            "participant_id": body["participants"][0]["user_id"],
            "scenario_id": scenario["id"],
            "order": 1,
            "planned_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
        },
    )
    assert assigned.status_code == 201, assigned.text
    assert client.post(f"/api/sessions/{lesson_id}/start", headers=teacher).status_code == 200

    admin = headers_for(client, "admin")
    busy = toggle(client, admin, "104", False)
    assert busy.status_code == 409, busy.text
    assert busy.json()["code"] == "service_in_use"
    assert busy.json()["details"]["sessions"] >= 1
    # Адресат выданного сценария тоже нужен идущему занятию.
    target = toggle(client, admin, scenario["target_service_id"], False)
    assert target.status_code == 409, target.text

    teacher = headers_for(client, "teacher")
    finished = client.post(
        f"/api/sessions/{lesson_id}/finish",
        headers=teacher,
        json={"contract_version": 2, "request_id": str(uuid4())},
    )
    assert finished.status_code == 200, finished.text
    admin = headers_for(client, "admin")
    after = toggle(client, admin, "104", False)
    assert after.status_code == 200, after.text
    assert toggle(client, admin, "104", True).status_code == 200
