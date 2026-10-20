"""Интеграция работает в отдельной случайной БД; данные стенда не очищаются."""

import asyncio
import hashlib
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
from sqlalchemy import delete, select, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

# Засеянная БД-шаблон (HQ-054): миграции и seed — один раз на содержимое кода и данных, а не в
# каждом процессе xdist и каждом запуске. Ключ — хеш файлов, от которых зависит засеянная БД;
# поменялся код, миграция или данные — новый шаблон, старые удаляются.
# evalcore — тоже: seed берёт из него правила и словари.
TEMPLATE_INPUTS = ("apps/api/migrations", "apps/api/app", "packages/evalcore/evalcore", "data")
TEMPLATE_FILES = ("uv.lock",)
TEMPLATE_PREFIX = "arm112_tpl_"
TEMPLATE_LOCK = 112054


def template_name() -> str:
    digest = hashlib.sha1()
    for name in TEMPLATE_FILES:
        digest.update((ROOT / name).read_bytes())
    for folder in TEMPLATE_INPUTS:
        for path in sorted((ROOT / folder).rglob("*")):
            if not path.is_file() or "__pycache__" in path.parts:
                continue
            digest.update(path.relative_to(ROOT).as_posix().encode())
            digest.update(path.read_bytes())
    return TEMPLATE_PREFIX + digest.hexdigest()[:16]


def build_seeded(url: str) -> None:
    """Пустая БД `url` → миграции до head и основной seed, как на стенде."""
    env = {**os.environ, "DATABASE_URL": url, "API_MODE": "mock"}
    migrated = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "apps/api/alembic.ini", "upgrade", "head"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
    )
    if migrated.returncode:
        raise RuntimeError(f"Миграции шаблона БД упали:\n{migrated.stderr}")

    async def initial_seed():
        database = Database(url)
        try:
            async with database.sessions.begin() as db:
                await seed(db, "test-password")
        finally:
            await database.close()

    asyncio.run(initial_seed())


async def clone_seeded(source: str, name: str, clone: str) -> None:
    """БД `clone` — копия засеянного шаблона `name`; нет шаблона — собрать.

    Всё под advisory lock: процессы xdist ждут одного сборщика, а другой запуск не удалит
    шаблон между проверкой и копией. Сборка идёт в БД с суффиксом и переименовывается в
    конце: упавшая сборка не оставит полузасеянный шаблон.
    """
    engine = create_async_engine(source, isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as connection:
            await connection.execute(text(f"SELECT pg_advisory_lock({TEMPLATE_LOCK})"))
            try:
                exists = await connection.scalar(
                    text("SELECT 1 FROM pg_database WHERE datname = :name"), {"name": name}
                )
                if not exists:
                    await build_template(connection, source, name)
                await connection.execute(text(f'CREATE DATABASE "{clone}" TEMPLATE "{name}"'))
            finally:
                await connection.execute(text(f"SELECT pg_advisory_unlock({TEMPLATE_LOCK})"))
    finally:
        await engine.dispose()


async def build_template(connection: AsyncConnection, source: str, name: str) -> None:
    """Собрать шаблон `name`; шаблоны прежнего кода удалить."""
    stale = await connection.scalars(
        text("SELECT datname FROM pg_database WHERE datname LIKE :prefix"),
        {"prefix": TEMPLATE_PREFIX + "%"},
    )
    for old in stale.all():
        try:
            await connection.execute(text(f'DROP DATABASE "{old}"'))
        except DBAPIError:
            pass  # К шаблону кто-то подключён — удалится при следующей сборке.
    building = name + "_build"
    await connection.execute(text(f'DROP DATABASE IF EXISTS "{building}"'))
    await connection.execute(text(f'CREATE DATABASE "{building}"'))
    url = make_url(source).set(database=building).render_as_string(hide_password=False)
    await asyncio.to_thread(build_seeded, url)
    await connection.execute(text(f'ALTER DATABASE "{building}" RENAME TO "{name}"'))


@pytest.fixture(autouse=True)
def no_coherence_pass(monkeypatch):
    """Проход связности генератора — свой тест с подменой: настоящий собирает базу-шаблон."""
    from app.core.config import settings

    monkeypatch.setattr(settings, "generation_coherence", False)


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

    asyncio.run(clone_seeded(source, template_name(), name))
    try:
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


@pytest.fixture
def operator_module_on(database_url):
    """Модуль «Оператор 112» по умолчанию выключен; тесты его API включают на время теста."""

    async def put(enabled):
        engine = create_async_engine(database_url)
        try:
            async with engine.begin() as connection:
                if enabled:
                    await connection.execute(
                        text(
                            "INSERT INTO settings (key, value) VALUES "
                            "('operator_module', '{\"enabled\": true}') "
                            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
                        )
                    )
                else:
                    await connection.execute(
                        text("DELETE FROM settings WHERE key = 'operator_module'")
                    )
        finally:
            await engine.dispose()

    asyncio.run(put(True))
    yield
    asyncio.run(put(False))


@pytest.fixture
def clean_generated_content(database_url):
    """Новые ИИ-тесты не расширяют seed-каталог и расписание других тестов.

    БД создана conftest из случайного UUID. Планы/историю не удаляем: сценарии
    выводятся из выдачи, их пакетные ссылки убираются после завершения теста.
    """
    from app.core.models import (
        Job,
        Scenario,
        ScenarioPack,
        ScenarioPackItem,
        Session,
        WorkerHeartbeat,
    )

    async def snapshot():
        database = Database(database_url)
        try:
            async with database.sessions() as db:
                return {
                    model: set(
                        await db.scalars(
                            select(model.id if model is not WorkerHeartbeat else model.worker_id)
                        )
                    )
                    for model in (ScenarioPack, Scenario, Session, Job, WorkerHeartbeat)
                }
        finally:
            await database.close()

    before = asyncio.run(snapshot())
    yield

    async def clean():
        database = Database(database_url)
        try:
            async with database.sessions.begin() as db:
                new_packs = select(ScenarioPack.id).where(
                    ScenarioPack.id.not_in(before[ScenarioPack])
                )
                await db.execute(
                    delete(ScenarioPackItem).where(ScenarioPackItem.pack_id.in_(new_packs))
                )
                await db.execute(
                    delete(ScenarioPack).where(ScenarioPack.id.not_in(before[ScenarioPack]))
                )
                await db.execute(
                    update(Scenario)
                    .where(Scenario.id.not_in(before[Scenario]))
                    .values(status="retired")
                )
                await db.execute(
                    update(Session)
                    .where(Session.id.not_in(before[Session]))
                    .values(status="finished", start_request=None)
                )
                await db.execute(
                    update(Job)
                    .where(Job.id.not_in(before[Job]), Job.status.in_(["pending", "running"]))
                    .values(status="failed", locked_by=None, locked_at=None)
                )
                await db.execute(
                    delete(WorkerHeartbeat).where(
                        WorkerHeartbeat.worker_id.not_in(before[WorkerHeartbeat])
                    )
                )
        finally:
            await database.close()

    asyncio.run(clean())
