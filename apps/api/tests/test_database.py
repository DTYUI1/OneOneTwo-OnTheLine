import asyncio
import json
import os
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import jwt
import pytest
from app.api.database import create_database_app
from app.core.config import ROOT, Settings
from app.core.contracts import read_json, validate_json
from app.core.db import Database
from app.core.models import AuditLog, Base, Setting, User
from app.core.security import issue_token, verify_password
from app.seed.loader import seed
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text, update
from sqlalchemy.exc import DBAPIError


def login(client, name="admin", password="test-password"):
    response = client.post("/api/auth/login", json={"login": name, "password": password})
    assert response.status_code == 200, response.text
    validate_json(response.json(), "urn:openapi#/components/schemas/User")
    return response


def csrf(client):
    return {"X-CSRF-Token": client.cookies["csrf"]}


def run_db(url, action):
    async def run():
        database = Database(url)
        try:
            async with database.sessions.begin() as db:
                return await action(db)
        finally:
            await database.close()

    return asyncio.run(run())


def test_seed_is_idempotent_and_preserves_edits(database_url):
    async def check(db):
        before = {
            name: await db.scalar(select(func.count()).select_from(table))
            for name, table in Base.metadata.tables.items()
        }
        account = await db.scalar(select(User).where(User.login == "trainee05"))
        original_hash = account.password_hash
        assert original_hash.startswith("$argon2id$")
        assert await verify_password(original_hash, "test-password")
        setting = await db.get(Setting, "training")
        original_settings = setting.value
        setting.value = {**original_settings, "reaction_normative_s": 47}
        await db.flush()
        counts = await seed(db, "different-password")
        await db.refresh(setting)
        await db.refresh(account)
        assert setting.value["reaction_normative_s"] == 47
        assert account.password_hash == original_hash
        assert counts == {
            "streets": 0,
            "users": 7,
            "services": 6,
            "scenarios": 21,
            "incident_types": 1283,
            "routing_rules": 3835,
        }
        after = {
            name: await db.scalar(select(func.count()).select_from(table))
            for name, table in Base.metadata.tables.items()
        }
        assert before == after
        assert before["workstations"] == 23
        assert before["scenario_pack_items"] == 20
        assert before["seed_artifacts"] == 26
        setting.value = original_settings

    run_db(database_url, check)


def test_auth_survives_restart_and_logout_revokes_token(database_config):
    with TestClient(create_database_app(database_config)) as first:
        response = login(first, "trainee01")
        assert "HttpOnly" in response.headers.get_list("set-cookie")[0]
        assert "SameSite=strict" in response.headers.get_list("set-cookie")[0]
        assert "password_hash" not in response.text
        token, csrf_token = first.cookies["session"], first.cookies["csrf"]
    with TestClient(create_database_app(database_config)) as second:
        second.cookies.set("session", token, domain="testserver.local")
        second.cookies.set("csrf", csrf_token, domain="testserver.local")
        assert second.get("/api/auth/me").json()["login"] == "trainee01"
        assert second.post("/api/auth/logout", headers=csrf(second)).status_code == 200
        assert not second.cookies.get("session")
        second.cookies.set("session", token)
        assert second.get("/api/auth/me").status_code == 401


@pytest.mark.parametrize(
    "name,users_code,health_code",
    [
        ("trainee01", 403, 403),
        ("teacher", 200, 403),
        ("admin", 200, 200),
    ],
)
def test_rbac_and_private_user_fields(database_client, name, users_code, health_code):
    client = database_client
    assert client.get("/api/users").status_code == 401
    login(client, name)
    users = client.get("/api/users")
    assert users.status_code == users_code
    assert "password_hash" not in users.text
    assert client.get("/api/admin/health").status_code == health_code
    assert client.get("/api/settings").status_code == 200
    # Карточки обучаемых администратору не показываются (ТЗ, C-07: минимальные привилегии).
    assert client.get("/api/cards").status_code == (403 if name == "admin" else 200)
    if name != "admin":
        assert (
            client.put(
                "/api/settings", json=client.get("/api/settings").json(), headers=csrf(client)
            ).status_code
            == 403
        )


def test_csrf_validation_persistence_and_audit(database_client, database_url, database_config):
    client = database_client
    login(client)
    original = client.get("/api/settings").json()
    changed = {**original, "handling_normative_s": original["handling_normative_s"] + 5}
    assert client.put("/api/settings", json=changed).status_code == 403
    assert (
        client.put("/api/settings", json=changed, headers={"X-CSRF-Token": "bad"}).status_code
        == 403
    )
    assert (
        client.put(
            "/api/settings", json={**changed, "unexpected": 1}, headers=csrf(client)
        ).status_code
        == 422
    )
    assert (
        client.put(
            "/api/settings", json={**changed, "critical_cap": 2}, headers=csrf(client)
        ).status_code
        == 422
    )
    assert client.put("/api/settings", json=changed, headers=csrf(client)).json() == changed
    with TestClient(create_database_app(database_config)) as second:
        login(second)
        assert second.get("/api/settings").json() == changed

    async def audit(db):
        row = await db.scalar(
            select(AuditLog).where(AuditLog.action == "updateSettings").order_by(AuditLog.ts.desc())
        )
        assert row.before == original
        assert row.after == changed
        assert row.actor_id is not None
        assert row.entity == "settings" and row.entity_id == "training"
        assert (
            await db.scalar(
                select(func.count())
                .select_from(AuditLog)
                .where(
                    AuditLog.action == "updateSettings",
                    AuditLog.after["status_code"].as_integer() == 403,
                )
            )
            >= 2
        )

    run_db(database_url, audit)
    assert client.put("/api/settings", json=original, headers=csrf(client)).status_code == 200


def test_forged_csrf_and_invalid_login(database_client):
    client = database_client
    for name, password in [("admin", "wrong"), ("unknown", "wrong")]:
        response = client.post("/api/auth/login", json={"login": name, "password": password})
        assert response.status_code == 401
        assert not client.cookies.get("session")
    assert client.post("/api/auth/login", json={"login": 123, "password": "x"}).status_code == 422
    assert client.post("/api/auth/login", content="not-json").status_code == 422
    login(client)
    token = client.cookies["session"]
    client.cookies.clear()
    client.cookies.set("session", token)
    client.cookies.set("csrf", "attacker-controlled")
    assert client.post("/api/auth/logout", headers=csrf(client)).status_code == 403
    assert client.get("/api/auth/me").status_code == 200


def test_disabled_account_invalidates_existing_session(database_client, database_url):
    client = database_client
    login(client, "trainee04")

    async def active(db, enabled):
        await db.execute(update(User).where(User.login == "trainee04").values(is_active=enabled))

    run_db(database_url, lambda db: active(db, False))
    try:
        assert client.get("/api/auth/me").status_code == 401
        assert (
            client.post(
                "/api/auth/login", json={"login": "trainee04", "password": "test-password"}
            ).status_code
            == 401
        )
    finally:
        run_db(database_url, lambda db: active(db, True))


@pytest.mark.parametrize("mutation", ["expired", "signature", "missing-exp", "bad-sid"])
def test_invalid_jwt(database_client, database_config, mutation):
    client = database_client
    login(client)
    secret = database_config.jwt_secret.get_secret_value()
    payload = jwt.decode(client.cookies["session"], secret, algorithms=["HS256"], audience="arm112")
    if mutation == "expired":
        payload["exp"] = datetime.now(UTC) - timedelta(seconds=5)
    elif mutation == "missing-exp":
        del payload["exp"]
    elif mutation == "bad-sid":
        payload["sid"] = "invalid"
    else:
        secret = "wrong-signing-key-with-at-least-32-bytes"
    client.cookies.clear()
    client.cookies.set("session", jwt.encode(payload, secret, algorithm="HS256"))
    assert client.get("/api/auth/me").status_code == 401


def test_failed_audit_rolls_back_settings(database_client, database_url, monkeypatch):
    from sqlalchemy.ext.asyncio import AsyncSession

    client = database_client
    login(client)
    original = client.get("/api/settings").json()
    real_add = AsyncSession.add

    def fail_audit(self, instance, **kwargs):
        if isinstance(instance, AuditLog):
            raise DBAPIError("audit", {}, Exception("unavailable"))
        return real_add(self, instance, **kwargs)

    monkeypatch.setattr(AsyncSession, "add", fail_audit)
    response = client.put(
        "/api/settings", json={**original, "reaction_normative_s": 99}, headers=csrf(client)
    )
    assert response.status_code == 503
    assert client.get("/api/settings").json() == original


def test_database_journal_guards(database_url):
    async def check(db):
        for table in ["audit_log", "card_events", "teacher_overrides", "predictions"]:
            triggers = await db.scalar(
                text(
                    "SELECT count(*) FROM pg_trigger WHERE tgrelid = to_regclass(:name) "
                    "AND NOT tgisinternal"
                ),
                {"name": table},
            )
            assert triggers == 2
            with pytest.raises(DBAPIError):
                async with db.begin_nested():
                    await db.execute(text(f"TRUNCATE {table}"))
        row = AuditLog(id=uuid4(), action="test", entity="http", after={"status_code": 200})
        db.add(row)
        await db.flush()
        for statement in [
            "UPDATE audit_log SET action = 'changed' WHERE id=:id",
            "DELETE FROM audit_log WHERE id=:id",
        ]:
            with pytest.raises(DBAPIError):
                async with db.begin_nested():
                    await db.execute(text(statement), {"id": row.id})

    run_db(database_url, check)


def test_health_and_live_schema(database_client):
    health = database_client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["database"] == "ok"
    assert health.json()["worker"] in {"ok", "error"}
    assert health.json()["status"] == "degraded"
    validate_json(health.json(), "urn:openapi#/components/schemas/Health")
    generated = database_client.get("/api/openapi.json").json()
    draft = read_json("contracts/openapi.draft.yaml")
    assert generated["paths"] == draft["paths"]
    assert generated["components"] == draft["components"]


def test_models_match_migration(database_url):
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "apps/api/alembic.ini", "check"],
        cwd=ROOT,
        env={**os.environ, "DATABASE_URL": database_url},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_prediction_outcome_is_write_once(database_url):
    from app.core import models as m

    async def check(db):
        teacher = await db.scalar(select(m.User).where(m.User.login == "teacher"))
        trainee = await db.scalar(select(m.User).where(m.User.login == "trainee01"))
        scenario = await db.scalar(select(m.Scenario).limit(1))
        lesson = m.Session(
            id=uuid4(),
            teacher_id=teacher.id,
            title="Проверка журнала",
            status="draft",
            settings_snapshot=(
                await db.scalar(select(m.Setting).where(m.Setting.key == "training"))
            ).value,
        )
        db.add(lesson)
        await db.flush()
        participant = m.Participant(
            id=uuid4(),
            session_id=lesson.id,
            user_id=trainee.id,
            workstation_id=1,
            dds_service_id="102",
            level=1,
            rating_at_start=0,
        )
        db.add(participant)
        await db.flush()
        assignment = m.Assignment(
            id=uuid4(),
            session_id=lesson.id,
            participant_id=participant.id,
            scenario_id=scenario.id,
            order=1,
            status="pending",
        )
        db.add(assignment)
        await db.flush()
        card = m.Card(
            id=uuid4(),
            assignment_id=assignment.id,
            number="10000001",
            state="added",
            appeared_at=datetime.now(UTC),
            current={"service_number": "", "comment": ""},
        )
        db.add(card)
        await db.flush()
        prediction = m.Prediction(
            id=uuid4(),
            card_id=card.id,
            participant_id=participant.id,
            p_success=0.5,
            expected_score=0.5,
            p_timeout=0.1,
            expected_time_s=60,
            theta_before=0,
            b_scenario=1,
            model_version="v0",
        )
        db.add(prediction)
        event = m.CardEvent(
            id=uuid4(),
            card_id=card.id,
            actor_id=trainee.id,
            client_event_id=uuid4(),
            client_ts=datetime.now(UTC),
            clock_offset_ms=0,
            type="open",
            payload={},
        )
        db.add(event)
        await db.flush()
        await db.execute(
            update(m.Prediction)
            .where(m.Prediction.id == prediction.id)
            .values(actual_score=0.8, actual_time_s=70, actual_timeout=False)
        )
        for statement in [
            update(m.Prediction).where(m.Prediction.id == prediction.id).values(p_success=0.9),
            update(m.Prediction).where(m.Prediction.id == prediction.id).values(actual_score=0.1),
            update(m.Prediction).where(m.Prediction.id == prediction.id).values(actual_score=None),
            update(m.CardEvent).where(m.CardEvent.id == event.id).values(type="deliver"),
        ]:
            with pytest.raises(DBAPIError):
                async with db.begin_nested():
                    await db.execute(statement)
        with pytest.raises(DBAPIError):
            async with db.begin_nested():
                db.add(
                    m.CardEvent(
                        id=uuid4(),
                        card_id=card.id,
                        actor_id=trainee.id,
                        client_event_id=event.client_event_id,
                        client_ts=datetime.now(UTC),
                        clock_offset_ms=0,
                        type="open",
                        payload={},
                    )
                )
                await db.flush()
        with pytest.raises(DBAPIError):
            async with db.begin_nested():
                await db.execute(update(m.Card).where(m.Card.id == card.id).values(state="invalid"))

    run_db(database_url, check)


def test_seed_failure_is_atomic(database_url, tmp_path):
    import shutil

    from jsonschema import ValidationError

    data = tmp_path / "data"
    data.mkdir()
    for folder in ("seed", "templates", "golden_scenarios", "packs", "voices"):
        shutil.copytree(ROOT / "data" / folder, data / folder)
    for name in ("classifier.json", "phonebook.json"):
        shutil.copyfile(ROOT / "data" / name, data / name)
    users_file = data / "seed/demo_users.json"
    users = json.loads(users_file.read_text(encoding="utf-8"))
    users.append({**users[0], "id": str(uuid4()), "login": "must-rollback"})
    users_file.write_text(json.dumps(users), encoding="utf-8")
    (data / "templates/traffic.json").write_text('{"invalid": true}', encoding="utf-8")
    with pytest.raises(ValidationError):
        run_db(database_url, lambda db: seed(db, "test-password", data))

    async def check(db):
        assert await db.scalar(select(User).where(User.login == "must-rollback")) is None

    run_db(database_url, check)


def test_health_reports_unavailable_database(database_config):
    config = database_config.model_copy(
        update={
            "database_url": "postgresql+asyncpg://unused:unused@127.0.0.1:1/unavailable",
        }
    )
    with TestClient(create_database_app(config)) as client:
        response = client.get("/api/health")
        assert response.status_code == 200
        assert response.json()["database"] == "error"
        assert response.json()["status"] == "degraded"
        client.cookies.set(
            "session",
            issue_token(uuid4(), uuid4(), datetime.now(UTC) + timedelta(minutes=1), config),
        )
        response = client.get("/api/admin/health")
        assert response.status_code == 503
        assert response.json()["code"] == "database_unavailable"
        validate_json(response.json(), "urn:openapi#/components/schemas/Error")


def test_migration_roundtrip(migration_database_url):
    for revision in ("head", "base", "head"):
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "alembic",
                "-c",
                "apps/api/alembic.ini",
                "downgrade" if revision == "base" else "upgrade",
                revision,
            ],
            cwd=ROOT,
            env={**os.environ, "DATABASE_URL": migration_database_url},
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stdout + result.stderr
    run_db(migration_database_url, lambda db: seed(db, "test-password"))


def test_database_mode_requires_stable_secret():
    with (
        pytest.raises(ValueError, match="JWT_SECRET"),
        TestClient(
            create_database_app(
                Settings(_env_file=None, api_mode="database", jwt_secret=""),
            )
        ),
    ):
        pass


def test_openapi_export_matches_committed_contract():
    generated = create_database_app(Settings(_env_file=None, api_mode="database")).openapi()
    assert generated == read_json("contracts/openapi.json")
    assert json.dumps(generated)
