"""Интеграция работает в отдельной случайной БД; данные стенда не очищаются."""

import asyncio
import os
import subprocess
import sys
from uuid import uuid4

import pytest
from app.api.database import create_database_app
from app.core.config import ROOT, Settings
from app.core.db import Database
from app.seed.loader import seed
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine


@pytest.fixture(scope="session")
def database_url():
    source = os.environ.get("DATABASE_URL_TEST")
    if not source:
        pytest.skip("Для интеграционных тестов нужен PostgreSQL: DATABASE_URL_TEST.")
    parsed = make_url(source)
    if parsed.drivername != "postgresql+asyncpg":
        pytest.fail("DATABASE_URL_TEST должен использовать postgresql+asyncpg.")
    name = "arm112_test_" + uuid4().hex
    url = parsed.set(database=name).render_as_string(hide_password=False)

    async def database_command(command):
        engine = create_async_engine(source, isolation_level="AUTOCOMMIT")
        try:
            async with engine.connect() as connection:
                await connection.execute(text(command))
        finally:
            await engine.dispose()

    asyncio.run(database_command(f'CREATE DATABASE "{name}"'))
    try:
        env = {**os.environ, "DATABASE_URL": url, "API_MODE": "mock"}
        subprocess.run(
            [sys.executable, "-m", "alembic", "-c", "apps/api/alembic.ini", "upgrade", "head"],
            cwd=ROOT,
            env=env,
            check=True,
            capture_output=True,
        )

        async def initial_seed():
            database = Database(url)
            try:
                async with database.sessions.begin() as db:
                    await seed(db, "test-password")
            finally:
                await database.close()

        asyncio.run(initial_seed())
        yield url
    finally:
        # Имя создано выше из UUID; исходная DATABASE_URL_TEST никогда не удаляется.
        asyncio.run(database_command(f'DROP DATABASE "{name}" WITH (FORCE)'))


@pytest.fixture
def database_config(database_url):
    return Settings(
        _env_file=None,
        api_mode="database",
        database_url=database_url,
        jwt_secret="test-only-secret-at-least-32-bytes-long",
        cookie_secure=False,
    )


@pytest.fixture
def migration_database_url(database_url):
    """Миграционные roundtrip не удаляют историю остальных тестов общей БД."""
    name = "arm112_migration_" + uuid4().hex
    url = make_url(database_url).set(database=name).render_as_string(hide_password=False)

    async def command(sql):
        engine = create_async_engine(database_url, isolation_level="AUTOCOMMIT")
        try:
            async with engine.connect() as connection:
                await connection.execute(text(sql))
        finally:
            await engine.dispose()

    asyncio.run(command(f'CREATE DATABASE "{name}"'))
    try:
        yield url
    finally:
        asyncio.run(command(f'DROP DATABASE "{name}" WITH (FORCE)'))


@pytest.fixture
def database_client(database_config):
    with TestClient(create_database_app(database_config)) as client:
        yield client
