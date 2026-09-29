"""C-07: журнал аудита для администратора — чтение, фильтры, постраничность и границы.

ТЗ: администратор просматривает системные журналы и ведёт аудит безопасности, но не
получает результаты обучаемых без необходимости — поэтому у учебных записей видно только
действие, без содержимого.
"""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from app.core.contracts import validate_json

PASSWORD = "audit-pass-2026"


def headers_for(client, name, password="test-password"):
    response = client.post("/api/auth/login", json={"login": name, "password": password})
    assert response.status_code == 200, response.text
    return {
        "cookie": "; ".join(f"{key}={value}" for key, value in client.cookies.items()),
        "X-CSRF-Token": client.cookies["csrf"],
    }


def page(client, headers, **params):
    response = client.get("/api/audit", params=params, headers=headers)
    assert response.status_code == 200, response.text
    validate_json(response.json(), "urn:openapi#/components/schemas/AuditPage")
    return response.json()


def create_user(client, admin):
    body = {
        "login": f"au{uuid4().hex[:10]}",
        "full_name": "Проверка журнала",
        "role": "trainee",
        "password": PASSWORD,
        "workstation_number": 5,
        "dds_service_id": "102",
    }
    response = client.post("/api/users", json=body, headers=admin)
    assert response.status_code == 201, response.text
    return response.json()


def test_admin_actions_are_visible_with_changes(database_client):
    client = database_client
    admin = headers_for(client, "admin")
    user = create_user(client, admin)
    blocked = client.put(
        f"/api/users/{user['id']}",
        json={
            "full_name": user["full_name"],
            "role": "trainee",
            "workstation_number": 5,
            "dds_service_id": "102",
            "is_active": False,
        },
        headers=admin,
    )
    assert blocked.status_code == 200
    result = page(client, admin, category="admin", limit=10)
    assert result["oldest_ts"] is not None and result["total"] >= 2
    stamps = [item["ts"] for item in result["items"]]
    assert stamps == sorted(stamps, reverse=True)
    mine = [item for item in result["items"] if item["entity_id"] == user["id"]]
    update, create = mine[0], mine[1]
    assert create["action"] == "createUser" and create["category"] == "admin"
    assert create["before"] is None and create["after"]["login"] == user["login"]
    assert create["actor"]["login"] == "admin" and create["ok"] is True
    assert update["action"] == "updateUser"
    assert update["before"]["is_active"] is True and update["after"]["is_active"] is False
    reset = client.post(
        f"/api/users/{user['id']}/password", json={"password": "another-2026"}, headers=admin
    )
    assert reset.status_code == 200
    everything = client.get("/api/audit", params={"limit": 200}, headers=admin).text
    assert PASSWORD not in everything and "another-2026" not in everything
    assert "password_hash" not in everything


def test_training_content_is_hidden_from_admin(database_client):
    client = database_client
    teacher = headers_for(client, "teacher")
    users = {item["login"]: item for item in client.get("/api/users", headers=teacher).json()}
    lesson = client.post(
        "/api/sessions",
        headers=teacher,
        json={
            "title": f"Журнал {uuid4()}",
            "participants": [
                {
                    "user_id": users["trainee01"]["id"],
                    "workstation_number": 1,
                    "dds_service_id": "102",
                    "level": 1,
                }
            ],
            "settings_snapshot": client.get("/api/settings", headers=teacher).json(),
        },
    )
    assert lesson.status_code == 201
    admin = headers_for(client, "admin")
    training = page(client, admin, category="training", limit=50)["items"]
    created = next(item for item in training if item["entity_id"] == lesson.json()["id"])
    assert created["action"] == "createSession" and created["actor"]["login"] == "teacher"
    assert created["before"] is None and created["after"] is None
    assert "Журнал" not in str(training)


def test_failed_login_points_to_the_account(database_client):
    client = database_client
    admin = headers_for(client, "admin")
    user = create_user(client, admin)
    since = (datetime.now(UTC) - timedelta(seconds=5)).isoformat()
    for login in (user["login"], f"nobody{uuid4().hex[:6]}"):
        denied = client.post("/api/auth/login", json={"login": login, "password": "wrong-pass"})
        assert denied.status_code == 401
    admin = headers_for(client, "admin")
    failed = page(client, admin, category="access", result="error", since=since)["items"]
    assert all(item["ok"] is False and item["status_code"] == 401 for item in failed)
    assert all(item["actor"] is None and item["action"] == "login" for item in failed)
    targets = [item["entity_id"] for item in failed]
    assert user["id"] in targets and None in targets
    assert "wrong-pass" not in str(failed)


def test_filters_and_pages_do_not_overlap(database_client):
    client = database_client
    admin = headers_for(client, "admin")
    me = client.get("/api/auth/me", headers=admin).json()
    for _ in range(3):
        create_user(client, admin)
    own = page(client, admin, actor_id=me["id"], category="admin", limit=2)
    assert len(own["items"]) == 2 and own["next_cursor"] is not None
    assert all(item["actor"]["id"] == me["id"] for item in own["items"])
    following = page(
        client, admin, actor_id=me["id"], category="admin", limit=2, cursor=own["next_cursor"]
    )
    first_ids = {item["id"] for item in own["items"]}
    assert first_ids.isdisjoint(item["id"] for item in following["items"])
    assert own["items"][-1]["ts"] >= following["items"][0]["ts"]
    future = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    assert page(client, admin, since=future)["items"] == []
    assert page(client, admin, until=datetime(2000, 1, 1, tzinfo=UTC).isoformat())["total"] == 0
    technical = page(client, admin, category="technical", limit=20)["items"]
    assert all(item["category"] == "technical" for item in technical)


def test_only_admin_reads_and_input_is_checked(database_client):
    client = database_client
    for name in ("teacher", "trainee01"):
        assert client.get("/api/audit", headers=headers_for(client, name)).status_code == 403
    admin = headers_for(client, "admin")
    for params in ({"limit": 0}, {"limit": 201}, {"category": "secret"}, {"cursor": "bad"}):
        assert client.get("/api/audit", params=params, headers=admin).status_code == 422, params
