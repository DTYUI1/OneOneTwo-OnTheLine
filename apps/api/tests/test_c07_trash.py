"""C-07: корзина учётных записей и резервная копия по кнопке.

ТЗ: администратор не удаляет критичные данные без процедуры резервного копирования и не
вмешивается в учебный процесс. Удаление — пометка и блокировка; обезличивает worker только
после успешной копии, начатой позже пометки. Реальный PostgreSQL.
"""

import asyncio
from datetime import timedelta
from uuid import UUID, uuid4

from app.api.foundation.trash import purge_due
from app.core.contracts import validate_json
from app.core.db import Database
from app.core.models import AuditLog, Backup, Session, User, UserDeletion
from fastapi.testclient import TestClient
from sqlalchemy import func, select, update

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
    response = client.post("/api/auth/login", json={"login": name, "password": password})
    assert response.status_code == 200, response.text
    return {
        "cookie": "; ".join(f"{key}={value}" for key, value in client.cookies.items()),
        "X-CSRF-Token": client.cookies["csrf"],
    }


def create(client: TestClient, admin: dict, **fields) -> dict:
    body = {
        "login": f"t{uuid4().hex[:10]}",
        "full_name": "Петров Пётр",
        "role": "trainee",
        "password": PASSWORD,
        "workstation_number": 5,
        "dds_service_id": "101",
        **fields,
    }
    response = client.post("/api/users", json=body, headers=admin)
    assert response.status_code == 201, response.text
    return response.json()


def trash(client: TestClient, admin: dict, user_id: str, reason: str = "Выбыл из группы"):
    return client.post(f"/api/users/{user_id}/trash", json={"reason": reason}, headers=admin)


def backup_done(url, *, shift: timedelta = timedelta(0)) -> None:
    """Успешная копия, начатая сейчас (по часам БД) со сдвигом."""

    async def add(db):
        now = await db.scalar(select(func.now()))
        db.add(
            Backup(
                status="done",
                started_at=now + shift,
                finished_at=now + shift,
                name=f"backup-test-{uuid4().hex[:6]}",
            )
        )

    run_db(url, add)


def purge(url) -> int:
    return run_db(url, purge_due)


def test_trash_blocks_hides_and_restores(database_client):
    client = database_client
    admin = headers_for(client, "admin")
    user = create(client, admin)
    victim = headers_for(client, user["login"], PASSWORD)
    admin = headers_for(client, "admin")

    removed = trash(client, admin, user["id"])
    assert removed.status_code == 200, removed.text
    validate_json(removed.json(), "urn:openapi#/components/schemas/User")
    assert removed.json()["is_active"] is False and removed.json()["deleted_at"]
    # Уже вошедший человек выходит сразу, войти снова нельзя.
    assert client.get("/api/auth/me", headers=victim).status_code == 401
    client.cookies.clear()
    refused = client.post("/api/auth/login", json={"login": user["login"], "password": PASSWORD})
    assert refused.status_code == 401
    admin = headers_for(client, "admin")

    listed = client.get("/api/admin/trash", headers=admin)
    assert listed.status_code == 200, listed.text
    validate_json(listed.json(), "urn:openapi#/components/schemas/TrashList")
    item = next(entry for entry in listed.json()["items"] if entry["id"] == user["id"])
    assert item["reason"] == "Выбыл из группы" and item["title"] == "Петров Пётр"
    assert item["state"] in {"waiting_backup", "ready"} and item["purged_at"] is None

    # Из корзины сначала восстанавливают: правка и пароль недоступны.
    body = {
        "full_name": "Другое",
        "role": "trainee",
        "workstation_number": 5,
        "dds_service_id": "101",
        "is_active": True,
    }
    edited = client.put(f"/api/users/{user['id']}", json=body, headers=admin)
    assert edited.status_code == 409 and edited.json()["code"] == "user_deleted"
    password = client.post(
        f"/api/users/{user['id']}/password", json={"password": PASSWORD}, headers=admin
    )
    assert password.status_code == 409
    assert trash(client, admin, user["id"]).json()["code"] == "user_deleted"

    restored = client.post(f"/api/users/{user['id']}/restore", headers=admin)
    assert restored.status_code == 200, restored.text
    # Возвращается заблокированной: доступ администратор открывает отдельно.
    assert restored.json()["deleted_at"] is None and restored.json()["is_active"] is False
    again = client.post(f"/api/users/{user['id']}/restore", headers=admin)
    assert again.status_code == 409 and again.json()["code"] == "user_not_deleted"
    opened = client.put(
        f"/api/users/{user['id']}", json={**body, "full_name": "Петров Пётр"}, headers=admin
    )
    assert opened.status_code == 200, opened.text


def test_trash_rules_and_roles(database_client):
    client = database_client
    admin = headers_for(client, "admin")
    me = client.get("/api/auth/me", headers=admin).json()
    own = trash(client, admin, me["id"])
    assert own.status_code == 409 and own.json()["code"] == "self_lockout"
    assert trash(client, admin, str(uuid4())).status_code == 404
    user = create(client, admin)
    assert trash(client, admin, user["id"], reason="  ").status_code == 422
    assert (
        client.post(
            f"/api/users/{user['id']}/trash", json={"reason": "ok ok", "x": 1}, headers=admin
        ).status_code
        == 422
    )
    for name in ("teacher", "trainee01"):
        other = headers_for(client, name)
        assert trash(client, other, user["id"]).status_code == 403
        assert client.get("/api/admin/trash", headers=other).status_code == 403
        assert client.post(f"/api/users/{user['id']}/restore", headers=other).status_code == 403


def test_user_in_running_lesson_is_not_deleted(database_client, database_url):
    client = database_client
    admin = headers_for(client, "admin")
    user = create(client, admin)
    teacher = headers_for(client, "teacher")
    settings = client.get("/api/settings", headers=teacher).json()
    lesson = client.post(
        "/api/sessions",
        headers=teacher,
        json={
            "title": f"Корзина {uuid4()}",
            "participants": [
                {
                    "user_id": user["id"],
                    "workstation_number": 5,
                    "dds_service_id": "101",
                    "level": 1,
                }
            ],
            "settings_snapshot": settings,
        },
    )
    assert lesson.status_code == 201, lesson.text
    lesson_id = lesson.json()["id"]

    def set_status(status):
        async def action(db):
            await db.execute(
                update(Session).where(Session.id == UUID(lesson_id)).values(status=status)
            )

        return action

    run_db(database_url, set_status("running"))
    admin = headers_for(client, "admin")
    busy = trash(client, admin, user["id"])
    assert busy.status_code == 409 and busy.json()["code"] == "user_in_training"
    # Преподаватель идущего занятия — тоже участник учебного процесса.
    teacher_id = client.get("/api/auth/me", headers=headers_for(client, "teacher")).json()["id"]
    admin = headers_for(client, "admin")
    assert trash(client, admin, teacher_id).json()["code"] == "user_in_training"

    run_db(database_url, set_status("finished"))
    assert trash(client, admin, user["id"]).status_code == 200


def test_purge_only_after_backup_started_later(database_client, database_url):
    client = database_client
    admin = headers_for(client, "admin")
    user = create(client, admin, full_name="Сидорова Анна")
    # Копия, начатая до удаления, данных о пометке не гарантирует — не считается.
    backup_done(database_url, shift=timedelta(seconds=-5))
    assert trash(client, admin, user["id"]).status_code == 200
    purge(database_url)
    listed = client.get("/api/admin/trash", headers=admin).json()
    item = next(entry for entry in listed["items"] if entry["id"] == user["id"])
    assert item["state"] == "waiting_backup" and item["purged_at"] is None

    backup_done(database_url)
    listed = client.get("/api/admin/trash", headers=admin).json()
    assert next(e for e in listed["items"] if e["id"] == user["id"])["state"] == "ready"
    assert purge(database_url) >= 1

    listed = client.get("/api/admin/trash", headers=admin).json()
    item = next(entry for entry in listed["items"] if entry["id"] == user["id"])
    assert item["state"] == "purged" and item["purged_at"]
    assert item["title"].startswith("Удалённый пользователь") and item["login"].startswith(
        "deleted-"
    )
    users = {entry["id"]: entry for entry in client.get("/api/users", headers=admin).json()}
    anonymous = users[user["id"]]
    assert "Сидорова" not in anonymous["full_name"] and anonymous["dds_service_id"] is None
    # Логин освобождён для нового человека; вернуть обезличенного нельзя.
    create(client, admin, login=user["login"])
    gone = client.post(f"/api/users/{user['id']}/restore", headers=admin)
    assert gone.status_code == 409 and gone.json()["code"] == "user_purged"

    async def journal(db):
        purged = await db.scalar(
            select(AuditLog).where(AuditLog.action == "purgeUser", AuditLog.entity_id == user["id"])
        )
        row = await db.get(User, UUID(user["id"]))
        deletion = await db.get(UserDeletion, UUID(user["id"]))
        return purged, row, deletion

    purged, row, deletion = run_db(database_url, journal)
    assert purged is not None and purged.actor_id is None and purged.after["anonymized"] is True
    assert deletion.purged_at is not None and row.is_active is False
    assert row.login.startswith("deleted-") and deletion.reason == "Выбыл из группы"
    # Журнал не переписывается, но прежние ФИО администратору больше не показываются.
    page = client.get("/api/audit", params={"category": "admin", "limit": 200}, headers=admin)
    entries = [item for item in page.json()["items"] if item["entity_id"] == user["id"]]
    assert {item["action"] for item in entries} >= {"createUser", "trashUser", "purgeUser"}
    assert all(item["before"] is None and item["after"] is None for item in entries)
    assert "Сидорова" not in page.text
    # Повторный проход ничего не делает.
    assert purge(database_url) == 0


def test_purge_keeps_logins_unique_for_similar_ids(database_client, database_url):
    """У демо-учёток id отличаются только хвостом — обезличенные логины не должны совпасть."""
    client = database_client
    ids = [UUID(f"00000000-0000-4000-8000-{uuid4().hex[:12]}") for _ in range(2)]

    async def add(db):
        for user_id in ids:
            db.add(
                User(
                    id=user_id,
                    login=f"t{user_id.hex[-10:]}",
                    password_hash="x",
                    role="trainee",
                    full_name="Похожий id",
                    is_active=True,
                )
            )

    run_db(database_url, add)
    admin = headers_for(client, "admin")
    for user_id in ids:
        assert trash(client, admin, str(user_id)).status_code == 200
    backup_done(database_url)
    assert purge(database_url) >= 2

    async def logins(db):
        return {(await db.get(User, user_id)).login for user_id in ids}

    names = run_db(database_url, logins)
    assert len(names) == 2 and all(name.startswith("deleted-") for name in names)


def test_backup_request_by_button(database_client, database_url):
    client = database_client

    async def settle(db):
        # БД общая: закрыть незавершённые запросы других тестов.
        await db.execute(
            update(Backup)
            .where(Backup.status.in_(["pending", "running"]))
            .values(status="failed", finished_at=func.now())
        )

    run_db(database_url, settle)
    admin = headers_for(client, "admin")
    requested = client.post("/api/admin/backups", headers=admin)
    assert requested.status_code == 202, requested.text
    validate_json(requested.json(), "urn:openapi#/components/schemas/BackupRun")
    assert requested.json()["status"] == "pending" and requested.json()["requested_by"]
    twice = client.post("/api/admin/backups", headers=admin)
    assert twice.status_code == 409 and twice.json()["code"] == "backup_in_progress"
    listed = client.get("/api/admin/backups", headers=admin)
    assert listed.status_code == 200
    assert listed.json()[0]["id"] == requested.json()["id"]
    for item in listed.json():
        validate_json(item, "urn:openapi#/components/schemas/BackupRun")

    async def stale(db):
        # Копия «идёт» дольше 6 часов — прервана перезапуском, новую запросить можно.
        await db.execute(
            update(Backup)
            .where(Backup.id == UUID(requested.json()["id"]))
            .values(status="running", started_at=func.now() - timedelta(hours=7))
        )

    run_db(database_url, stale)
    again = client.post("/api/admin/backups", headers=admin)
    assert again.status_code == 202, again.text
    run_db(database_url, settle)

    async def audit(db):
        return await db.scalar(
            select(AuditLog).where(
                AuditLog.action == "requestBackup", AuditLog.entity_id == again.json()["id"]
            )
        )

    assert run_db(database_url, audit) is not None
    for name in ("teacher", "trainee01"):
        other = headers_for(client, name)
        assert client.post("/api/admin/backups", headers=other).status_code == 403
        assert client.get("/api/admin/backups", headers=other).status_code == 403
    admin = headers_for(client, "admin")
    no_csrf = {"cookie": admin["cookie"]}
    assert client.post("/api/admin/backups", headers=no_csrf).status_code == 403
