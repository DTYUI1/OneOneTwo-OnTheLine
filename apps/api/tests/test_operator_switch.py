"""GP-20: модуль «Оператор 112» включает администратор — contracts/operator/module-switch.md."""

import pytest

from .test_lifecycle import login

OPERATOR_PATHS = [
    ("get", "/api/operator/config"),
    ("get", "/api/operator/attempts"),
]


@pytest.fixture(autouse=True)
def _module_off_after(database_url):
    yield
    import asyncio

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    async def clean():
        engine = create_async_engine(database_url)
        try:
            async with engine.begin() as connection:
                await connection.execute(text("DELETE FROM settings WHERE key = 'operator_module'"))
        finally:
            await engine.dispose()

    asyncio.run(clean())


def _switch(client, headers, enabled):
    return client.put("/api/admin/features", json={"operator_module": enabled}, headers=headers)


def test_default_is_off_and_features_are_public(database_client):
    response = database_client.get("/api/features")
    assert response.status_code == 200, response.text
    assert response.json() == {"operator_module": False}


@pytest.mark.parametrize(("method", "path"), OPERATOR_PATHS)
def test_disabled_module_rejects_operator_api(database_client, method, path):
    headers = login(database_client, "trainee01")
    response = getattr(database_client, method)(path, headers=headers)
    assert response.status_code == 404, response.text


def test_disabled_module_rejects_save(database_client):
    headers = login(database_client, "trainee01")
    response = database_client.post("/api/operator/save", json={}, headers=headers)
    assert response.status_code == 404


def test_operator_api_still_requires_login_first(database_client):
    assert database_client.get("/api/operator/config").status_code == 401


def test_admin_enables_and_disables(database_client):
    admin = login(database_client, "admin")
    assert _switch(database_client, admin, True).json() == {"operator_module": True}
    assert database_client.get("/api/features").json() == {"operator_module": True}

    trainee = login(database_client, "trainee01")
    assert database_client.get("/api/operator/config", headers=trainee).status_code == 200

    admin = login(database_client, "admin")
    assert _switch(database_client, admin, False).json() == {"operator_module": False}
    assert database_client.get("/api/features").json() == {"operator_module": False}
    trainee = login(database_client, "trainee01")
    assert database_client.get("/api/operator/config", headers=trainee).status_code == 404


@pytest.mark.parametrize("user", ["trainee01", "teacher"])
def test_only_admin_switches(database_client, user):
    headers = login(database_client, user)
    assert _switch(database_client, headers, True).status_code == 403
    assert database_client.get("/api/features").json() == {"operator_module": False}


def test_switch_requires_csrf(database_client):
    login(database_client, "admin")
    response = database_client.put(
        "/api/admin/features", json={"operator_module": True}, headers={"X-CSRF-Token": "x"}
    )
    assert response.status_code == 403
