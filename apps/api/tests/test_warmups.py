"""Разминка (DT-09): результат сохраняет обучаемый; видят он сам и преподаватель."""

from app.core.contracts import validate_json
from app.core.models import AuditLog
from sqlalchemy import select

from .test_database import csrf, login, run_db

RESULT = {
    "kind": "address",
    "correct": 8,
    "total": 10,
    "duration_ms": 74000,
    "mistakes": ["ул. Дубнинская, д. 32 / ул. Дубининская, д. 32"],
}


def test_trainee_saves_own_results_teacher_sees_all(database_client, database_url):
    client = database_client
    saved = {}
    for name, kind in (("trainee01", "address"), ("trainee02", "routing")):
        login(client, name)
        response = client.post("/api/warmups", json={**RESULT, "kind": kind}, headers=csrf(client))
        assert response.status_code == 201, response.text
        validate_json(response.json(), "urn:openapi#/components/schemas/WarmupResult")
        saved[name] = response.json()
    assert saved["trainee01"]["kind"] == "address"
    assert saved["trainee01"]["mistakes"] == RESULT["mistakes"]

    # Обучаемый видит только свои результаты.
    login(client, "trainee01")
    own = client.get("/api/warmups")
    assert own.status_code == 200, own.text
    assert {item["trainee_id"] for item in own.json()} == {saved["trainee01"]["trainee_id"]}
    assert own.json()[0]["id"] == saved["trainee01"]["id"]

    # Преподаватель — всех обучаемых, свежие сверху.
    login(client, "teacher")
    listed = client.get("/api/warmups")
    assert listed.status_code == 200, listed.text
    ids = [item["id"] for item in listed.json()]
    assert ids.index(saved["trainee02"]["id"]) < ids.index(saved["trainee01"]["id"])
    for item in listed.json():
        validate_json(item, "urn:openapi#/components/schemas/WarmupResult")
    # Разминка — учебное упражнение обучаемого: преподаватель результат не пишет.
    assert client.post("/api/warmups", json=RESULT, headers=csrf(client)).status_code == 403

    # Администратору учебные данные не нужны (ТЗ, C-07).
    login(client, "admin")
    assert client.get("/api/warmups").status_code == 403

    async def audit(db):
        return await db.scalar(
            select(AuditLog).where(AuditLog.entity_id == saved["trainee01"]["id"])
        )

    record = run_db(database_url, audit)
    assert record.action == "createWarmupResult"
    assert record.entity == "warmup_result"
    assert record.after == {"kind": "address", "correct": 8}


def test_result_is_validated_and_needs_csrf(database_client):
    client = database_client
    login(client, "trainee01")
    headers = csrf(client)
    for body in (
        {**RESULT, "correct": 11},
        {**RESULT, "total": 0},
        {**RESULT, "kind": "status"},
        {**RESULT, "duration_ms": -1},
        {**RESULT, "mistakes": ["x"] * 51},
        {**RESULT, "mistakes": [""]},
        {**RESULT, "extra": True},
        {key: value for key, value in RESULT.items() if key != "mistakes"},
    ):
        response = client.post("/api/warmups", json=body, headers=headers)
        assert response.status_code == 422, (body, response.text)
    assert client.post("/api/warmups", json=RESULT).status_code == 403
    client.cookies.clear()
    assert client.post("/api/warmups", json=RESULT).status_code == 401
