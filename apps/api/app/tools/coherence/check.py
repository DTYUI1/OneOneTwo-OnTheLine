"""Проверка сценария из кода (генератор, HQ-027): сценарий-словарь → нарушения связности.

То же, что ночной прогон (`night.run_all`) для одного сценария, но без файла в
`data/scenarios`: сценарий проходит тот же загрузчик и линтер (`app.seed.scenarios.validate`),
ложится в копию засеянной БД под своим UUID и проходит через движок по всем политикам (или
выбранным). Ошибка загрузчика или линтера — одно нарушение класса `lint` с его текстом; линтер
идёт до шаблона и без БД (справочник служб — `data/phonebook.json`, как у seed).

Проходы идут в рабочих процессах `python -m app.tools.coherence.check_worker` (обмен JSON
через stdin/stdout), всегда, и при `jobs=1`: прогон подменяет `datetime` в модулях `app.*`
на часы симуляции (`harness.sim_time`), в процессе вызывающего (API, генератор) это сломало бы
его время и мешало бы параллельным вызовам. Свой процесс — своё состояние: одновременные
вызовы из потоков не мешают друг другу, защита `if __name__ == "__main__"` у вызывающего не
нужна.

Нарушение сценария (вернуть модели) и сбой стенда (`StandError`, исключение) разведены:
PostgreSQL недоступна, шаблон не собрался или удалён, приложение не поднялось — сбой стенда;
исключение движка на данных сценария — нарушение `run_failed`. Шаблон, удалённый другим
процессом, собирается заново один раз.

Засеянная БД-шаблон собирается один раз на содержимое кода и данных (как шаблон тестов,
`apps/api/tests/conftest.py`): имя `arm112_coherence_tpl_<хеш>` в той же PostgreSQL, следующий
вызов (и другой процесс) берёт его готовым; шаблон прежнего кода удаляется при сборке нового.
Каждый вызов делает копии шаблона для рабочих процессов и удаляет их в конце.
"""

import asyncio
import contextlib
import copy
import hashlib
import json
import os
import socket
import subprocess
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any, TypedDict
from uuid import uuid4

from sqlalchemy import exc as sa_exc
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config import ROOT
from app.tools.coherence.harness import (
    PREFIX,
    SimClock,
    create_database,
    drop_prefixed,
    running_app,
)
from app.tools.coherence.invariants import check, failing
from app.tools.coherence.night import TRAINEE, Job, plan_jobs
from app.tools.coherence.runner import ScenarioRun

# От чего зависит засеянная БД: код API и evalcore, миграции, данные (как у шаблона тестов).
TEMPLATE_INPUTS = ("apps/api/migrations", "apps/api/app", "packages/evalcore/evalcore", "data")
TEMPLATE_FILES = ("uv.lock",)
TEMPLATE_PREFIX = f"{PREFIX}tpl_"
TEMPLATE_LOCK = 112027
WORKER = "app.tools.coherence.check_worker"
# Сколько ждать один рабочий процесс, с. Проход — 3–10 с, все ветки сценария в одном
# процессе — несколько минут; дольше — процесс завис (стенд), а не сценарий плох.
WORKER_TIMEOUT = 900.0


class Violation(TypedDict):
    """Нарушение связности: класс (инвариант или `lint`, `run_failed`), политика прогона
    (ветка), секунда от прихода карточки, что не так, реплика в этот момент."""

    rule: str
    policy: str | None
    at: float
    detail: str
    line: str | None
    # False — правило ждёт решения пользователя (`Invariant.pending`): в отчёте, но не ошибка.
    failing: bool


class StandError(RuntimeError):
    """Сбой стенда проверки, а не сценария: PostgreSQL недоступна, шаблон не собрался или
    удалён, копия БД или приложение не поднялись, рабочий процесс упал. Модели не отдавать —
    повторить проверку позже или чинить стенд."""


def template_name() -> str:
    """Имя шаблона по хешу файлов, от которых зависит засеянная БД."""
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


# Шаблон в этом процессе: адрес PostgreSQL → адрес шаблона.
_templates: dict[str, str] = {}


def ensure_template(source: str) -> str:
    """Адрес засеянного шаблона; нет шаблона этого кода — собрать. Сбой — `StandError`."""
    cached = _templates.get(source)
    if cached is not None:
        return cached
    name = template_name()
    url = make_url(source).set(database=name).render_as_string(hide_password=False)
    try:
        asyncio.run(_ensure(source, name))
    except Exception as error:  # noqa: BLE001 — любой сбой сборки — сбой стенда
        raise StandError(f"шаблон БД {name} не собран: {type(error).__name__}: {error}") from error
    _templates[source] = url
    return url


def forget_template(source: str) -> None:
    """Забыть шаблон этого процесса: следующий `ensure_template` проверит и соберёт заново."""
    _templates.pop(source, None)


async def _ensure(source: str, name: str) -> None:
    """Под advisory lock: другой процесс не соберёт тот же шаблон и не удалит его под нами.
    Сборка идёт в БД с суффиксом: упавшая не оставит полузасеянный шаблон. К самому шаблону
    не подключаемся: подключение мешало бы `CREATE DATABASE … TEMPLATE` других вызовов."""
    engine = create_async_engine(source, isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as connection:
            await connection.execute(text(f"SELECT pg_advisory_lock({TEMPLATE_LOCK})"))
            try:
                exists = await connection.scalar(
                    text("SELECT 1 FROM pg_database WHERE datname = :name"), {"name": name}
                )
                if exists:
                    return
                stale = await connection.scalars(
                    text("SELECT datname FROM pg_database WHERE starts_with(datname, :p)"),
                    {"p": TEMPLATE_PREFIX},
                )
                for old in stale.all():
                    try:
                        await connection.execute(text(f'DROP DATABASE "{old}"'))
                    except DBAPIError:
                        pass  # К шаблону подключены — удалится при следующей сборке.
                building = f"{name}_build"
                await connection.execute(text(f'DROP DATABASE IF EXISTS "{building}"'))
                await asyncio.to_thread(create_database, source, building)
                await connection.execute(text(f'ALTER DATABASE "{building}" RENAME TO "{name}"'))
            finally:
                await connection.execute(text(f"SELECT pg_advisory_unlock({TEMPLATE_LOCK})"))
    finally:
        await engine.dispose()


def known_services() -> set[str]:
    """Службы справочника без БД — тот же `data/phonebook.json`, что засевает seed."""
    from app.seed.service_defaults import phone_services

    return set(phone_services().values())


def check_scenario(
    data: dict[str, Any],
    *,
    database: str,
    policies: list[str] | None = None,
    jobs: int = 1,
    timeout: float = WORKER_TIMEOUT,
) -> list[Violation]:
    """Нарушения связности сценария-словаря (формат файла `data/scenarios`); пусто — связен.

    `database` — адрес PostgreSQL с правом CREATE DATABASE (`postgresql+asyncpg://…`, как
    `DATABASE_URL_TEST`); `policies` — имена политик (`эталон`, `readback:met`, `readback` —
    все ветки события), без них — все; `jobs` — рабочих процессов (по умолчанию 1);
    `timeout` — сколько секунд ждать один рабочий процесс (не дождались — процесс убит,
    `StandError`). Функция синхронная: из async-кода — `asyncio.to_thread`, одновременные
    вызовы допустимы.

    Сбой стенда (не сценария) — исключение `StandError`; нарушения сценария — в списке.
    """
    from app.seed.scenarios import ScenarioFileError, validate

    code = str(data.get("code") or "generated") if isinstance(data, dict) else "generated"
    try:
        checked = validate(copy.deepcopy(data), code, known_services())
    except ScenarioFileError as error:
        return [_violation("lint", None, 0.0, str(error))]
    # Свой UUID: в шаблоне может быть сценарий того же кода и версии из каталога.
    run = {**checked, "id": str(uuid4())}
    planned = sorted(plan_jobs({code: run}, None, policies), key=lambda job: -job.weight)
    if not planned:
        return []
    template = ensure_template(database)
    prefix = f"{PREFIX}{uuid4().hex[:8]}_"
    try:
        found = _run_workers(database, template, prefix, run, planned, max(1, jobs), timeout)
    except BaseException:
        with contextlib.suppress(Exception):  # причина важнее неудалённых копий
            drop_prefixed(database, prefix)
        raise
    try:
        drop_prefixed(database, prefix)
    except Exception as error:  # noqa: BLE001
        raise StandError(f"копии БД {prefix}* не удалены: {error}") from error
    order = {job.policy.name: index for index, job in enumerate(planned)}
    found.sort(key=lambda item: (order.get(item["policy"] or "", -1), item["at"], item["rule"]))
    return found


def _run_workers(
    source: str,
    template: str,
    prefix: str,
    data: dict[str, Any],
    planned: list[Job],
    jobs: int,
    timeout: float,
) -> list[Violation]:
    """Проходы по рабочим процессам: длинные — по очереди в наименее загруженный."""
    buckets: list[list[Job]] = [[] for _ in range(min(jobs, len(planned)))]
    for job in planned:
        min(buckets, key=lambda bucket: sum(item.weight for item in bucket)).append(job)
    requests = [
        {
            "database": source,
            "template": template,
            "prefix": prefix,
            "data": data,
            "policies": [job.policy.name for job in bucket],
        }
        for bucket in buckets
    ]
    with ThreadPoolExecutor(len(requests)) as pool:
        results = list(pool.map(lambda request: _worker(request, timeout), requests))
    return [item for items in results for item in items]


def _worker(request: dict[str, Any], timeout: float) -> list[Violation]:
    """Один рабочий процесс. Не ответил за `timeout` — `subprocess.run` убивает его,
    `StandError`; его копию БД удалит `check_scenario` по префиксу."""
    try:
        done = subprocess.run(
            [sys.executable, "-m", WORKER],
            input=json.dumps(request, ensure_ascii=False),
            capture_output=True,
            text=True,
            encoding="utf-8",
            cwd=ROOT,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            check=False,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise StandError(
            f"рабочий процесс проверки не ответил за {timeout:g} с и остановлен"
        ) from None
    try:
        answer = json.loads(done.stdout)
    except json.JSONDecodeError:
        tail = done.stderr.strip()[-2000:]
        raise StandError(f"рабочий процесс проверки упал (код {done.returncode}): {tail}") from None
    if "stand_error" in answer:
        raise StandError(answer["stand_error"])
    violations: list[Violation] = answer["violations"]
    return violations


def _violation(
    rule: str, policy: str | None, at: float, detail: str, line: str | None = None
) -> Violation:
    return Violation(
        rule=rule, policy=policy, at=at, detail=detail, line=line, failing=failing(rule)
    )


# Ошибки, которые говорят о стенде, а не о сценарии: соединение, БД пропала, PostgreSQL
# остановлена. Исключение движка с ними в цепочке причин — тоже сбой стенда. Не стенд сами
# по себе: `sa_exc.InterfaceError` (им SQLAlchemy заворачивает и ошибки данных asyncpg —
# `DataError`, `ClientConfigurationError`; решает причина в цепочке) и голый `TimeoutError`
# (стенд, только если истёк в коде драйвера БД, см. `_driver_timeout`).
_STAND_ERRORS: tuple[type[BaseException], ...] = (
    ConnectionError,
    socket.gaierror,
    sa_exc.OperationalError,
    sa_exc.DisconnectionError,
    sa_exc.TimeoutError,
)
_STAND_MESSAGES = (
    "connection was closed",
    "connection is closed",
    "terminating connection",
    "the database system is",
    "being accessed by other users",
)
# Код драйвера БД: таймаут, истёкший в нём, — ожидание PostgreSQL, а не движка.
_DRIVER_PATHS = (f"{os.sep}asyncpg{os.sep}", f"{os.sep}sqlalchemy{os.sep}pool{os.sep}")


def _asyncpg_stand_errors() -> tuple[type[BaseException], ...]:
    try:
        import asyncpg  # type: ignore[import-untyped]
    except ImportError:  # pragma: no cover
        return ()
    # `asyncpg.InterfaceError` целиком не стенд: его подклассы `DataError` и
    # `ClientConfigurationError` — ошибки данных запроса; обрыв узнаём по тексту.
    return (
        asyncpg.exceptions.PostgresConnectionError,
        asyncpg.exceptions.InvalidCatalogNameError,
        asyncpg.exceptions.OperatorInterventionError,
    )


def _asyncpg_interface_error() -> tuple[type[BaseException], ...]:
    try:
        import asyncpg
    except ImportError:  # pragma: no cover
        return ()
    return (asyncpg.exceptions.InterfaceError,)


def _driver_timeout(error: BaseException) -> bool:
    """Таймаут истёк в коде драйвера БД (соединение, запрос), а не в логике движка."""
    if not isinstance(error, TimeoutError):
        return False
    return any(
        any(part in frame.filename for part in _DRIVER_PATHS)
        for frame in traceback.extract_tb(error.__traceback__)
    )


def is_stand_failure(error: BaseException) -> bool:
    """Сбой стенда: в цепочке причин — ошибка соединения или пропавшей БД, таймаут драйвера."""
    kinds = _STAND_ERRORS + _asyncpg_stand_errors()
    by_message: tuple[type[BaseException], ...] = (DBAPIError, *_asyncpg_interface_error())
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, kinds) or _driver_timeout(current):
            return True
        if isinstance(current, by_message) and any(
            message in str(current) for message in _STAND_MESSAGES
        ):
            return True
        current = current.__cause__ or current.__context__
    return False


def _template_missing(error: BaseException) -> bool:
    current: BaseException | None = error
    while current is not None:
        if "template database" in str(current) and "does not exist" in str(current):
            return True
        current = current.__cause__ or current.__context__
    return False


def run_policies(
    source: str, template: str, prefix: str, data: dict[str, Any], names: list[str]
) -> list[Violation]:
    """Проходы сценария `data` (уже проверенного, со своим UUID) по политикам `names` в этом
    процессе: копия шаблона, сценарий в ней, приложение, проходы. Рабочий процесс
    `check_worker` — единственный, кто зовёт это вне тестов (подмена часов — на процесс)."""
    url = _copy(source, template, prefix)
    code = str(data.get("code") or "generated")
    by_name = {job.policy.name: job for job in plan_jobs({code: data}, None, None)}
    selected = [by_name[name] for name in names if name in by_name]
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(_run_all(url, data, selected))
    finally:
        loop.close()


def _copy(source: str, template: str, prefix: str) -> str:
    """Копия шаблона; шаблона нет (удалён другим процессом) — собрать заново один раз."""
    name = f"{prefix}{os.getpid()}_{uuid4().hex[:6]}"
    try:
        return create_database(source, name, template)
    except Exception as error:  # noqa: BLE001
        if not _template_missing(error):
            raise StandError(
                f"копия шаблона не создана: {type(error).__name__}: {error}"
            ) from error
    forget_template(source)
    template = ensure_template(source)
    try:
        return create_database(source, name, template)
    except Exception as error:  # noqa: BLE001
        raise StandError(
            f"копия пересобранного шаблона не создана: {type(error).__name__}: {error}"
        ) from error


async def _run_all(url: str, data: dict[str, Any], jobs: list[Job]) -> list[Violation]:
    try:
        await _store(url, data)
    except Exception as error:  # noqa: BLE001
        if is_stand_failure(error):
            raise StandError(
                f"сценарий не записан в БД: {type(error).__name__}: {error}"
            ) from error
        return [
            _violation("run_failed", None, 0.0, f"запись сценария: {type(error).__name__}: {error}")
        ]
    found: list[Violation] = []
    # `_run_job` сам переводит исключение движка в `run_failed`, а сбой стенда — в
    # `StandError`; прочее отсюда — подъём или остановка приложения, это стенд.
    try:
        async with running_app(url) as app:
            for job in jobs:
                found.extend(await _run_job(app, data, job))
    except StandError:
        raise
    except Exception as error:  # noqa: BLE001 — подъём и остановка приложения — стенд
        raise StandError(f"приложение прогона: {type(error).__name__}: {error}") from error
    return found


async def _store(url: str, data: dict[str, Any]) -> None:
    from app.core.config import settings
    from app.core.db import Database
    from app.core.models import User
    from app.seed.scenarios import AudioRefs, store_scenario

    database = Database(url)
    try:
        async with database.sessions.begin() as db:
            teacher = await db.scalar(select(User).where(User.login == "teacher"))
            if teacher is None:
                raise StandError("в шаблоне нет преподавателя teacher")
            await store_scenario(
                db,
                data,
                AudioRefs(db, settings.information_audio_dir),
                plan_author_id=teacher.id,
                author_id=teacher.id,
            )
    finally:
        await database.close()


async def _run_job(app: Any, data: dict[str, Any], job: Job) -> list[Violation]:
    """Проход по одной политике. Исключение движка (в проходе или в проверке инвариантов)
    на этих данных — нарушение `run_failed`; наружу — только `StandError`."""
    name = job.policy.name
    try:
        tr = await ScenarioRun(app, SimClock(), data, job.policy, TRAINEE).run()
    except Exception as error:  # noqa: BLE001 — исключение движка на этих данных — нарушение
        return _engine_failure(name, "", error)
    try:
        speech = sorted(tr.speech(), key=lambda line: line.at)
        found = []
        for item in check(tr):
            said = [line for line in speech if line.at <= item.at + 0.05]
            line = f"{said[-1].who}: {said[-1].text}" if said else None
            found.append(_violation(item.rule, name, item.at, item.detail, line))
    except Exception as error:  # noqa: BLE001 — то же для проверки инвариантов
        return _engine_failure(name, "проверка инвариантов: ", error)
    return found


def _engine_failure(policy: str, stage: str, error: Exception) -> list[Violation]:
    """Исключение движка: сбой стенда в цепочке причин — `StandError`, иначе `run_failed`."""
    if is_stand_failure(error):
        raise StandError(f"проход {policy}: {stage}{type(error).__name__}: {error}") from error
    return [_violation("run_failed", policy, 0.0, f"{stage}{type(error).__name__}: {error}")]
