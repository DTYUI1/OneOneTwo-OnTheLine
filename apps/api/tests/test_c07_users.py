"""C-07: учётные записи администратором — создание, правка, блокировка, сброс пароля.

Реальный PostgreSQL: проверяются права ролей, отзыв уже выданных сессий (HTTP и WebSocket),
защита от самоблокировки и отсутствие пароля в журнале аудита.
"""

import asyncio
from uuid import uuid4

import pytest
from app.api.database import create_database_app
from app.core.contracts import validate_json
from app.core.db import Database
from app.core.models import AuditLog
from fastapi.testclient import TestClient
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

PASSWORD = "class-2026-pass"


def run_db(url, action):
    async def run():
        database = Database(url)
        try:
            async with database.sessions.begin() as db:
                return await action(db)
        finally:
            await database.close()

    return asyncio.run(run())


def headers_for(client: TestClient, name: str, password: str = "test-password") -> dict:
    """Войти и вернуть cookie+CSRF этого пользователя: в одном клиенте живут несколько ролей."""
    response = client.post("/api/auth/login", json={"login": name, "password": password})
    assert response.status_code == 200, response.text
    return {
        "cookie": "; ".join(f"{key}={value}" for key, value in client.cookies.items()),
        "X-CSRF-Token": client.cookies["csrf"],
    }


def new_login(prefix: str = "t") -> str:
    return f"{prefix}{uuid4().hex[:10]}"


def create(client: TestClient, admin: dict, **fields) -> dict:
    body = {
        "login": new_login(),
        "full_name": "Новый обучаемый",
        "role": "trainee",
        "password": PASSWORD,
        "workstation_number": 7,
        "dds_service_id": "101",
        **fields,
    }
    response = client.post("/api/users", json=body, headers=admin)
    assert response.status_code == 201, response.text
    validate_json(response.json(), "urn:openapi#/components/schemas/User")
    return response.json()


def update_body(user: dict, **changes) -> dict:
    body = {
        key: user[key]
        for key in ("full_name", "role", "workstation_number", "dds_service_id", "is_active")
    }
    return {**body, **changes}


def test_admin_creates_user_who_can_log_in(database_client, database_url):
    client = database_client
    admin = headers_for(client, "admin")
    user = create(client, admin, full_name="  Иванов Иван  ")
    assert user["is_active"] is True and user["full_name"] == "Иванов Иван"
    listed = {item["login"]: item for item in client.get("/api/users", headers=admin).json()}
    assert listed[user["login"]] == user
    assert "password" not in client.get("/api/users", headers=admin).text

    fresh = headers_for(client, user["login"], PASSWORD)
    me = client.get("/api/auth/me", headers=fresh).json()
    assert me["id"] == user["id"] and me["role"] == "trainee"

    async def audit(db):
        row = await db.scalar(
            select(AuditLog).where(
                AuditLog.action == "createUser", AuditLog.entity_id == user["id"]
            )
        )
        assert row is not None and row.after == user
        assert PASSWORD not in str(row.after)

    run_db(database_url, audit)


@pytest.mark.parametrize(
    "changes,status,code",
    [
        ({"login": "Admin"}, 422, "validation_error"),
        ({"login": "ab"}, 422, "validation_error"),
        ({"password": "short"}, 422, "validation_error"),
        ({"full_name": "   "}, 422, "validation_error"),
        ({"role": "teacher"}, 422, "profile_not_allowed"),
        ({"dds_service_id": "999"}, 422, "unknown_service"),
        ({"workstation_number": 24}, 422, "validation_error"),
        ({"unexpected": 1}, 422, "validation_error"),
    ],
)
def test_create_validation(database_client, changes, status, code):
    client = database_client
    admin = headers_for(client, "admin")
    body = {
        "login": new_login(),
        "full_name": "Проверка",
        "role": "trainee",
        "password": PASSWORD,
        "workstation_number": 3,
        "dds_service_id": "102",
        **changes,
    }
    response = client.post("/api/users", json=body, headers=admin)
    assert response.status_code == status, response.text
    assert response.json()["code"] == code


def test_login_is_unique_and_only_admin_manages_users(database_client):
    client = database_client
    admin = headers_for(client, "admin")
    user = create(client, admin)
    duplicate = client.post(
        "/api/users",
        json={
            "login": user["login"],
            "full_name": "Двойник",
            "role": "teacher",
            "password": PASSWORD,
            "workstation_number": None,
            "dds_service_id": None,
        },
        headers=admin,
    )
    assert duplicate.status_code == 409 and duplicate.json()["code"] == "login_taken"
    for name in ("teacher", "trainee01"):
        other = headers_for(client, name)
        body = {
            "login": new_login(),
            "full_name": "Чужой",
            "role": "admin",
            "password": PASSWORD,
            "workstation_number": None,
            "dds_service_id": None,
        }
        assert client.post("/api/users", json=body, headers=other).status_code == 403
        assert (
            client.put(
                f"/api/users/{user['id']}",
                json=update_body(user, is_active=False),
                headers=other,
            ).status_code
            == 403
        )
        assert (
            client.post(
                f"/api/users/{user['id']}/password", json={"password": PASSWORD}, headers=other
            ).status_code
            == 403
        )
    # Без CSRF изменение не проходит и для администратора.
    no_csrf = {"cookie": admin["cookie"]}
    assert (
        client.put(f"/api/users/{user['id']}", json=update_body(user), headers=no_csrf).status_code
        == 403
    )


def test_block_revokes_open_http_and_websocket_sessions(database_client):
    client = database_client
    admin = headers_for(client, "admin")
    user = create(client, admin)
    trainee = headers_for(client, user["login"], PASSWORD)
    with client.websocket_connect("/ws", headers=trainee) as socket:
        assert socket.receive_json()["type"] == "snapshot"
        blocked = client.put(
            f"/api/users/{user['id']}", json=update_body(user, is_active=False), headers=admin
        )
        assert blocked.status_code == 200, blocked.text
        assert blocked.json()["is_active"] is False
        with pytest.raises(WebSocketDisconnect) as closed:
            while True:
                socket.receive_json()
        assert closed.value.code == 4401
    assert client.get("/api/auth/me", headers=trainee).status_code == 401
    denied = client.post("/api/auth/login", json={"login": user["login"], "password": PASSWORD})
    assert denied.status_code == 401
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect("/ws", headers=trainee):
            pass
    assert refused.value.code == 4401

    restored = client.put(
        f"/api/users/{user['id']}", json=update_body(user, is_active=True), headers=admin
    )
    assert restored.status_code == 200 and restored.json()["is_active"] is True
    headers_for(client, user["login"], PASSWORD)


def test_blocked_trainee_cannot_join_a_lesson(database_client):
    client = database_client
    admin = headers_for(client, "admin")
    user = create(client, admin)
    assert (
        client.put(
            f"/api/users/{user['id']}", json=update_body(user, is_active=False), headers=admin
        ).status_code
        == 200
    )
    teacher = headers_for(client, "teacher")
    settings = client.get("/api/settings", headers=teacher).json()
    lesson = client.post(
        "/api/sessions",
        headers=teacher,
        json={
            "title": "С заблокированным",
            "participants": [
                {
                    "user_id": user["id"],
                    "workstation_number": 7,
                    "dds_service_id": "101",
                    "level": 1,
                }
            ],
            "settings_snapshot": settings,
        },
    )
    assert lesson.status_code == 422, lesson.text


def test_reset_password_revokes_sessions_and_keeps_own_tab(database_client, database_url):
    client = database_client
    admin = headers_for(client, "admin")
    user = create(client, admin)
    old = headers_for(client, user["login"], PASSWORD)
    new_password = "another-pass-2026"
    reset = client.post(
        f"/api/users/{user['id']}/password", json={"password": new_password}, headers=admin
    )
    assert reset.status_code == 200, reset.text
    assert client.get("/api/auth/me", headers=old).status_code == 401
    assert (
        client.post(
            "/api/auth/login", json={"login": user["login"], "password": PASSWORD}
        ).status_code
        == 401
    )
    headers_for(client, user["login"], new_password)
    assert (
        client.post(
            f"/api/users/{user['id']}/password", json={"password": "short"}, headers=admin
        ).status_code
        == 422
    )

    # Свой пароль: текущая вкладка остаётся, другая сессия того же администратора закрыта.
    second = create(client, admin, role="admin", workstation_number=None, dds_service_id=None)
    mine = headers_for(client, second["login"], PASSWORD)
    other_tab = headers_for(client, second["login"], PASSWORD)
    own = client.post(
        f"/api/users/{second['id']}/password", json={"password": new_password}, headers=mine
    )
    assert own.status_code == 200, own.text
    assert client.get("/api/auth/me", headers=mine).status_code == 200
    assert client.get("/api/auth/me", headers=other_tab).status_code == 401

    async def audit(db):
        rows = (
            await db.scalars(
                select(AuditLog).where(
                    AuditLog.action == "resetUserPassword", AuditLog.entity_id == user["id"]
                )
            )
        ).all()
        assert rows and all(new_password not in str(row.after) for row in rows)
        assert all(row.before is None for row in rows)

    run_db(database_url, audit)


def test_admin_cannot_lock_themselves_out(database_client):
    client = database_client
    admin = headers_for(client, "admin")
    me = client.get("/api/auth/me", headers=admin).json()
    for changes in ({"is_active": False}, {"role": "teacher"}):
        response = client.put(
            f"/api/users/{me['id']}", json=update_body(me, **changes), headers=admin
        )
        assert response.status_code == 409 and response.json()["code"] == "self_lockout"
    renamed = client.put(
        f"/api/users/{me['id']}",
        json=update_body(me, full_name="Администратор класса"),
        headers=admin,
    )
    assert renamed.status_code == 200 and renamed.json()["full_name"] == "Администратор класса"
    client.put(f"/api/users/{me['id']}", json=update_body(me), headers=admin)


def test_role_changes_only_without_training_history(database_client, database_url):
    client = database_client
    admin = headers_for(client, "admin")
    user = create(client, admin)
    trainee = headers_for(client, user["login"], PASSWORD)
    promoted = client.put(
        f"/api/users/{user['id']}",
        json=update_body(user, role="teacher", workstation_number=None, dds_service_id=None),
        headers=admin,
    )
    assert promoted.status_code == 200, promoted.text
    assert promoted.json()["role"] == "teacher"
    # Роль в уже выданной сессии не должна жить до конца её срока.
    assert client.get("/api/auth/me", headers=trainee).status_code == 401

    learner = create(client, admin)
    teacher = headers_for(client, "teacher")
    settings = client.get("/api/settings", headers=teacher).json()
    lesson = client.post(
        "/api/sessions",
        headers=teacher,
        json={
            "title": "История",
            "participants": [
                {
                    "user_id": learner["id"],
                    "workstation_number": 7,
                    "dds_service_id": "101",
                    "level": 1,
                }
            ],
            "settings_snapshot": settings,
        },
    )
    assert lesson.status_code == 201, lesson.text
    refused = client.put(
        f"/api/users/{learner['id']}",
        json=update_body(learner, role="teacher", workstation_number=None, dds_service_id=None),
        headers=admin,
    )
    assert refused.status_code == 409 and refused.json()["code"] == "role_has_history"
    # Профиль и доступ человеку с историей менять можно.
    moved = client.put(
        f"/api/users/{learner['id']}",
        json=update_body(learner, workstation_number=9),
        headers=admin,
    )
    assert moved.status_code == 200 and moved.json()["workstation_number"] == 9
    missing = client.put(f"/api/users/{uuid4()}", json=update_body(learner), headers=admin)
    assert missing.status_code == 404


def test_users_survive_restart(database_config):
    """Созданная учётка — в PostgreSQL, а не в памяти процесса."""
    with TestClient(create_database_app(database_config)) as first:
        admin = headers_for(first, "admin")
        body = {
            "login": new_login("keep"),
            "full_name": "Сохранится",
            "role": "teacher",
            "password": PASSWORD,
            "workstation_number": None,
            "dds_service_id": None,
        }
        assert first.post("/api/users", json=body, headers=admin).status_code == 201
    with TestClient(create_database_app(database_config)) as second:
        second.post("/api/auth/login", json={"login": body["login"], "password": PASSWORD})
        assert second.get("/api/auth/me").json()["login"] == body["login"]
