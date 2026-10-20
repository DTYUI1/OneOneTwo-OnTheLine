"""Проверка сценария-словаря прогоном связности (HQ-027, генератор карточек).

Сценарий не из файла: генератор передаёт словарь и получает нарушения на вторую попытку.
Нужна PostgreSQL (`DATABASE_URL_TEST`); проходы — в рабочих процессах, по выбранным
политикам, чтобы тест шёл секунды. Сбой стенда — исключение `StandError`, не нарушение.
"""

import asyncio
import copy
import json
import os
from typing import Any

import asyncpg
import pytest
from app.core.config import ROOT
from app.seed.scenarios import validate
from app.tools.coherence import check as check_module
from app.tools.coherence.check import (
    StandError,
    check_scenario,
    ensure_template,
    known_services,
    run_policies,
)
from app.tools.coherence.harness import PREFIX, create_database, drop_prefixed
from sqlalchemy import text
from sqlalchemy.exc import InterfaceError, OperationalError
from sqlalchemy.ext.asyncio import create_async_engine

CODE = "fight-street-102-2"


@pytest.fixture(scope="module")
def source() -> str:
    url = os.environ.get("DATABASE_URL_TEST")
    if not url:
        pytest.skip("Для прогона связности нужен PostgreSQL: DATABASE_URL_TEST.")
    return url


def scenario() -> dict[str, Any]:
    path = ROOT / "data" / "scenarios" / f"{CODE}.json"
    return json.loads(path.read_text(encoding="utf-8"))


def test_clean_scenario_has_no_violations(source):
    data = scenario()
    original = copy.deepcopy(data)
    found = check_scenario(data, database=source, policies=["эталон", "caller-phone"], jobs=1)
    assert found == []
    # Словарь генератора не меняется: свой UUID прогона — у копии.
    assert data == original


def test_broken_branch_answer_is_reported_with_line(source):
    data = scenario()
    event = next(item for item in data["events"] if item["key"] == "caller-phone")
    # Ответ из дороги в ветке «late», когда бригада уже на месте: линтер ветку late не
    # проверяет (ответ звучит, когда придётся), прогон слышит противоречие этапу.
    event["branches"]["late"]["line"] = "Понял, выезжаем на адрес."
    found = check_scenario(data, database=source, policies=["caller-phone:late"], jobs=1)
    assert [(item["rule"], item["policy"]) for item in found] == [
        ("stage_regress", "caller-phone:late")
    ]
    assert found[0]["line"] == "Бригада 203: Понял, выезжаем на адрес."
    assert found[0]["failing"] is True


def test_loader_error_is_one_lint_violation(source):
    data = scenario()
    data["traps"] = ["no-such-event"]
    found = check_scenario(data, database=source, jobs=1)
    assert len(found) == 1
    assert found[0]["rule"] == "lint"
    assert found[0]["policy"] is None
    assert "ловушка «no-such-event»: нет такого события" in found[0]["detail"]


def test_loader_error_does_not_need_database():
    """Ошибка линтера — сразу, без шаблона и без БД (справочник служб — из data)."""
    data = scenario()
    data["traps"] = ["no-such-event"]
    found = check_scenario(data, database="postgresql+asyncpg://x:x@127.0.0.1:1/x")
    assert [item["rule"] for item in found] == ["lint"]


def test_unreachable_database_is_stand_error():
    with pytest.raises(StandError, match="шаблон БД"):
        check_scenario(scenario(), database="postgresql+asyncpg://x:x@127.0.0.1:1/x")


def broken() -> dict[str, Any]:
    data = scenario()
    event = next(item for item in data["events"] if item["key"] == "caller-phone")
    event["branches"]["late"]["line"] = "Понял, выезжаем на адрес."
    return data


def test_parallel_calls_do_not_mix(source):
    """Два вызова из потоков одновременно: у каждого свой результат."""

    async def both() -> list[list[Any]]:
        return list(
            await asyncio.gather(
                asyncio.to_thread(check_scenario, scenario(), database=source, policies=["эталон"]),
                asyncio.to_thread(
                    check_scenario, broken(), database=source, policies=["caller-phone:late"]
                ),
            )
        )

    clean, dirty = asyncio.run(both())
    assert clean == []
    assert [(item["rule"], item["policy"]) for item in dirty] == [
        ("stage_regress", "caller-phone:late")
    ]


def test_several_workers_give_same_result(source):
    policies = ["эталон", "caller-phone:late", "caller-phone:met"]
    one = check_scenario(broken(), database=source, policies=policies, jobs=1)
    two = check_scenario(broken(), database=source, policies=policies, jobs=3)
    assert one == two
    assert [item["policy"] for item in two] == ["caller-phone:late"]


def checked() -> dict[str, Any]:
    data = validate(scenario(), CODE, known_services())
    return {**data, "id": "6d1c2c3e-0000-4000-8000-000000000001"}


def test_missing_template_is_rebuilt_once(source, monkeypatch):
    """Шаблон удалён другим процессом: кэш сбрасывается, шаблон берётся заново."""
    real = ensure_template(source)
    gone = real.rsplit("/", 1)[0] + "/arm112_coherence_tpl_gone"
    monkeypatch.setitem(check_module._templates, source, gone)
    prefix = f"{PREFIX}t{os.getpid()}_"
    try:
        found = run_policies(source, gone, prefix, checked(), ["эталон"])
    finally:
        drop_prefixed(source, prefix)
    assert found == []
    assert check_module._templates[source] == real


def wrapped(error: BaseException) -> InterfaceError:
    """Как SQLAlchemy заворачивает ошибку asyncpg: `sa_exc.InterfaceError` с причиной."""
    outer = InterfaceError("SELECT 1", {}, error)
    outer.__cause__ = error
    return outer


@pytest.mark.parametrize(
    ("error", "stand"),
    [
        (ValueError("движок упал на этих данных"), False),
        (OperationalError("SELECT 1", {}, ConnectionRefusedError("refused")), True),
        # Ошибки данных запроса — сценарий, а не стенд, хоть и InterfaceError.
        (wrapped(asyncpg.exceptions.DataError("invalid input for query argument $1")), False),
        (asyncpg.exceptions.ClientConfigurationError("bad option"), False),
        # Таймаут в логике движка (ожидание события), не в драйвере БД.
        (TimeoutError(), False),
        (wrapped(asyncpg.exceptions.ConnectionDoesNotExistError("connection was closed")), True),
        (wrapped(asyncpg.exceptions.InterfaceError("cannot call: connection is closed")), True),
    ],
)
def test_engine_error_or_stand_failure(source, monkeypatch, error, stand):
    """Исключение движка — нарушение run_failed; потеря соединения — StandError."""

    async def fail(self: Any) -> None:
        raise error

    monkeypatch.setattr(check_module.ScenarioRun, "run", fail)
    template = ensure_template(source)
    prefix = f"{PREFIX}e{os.getpid()}_"
    try:
        if stand:
            with pytest.raises(StandError, match="проход эталон"):
                run_policies(source, template, prefix, checked(), ["эталон"])
        else:
            found = run_policies(source, template, prefix, checked(), ["эталон"])
            assert [(item["rule"], item["failing"]) for item in found] == [("run_failed", True)]
    finally:
        drop_prefixed(source, prefix)


def test_driver_timeout_is_stand_failure(source):
    """Таймаут, истёкший в драйвере БД (подключение), — стенд; голый таймаут — нет."""

    async def connect() -> BaseException:
        url = source.replace("postgresql+asyncpg://", "postgresql://")
        try:
            await asyncpg.connect(url, timeout=1e-9)
        except TimeoutError as error:
            return error
        pytest.skip("подключение успело раньше таймаута")

    assert check_module.is_stand_failure(asyncio.run(connect()))
    assert not check_module.is_stand_failure(TimeoutError())


def test_invariant_error_is_run_failed_and_keeps_other_policies(source, monkeypatch):
    """Исключение проверки инвариантов на одной политике — run_failed этой политики;
    нарушения других политик того же процесса не теряются."""
    real = check_module.check

    def flaky(tr: Any) -> Any:
        if tr.policy == "эталон":
            raise KeyError("нет такого поля")
        return real(tr)

    monkeypatch.setattr(check_module, "check", flaky)
    data = {**validate(broken(), CODE, known_services()), "id": checked()["id"]}
    template = ensure_template(source)
    prefix = f"{PREFIX}i{os.getpid()}_"
    try:
        found = run_policies(source, template, prefix, data, ["caller-phone:late", "эталон"])
    finally:
        drop_prefixed(source, prefix)
    assert [(item["rule"], item["policy"]) for item in found] == [
        ("stage_regress", "caller-phone:late"),
        ("run_failed", "эталон"),
    ]
    assert "проверка инвариантов: KeyError" in found[1]["detail"]


def test_worker_crash_without_answer_is_stand_error(source, monkeypatch):
    monkeypatch.setattr(check_module, "WORKER", "app.tools.coherence.no_such_worker")
    with pytest.raises(StandError, match="рабочий процесс проверки упал"):
        check_scenario(scenario(), database=source, policies=["эталон"])


def test_worker_timeout_is_stand_error(source):
    with pytest.raises(StandError, match="не ответил за 0.5 с"):
        check_scenario(scenario(), database=source, policies=["эталон"], timeout=0.5)


def databases(source: str, prefix: str) -> list[str]:
    async def names() -> list[str]:
        engine = create_async_engine(source)
        try:
            async with engine.connect() as connection:
                found = await connection.scalars(
                    text("SELECT datname FROM pg_database WHERE starts_with(datname, :p)"),
                    {"p": prefix},
                )
                return list(found)
        finally:
            await engine.dispose()

    return asyncio.run(names())


def test_copies_dropped_after_stand_error(source, monkeypatch):
    """При jobs > 1 один процесс сделал копию, другой упал: после StandError копий нет."""
    prefixes: list[str] = []

    def worker(request: dict[str, Any], timeout: float) -> list[Any]:
        prefixes.append(request["prefix"])
        if "эталон" in request["policies"]:
            create_database(source, f"{request['prefix']}copy", request["template"])
            return []
        raise StandError("рабочий процесс проверки упал (код 1)")

    monkeypatch.setattr(check_module, "_worker", worker)
    with pytest.raises(StandError, match="упал"):
        check_scenario(
            scenario(), database=source, policies=["эталон", "caller-phone:late"], jobs=2
        )
    assert prefixes and len(set(prefixes)) == 1
    assert databases(source, prefixes[0]) == []
