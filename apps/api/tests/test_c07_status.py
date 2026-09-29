"""C-07: состояние системы для администратора — компоненты, нагрузка, копии, оповещения."""

from datetime import UTC, datetime, timedelta

from app.api.database import create_database_app
from app.api.system.service import backups
from app.core.contracts import validate_json
from fastapi.testclient import TestClient


def headers_for(client, name):
    response = client.post("/api/auth/login", json={"login": name, "password": "test-password"})
    assert response.status_code == 200, response.text
    return {
        "cookie": "; ".join(f"{key}={value}" for key, value in client.cookies.items()),
        "X-CSRF-Token": client.cookies["csrf"],
    }


def stamp(moment):
    return "backup-" + moment.strftime("%Y%m%dT%H%M%SZ")


def test_backup_folder_states(tmp_path):
    now = datetime(2026, 9, 27, 12, 0, tzinfo=UTC)
    assert backups(tmp_path / "absent", now)["status"] == "unknown"
    assert backups(tmp_path, now) == {
        "status": "missing",
        "last_at": None,
        "count": 0,
        "in_progress": False,
    }
    (tmp_path / stamp(now - timedelta(days=3))).mkdir()
    (tmp_path / ".backup-20260927T110000Z-1").mkdir()  # незавершённая — не считается
    (tmp_path / "notes.txt").write_text("x", encoding="utf-8")
    old = backups(tmp_path, now)
    assert old["status"] == "stale" and old["count"] == 1
    (tmp_path / stamp(now - timedelta(hours=10))).mkdir()
    (tmp_path / ".backup.lock").mkdir()
    fresh = backups(tmp_path, now)
    assert fresh == {
        "status": "ok",
        "last_at": "2026-09-27T02:00:00.000Z",
        "count": 2,
        "in_progress": True,
    }


def test_admin_status_reports_components_and_alerts(database_config, tmp_path):
    config = database_config.model_copy(update={"backup_status_dir": tmp_path})
    with TestClient(create_database_app(config)) as client:
        admin = headers_for(client, "admin")
        response = client.get("/api/admin/status", headers=admin)
        assert response.status_code == 200, response.text
        status = response.json()
        validate_json(status, "urn:openapi#/components/schemas/SystemStatus")
        assert status["database"]["status"] == "ok" and status["database"]["size_bytes"] > 0
        assert status["disk"]["total_bytes"] > 0
        assert status["machine"]["cores"] >= 1
        assert status["backup"]["status"] == "missing"
        messages = [alert["message"] for alert in status["alerts"]]
        assert any("Резервных копий нет" in message for message in messages)
        # Сбой компонента обязательно становится оповещением, а не молчанием.
        worker_alert = any("Фоновый обработчик" in message for message in messages)
        assert worker_alert == (status["worker"]["status"] == "error")

        (tmp_path / stamp(datetime.now(UTC) - timedelta(hours=1))).mkdir()
        refreshed = client.get("/api/admin/status", headers=admin).json()
        assert refreshed["backup"]["status"] == "ok" and refreshed["backup"]["count"] == 1
        assert not any("копи" in alert["message"] for alert in refreshed["alerts"])
        with client.websocket_connect("/ws", headers=admin) as socket:
            assert socket.receive_json()["type"] == "snapshot"
            online = client.get("/api/admin/status", headers=admin).json()["realtime"]
            assert online["connections"] >= 1 and online["users_online"] >= 1


def test_only_admin_sees_status(database_client):
    client = database_client
    for name in ("teacher", "trainee01"):
        assert client.get("/api/admin/status", headers=headers_for(client, name)).status_code == 403
    client.cookies.clear()
    assert client.get("/api/admin/status").status_code == 401
