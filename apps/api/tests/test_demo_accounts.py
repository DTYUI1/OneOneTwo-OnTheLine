"""Учётные записи для проверки на экране входа: показ управляется настройкой стенда."""

from app.api.foundation.demo_accounts import demo_accounts
from app.api.main import create_app
from app.core.config import Settings, settings
from fastapi.testclient import TestClient


def test_shown_returns_every_role_and_stand_password():
    config = Settings(_env_file=None, demo_accounts_shown=True, demo_password="stand-pass")
    result = demo_accounts(config)
    assert result.enabled and result.password == "stand-pass"
    assert [a.login for a in result.accounts] == [
        "admin",
        "teacher",
        "trainee01",
        "trainee02",
        "trainee03",
        "trainee04",
        "trainee05",
    ]
    assert {a.login: a.full_name for a in result.accounts} == {
        "admin": "Администратор",
        "teacher": "Соколов Андрей Викторович",
        "trainee01": "Иванов Дмитрий Сергеевич",
        "trainee02": "Смирнова Анна Алексеевна",
        "trainee03": "Кузнецов Максим Андреевич",
        "trainee04": "Попова Елена Викторовна",
        "trainee05": "Васильев Артём Николаевич",
    }


def test_hidden_by_default_leaks_nothing():
    result = demo_accounts(Settings(_env_file=None, demo_password="stand-pass"))
    assert result.model_dump() == {"enabled": False, "password": None, "accounts": []}


def test_endpoint_is_public_and_follows_setting(monkeypatch):
    with TestClient(create_app()) as client:
        monkeypatch.setattr(settings, "demo_accounts_shown", False)
        assert client.get("/api/auth/demo-accounts").json()["enabled"] is False
        monkeypatch.setattr(settings, "demo_accounts_shown", True)
        body = client.get("/api/auth/demo-accounts").json()
        assert body["enabled"] is True and body["password"] == settings.demo_password
