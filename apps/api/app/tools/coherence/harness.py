"""Стенд прогона в процессе: часы симуляции, временная БД, приложение API без сети.

Часы. Сервер берёт «сейчас» в немногих местах (`datetime.now(UTC)` при приёме события
карточки, старт занятия, тик worker). Прогон подменяет имя `datetime` в модулях `app.*`
подклассом, у которого `now()` — часы симуляции: так приём события, срабатывание события
бригады и выдача доклада идут по одному времени, а ожидание 40 с занимает миллисекунды.
Остальное поведение `datetime` не меняется.
"""

import asyncio
import importlib
import os
import pkgutil
import subprocess
import sys
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from datetime import UTC, datetime, timedelta, tzinfo
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config import ROOT, Settings

PASSWORD = "coherence-password"
REAL_DATETIME = datetime


class SimClock:
    """Часы симуляции: секунды от начала прогона поверх реального начала."""

    def __init__(self) -> None:
        self.start = datetime.now(UTC).replace(microsecond=0)
        self.offset = 0.0

    def now(self) -> datetime:
        return self.start + timedelta(seconds=self.offset)

    def at(self, moment: datetime) -> float:
        """Секунды симуляции для момента сервера."""
        return (moment - self.start).total_seconds()

    def advance(self, seconds: float) -> None:
        self.offset += seconds


def _sim_datetime(clock: SimClock) -> type[datetime]:
    class SimDatetime(datetime):
        @classmethod
        def now(cls, tz: tzinfo | None = None) -> "SimDatetime":
            moment = clock.now()
            if tz is not None:
                moment = moment.astimezone(tz)
            return cls.fromtimestamp(moment.timestamp(), tz=moment.tzinfo)

    return SimDatetime


def _load_app_modules() -> None:
    """Загрузить все модули `app.*` заранее: модуль, импортированный внутри функции уже после
    подмены, остался бы с настоящими часами."""
    import app

    for module in pkgutil.walk_packages(app.__path__, "app."):
        if module.name.endswith("__main__") or module.name.startswith("app.tools."):
            continue
        importlib.import_module(module.name)


@contextmanager
def sim_time(clock: SimClock) -> Iterator[None]:
    """Подменить `datetime` в модулях `app.*` на часы симуляции."""
    _load_app_modules()
    sim = _sim_datetime(clock)
    real = REAL_DATETIME
    patched: list[Any] = []
    for name, module in list(sys.modules.items()):
        # Модули прогона — со своими часами: их `datetime` не трогаем.
        if name.startswith("app.tools.") or not (name == "app" or name.startswith("app.")):
            continue
        if getattr(module, "datetime", None) is real:
            module.datetime = sim  # type: ignore[attr-defined]
            patched.append(module)
    try:
        yield
    finally:
        for module in patched:
            module.datetime = real


async def _admin(source: str, command: str) -> None:
    engine = create_async_engine(source, isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as connection:
            await connection.execute(text(command))
    finally:
        await engine.dispose()


PREFIX = "arm112_coherence_"


def create_database(source: str, name: str | None = None, template: str | None = None) -> str:
    """Новая БД рядом с `source`; без `template` — миграции, основной seed и каталог сценариев,
    с `template` — копия засеянной БД (`CREATE DATABASE … TEMPLATE`, доли секунды).

    `source` — адрес PostgreSQL с правом CREATE DATABASE (как `DATABASE_URL_TEST`). Сама
    `source` не меняется; удаляет созданную `drop_database` или `drop_prefixed`.
    """
    parsed = make_url(source)
    if parsed.drivername != "postgresql+asyncpg":
        raise ValueError("Нужен адрес postgresql+asyncpg://…")
    name = name or PREFIX + uuid4().hex
    if not name.startswith(PREFIX):
        raise ValueError(f"Имя БД прогона начинается с {PREFIX}")
    url = parsed.set(database=name).render_as_string(hide_password=False)
    copy = f' TEMPLATE "{make_url(template).database}"' if template else ""
    asyncio.run(_admin(source, f'CREATE DATABASE "{name}"{copy}'))
    # Временная БД прогона: подтверждение записи на диск не нужно — тики worker коммитят
    # каждую секунду симуляции, а ждать fsync в Docker на macOS дорого.
    asyncio.run(_admin(source, f'ALTER DATABASE "{name}" SET synchronous_commit = off'))
    if template:
        return url
    env = {**os.environ, "DATABASE_URL": url, "API_MODE": "mock", "PYTHONIOENCODING": "utf-8"}
    subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "apps/api/alembic.ini", "upgrade", "head"],
        cwd=ROOT,
        env=env,
        check=True,
        capture_output=True,
    )
    seed_database(url)
    return url


def drop_prefixed(source: str, prefix: str) -> None:
    """Удалить все БД прогона с этим началом имени (процессы пула свои не удаляют)."""
    if not prefix.startswith(PREFIX):
        raise ValueError("Удалять можно только БД прогона.")

    async def drop() -> None:
        engine = create_async_engine(source, isolation_level="AUTOCOMMIT")
        try:
            async with engine.connect() as connection:
                names = await connection.scalars(
                    text("SELECT datname FROM pg_database WHERE starts_with(datname, :prefix)"),
                    {"prefix": prefix},
                )
                for name in list(names):
                    await connection.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
        finally:
            await engine.dispose()

    asyncio.run(drop())


def seed_database(url: str) -> None:
    """Основной seed (учётки с паролем прогона) и каталог сценариев (`app.seed.training`)."""
    from app.core.db import Database
    from app.seed.loader import seed

    async def initial() -> None:
        database = Database(url)
        try:
            async with database.sessions.begin() as db:
                await seed(db, PASSWORD)
        finally:
            await database.close()

    asyncio.run(initial())
    env = {**os.environ, "DATABASE_URL": url, "API_MODE": "mock", "PYTHONIOENCODING": "utf-8"}
    result = subprocess.run(
        [sys.executable, "-m", "app.seed.training"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        encoding="utf-8",
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stdout + result.stderr)


def seed_scenarios_dir(url: str, directory: Path) -> None:
    """Каталог сценариев из другой папки (проверка нового сценария до `data/scenarios`)."""
    from app.core.config import settings
    from app.core.db import Database
    from app.seed.scenarios import seed_scenarios

    async def load() -> None:
        database = Database(url)
        try:
            async with database.sessions.begin() as db:
                await seed_scenarios(db, settings.information_audio_dir, directory)
        finally:
            await database.close()

    asyncio.run(load())


def drop_database(source: str, url: str) -> None:
    name = make_url(url).database
    if not name or not name.startswith(PREFIX):
        raise ValueError("Удалять можно только БД прогона.")
    asyncio.run(_admin(source, f'DROP DATABASE "{name}" WITH (FORCE)'))


def settings_for(url: str) -> Settings:
    options: dict[str, Any] = {
        "_env_file": None,
        "api_mode": "database",
        "database_url": url,
        "jwt_secret": "coherence-only-secret-at-least-32-bytes",
        "cookie_secure": False,
    }
    return Settings(**options)


@asynccontextmanager
async def running_app(url: str) -> AsyncIterator[Any]:
    """Приложение API с его жизненным циклом (БД, realtime) — без сервера и сети."""
    from app.api.database import create_database_app

    app = create_database_app(settings_for(url))
    async with app.router.lifespan_context(app):
        # Проверка соединения при каждой выдаче из пула — лишний запрос на каждую сессию:
        # БД прогона локальная и живёт столько же, сколько процесс.
        app.state.database.engine.sync_engine.pool._pre_ping = False
        app.state.coherence_logins = {}
        yield app


@asynccontextmanager
async def http(app: Any) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://coherence") as client:
        yield client


async def login(
    client: httpx.AsyncClient, name: str, logins: dict[str, dict[str, str]] | None = None
) -> dict[str, str]:
    """Вход; с `logins` (сессии этого приложения) повторный вход той же учётки — прежней
    сессией: проверка пароля argon2 — десятки миллисекунд на проход."""
    saved = logins.get(name) if logins is not None else None
    if saved is not None:
        client.cookies.update(saved)
        return {"X-CSRF-Token": str(client.cookies.get("csrf"))}
    response = await client.post("/api/auth/login", json={"login": name, "password": PASSWORD})
    if response.status_code != 200:
        raise RuntimeError(f"Вход {name}: {response.status_code} {response.text}")
    if logins is not None:
        logins[name] = dict(client.cookies.items())
    return {"X-CSRF-Token": str(client.cookies.get("csrf"))}
