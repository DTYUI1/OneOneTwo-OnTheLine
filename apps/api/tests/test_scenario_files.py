"""Каталог сценариев формата 2 (GP-03): один файл data/scenarios/<code>.json — один сценарий.

Новый сценарий — новый файл без правки кода; файл с ошибкой отклоняется с понятным
сообщением; изменение — новая версия, выданное не переписывается.
"""

import asyncio
import copy
import json
import shutil
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.api.sessions.practice import step_pool
from app.core.config import ROOT
from app.core.contracts import validate_json
from app.core.models import Scenario, ScenarioTrainingPlan
from app.seed import practice
from app.seed.scenarios import (
    SCENARIOS_DIR,
    ScenarioFileError,
    load_catalog,
    read_file,
    scenario_row,
    scenario_uuid,
    seed_scenarios,
    training_plan,
)
from evalcore.progress import step_by_number  # type: ignore[import-untyped]
from fastapi.testclient import TestClient

from .test_c04_completion import seed_training
from .test_lifecycle import login, run_db

SERVICES = {item["id"] for item in json.loads((ROOT / "data/phonebook.json").read_text("utf-8"))}
SAMPLE = SCENARIOS_DIR / "smoke-apartment-101-1.json"
# Новый файл в каталог — копия сценария, который проходит линтер связности.
NEW_SAMPLE = SCENARIOS_DIR / "lift-stuck-101-1.json"
VOICES = ROOT / "data" / "voices"


def sample(code: str, source: Path = SAMPLE) -> dict:
    """Новый сценарий на основе готового: свой код, без прежнего id."""
    data = json.loads(source.read_text(encoding="utf-8"))
    data.pop("id", None)
    data.pop("replaces", None)
    data["version"] = 1
    data["code"] = code
    data["card"]["number"] = f"9{uuid4().int % 10**7:07d}"
    return data


def write(directory: Path, data: dict) -> Path:
    path = directory / f"{data['code']}.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path


def test_every_repository_file_loads():
    catalog = load_catalog(SERVICES)
    assert catalog.rejected == []
    assert len(catalog.scenarios) == len(list(SCENARIOS_DIR.glob("*.json"))) > 0


def test_no_scenario_requires_call_to_own_service():
    """GP-04: диспетчер ДДС работает с бригадами, звонок своей службе не обязателен.
    Доклад абоненту телефона ДДС (contact_role, GP-09) — не звонок своей службе."""
    for data in load_catalog(SERVICES).scenarios:
        call = data["reference"]["expected_call"]
        own = call["service_id"] == data["service_id"] and not call.get("contact_role")
        assert not (call["required"] and own), data["code"]


# Фразы на своём этапе («поднимаемся» не из дороги, проверка 17.10) — правило линтера
# связности для всех событий и веток: app.seed.scenario_lint, tests/test_scenario_lint.py.


def test_file_with_required_call_to_own_service_is_rejected(tmp_path):
    data = sample("own-call")
    data["reference"]["expected_call"]["required"] = True
    with pytest.raises(ValueError, match="обязательный звонок своей службе"):
        read_file(write(tmp_path, data), SERVICES)


def test_file_without_full_plan_is_rejected_with_reason(tmp_path):
    data = sample("no-completion")
    data["plan"] = [item for item in data["plan"] if item["justifies_state"] != "completed"]
    with pytest.raises(ValueError, match="нет плана до завершения.*«Работы завершены»"):
        read_file(write(tmp_path, data), SERVICES)


def test_file_with_unknown_service_is_rejected_with_reason(tmp_path):
    data = sample("unknown-service")
    data["service_id"] = "999"
    with pytest.raises(ValueError, match="неизвестная служба «999»"):
        read_file(write(tmp_path, data), SERVICES)


def test_broken_references_and_schema_are_named(tmp_path):
    data = sample("broken")
    data["events"][0]["trigger"]["report"] = "nowhere"
    data["traps"] = ["ghost"]
    data["input_parts"] = {"address": [{"text": "Дубнинская, 12", "correct": False}]}
    with pytest.raises(ValueError) as error:
        read_file(write(tmp_path, data), SERVICES)
    message = str(error.value)
    assert message.startswith("broken.json: ")
    assert "неизвестный доклад «nowhere»" in message
    assert "ловушка «ghost»" in message
    assert "нужен ровно один верный" in message
    data = sample("schema")
    del data["plan"][0]["requires_state"]
    with pytest.raises(ValueError, match="schema.json: не по схеме.*plan/0.*requires_state"):
        read_file(write(tmp_path, data), SERVICES)
    catalog = load_catalog(SERVICES, tmp_path)
    assert catalog.scenarios == [] and len(catalog.rejected) == 2


FINAL_OUTCOMES = (
    "smoke-apartment-101-1",
    "traffic-blocked-102-2",
    "unwell-street-103-2",
    "gas-entrance-104-2",
    "not-ours-pipe-104-2",
    "animal-shaft-gkh-1",
)


def test_final_scenarios_have_own_outcome():
    """GP-27: у шести сценариев набора на финал свой исход — полный ход и поздняя «Принята»;
    у 101 горит проводка за шкафом, а не кухня (так говорит сам сценарий)."""
    seen = set()
    for code in FINAL_OUTCOMES:
        outcome = read_file(SCENARIOS_DIR / f"{code}.json", SERVICES)["outcome"]
        assert outcome["people"] and outcome["late"], code
        seen.add(outcome["people"])
    assert len(seen) == len(FINAL_OUTCOMES)
    smoke = json.dumps(sample("smoke-apartment-101-1")["outcome"], ensure_ascii=False)
    assert "проводка за шкафом" in smoke
    assert "кухн" not in smoke
    assert "газ на квартиру" not in smoke


def test_outcome_goes_to_plan_and_is_optional():
    """Исход из файла попадает в план как есть; сценарий без блока (старый) плана не меняет."""

    async def stub(path: str, text: str) -> dict:
        return {"path": path, "text": text}

    data = sample("outcome-check")
    plan = asyncio.run(training_plan(data, stub))
    assert plan["outcome"] == data["outcome"]
    validate_json(plan["outcome"], "urn:openapi#/components/schemas/ScenarioOutcome")
    del data["outcome"]
    assert "outcome" not in asyncio.run(training_plan(data, stub))


def test_outcome_block_is_checked_by_schema(tmp_path):
    data = sample("outcome-broken")
    data["outcome"] = {"people": "Расчёт приехал."}
    with pytest.raises(ScenarioFileError, match="late"):
        read_file(write(tmp_path, data), SERVICES)


def test_files_with_previous_id_keep_issued_plan():
    """Перевод data/practice сохранил UUID, план и эталон: на развёрнутых стендах сценарий
    не задваивается, старые журналы ссылаются на те же доклады. Версия 2 (GP-04: звонок
    своей службе не обязателен) отличается от перенесённой только этим — проверяем её
    перенесённый вид: id из replaces, версия 1, звонок обязателен."""

    async def stub(path: str, text: str) -> dict:
        return {"path": path, "text": text}

    phonebook = json.loads((ROOT / "data/phonebook.json").read_text("utf-8"))
    ext = {item["id"]: item["phone_ext"] for item in phonebook}
    files = {}
    for data in load_catalog(SERVICES).scenarios:
        if data["version"] == 2 and len(data.get("replaces", [])) == 1:
            first = copy.deepcopy(data)
            first["id"] = first.pop("replaces")[0]
            first["version"] = 1
            first["reference"]["expected_call"]["required"] = True
            files[first["id"]] = first
        elif data.get("id"):
            files[data["id"]] = data
    checked = 0
    for incident in practice.load_incidents():
        for service_id, level in practice.variants(incident):
            sid = practice.scenario_id(incident["key"], service_id, level)
            data = files.get(str(sid))
            if data is None or data["version"] != 1:
                continue
            variant = incident["services"][service_id]
            stages = practice.stages(variant, level)
            block = practice.live(variant, level)
            events, lines = (
                practice.live_events(sid, incident["key"], service_id, block) if block else ([], [])
            )
            for line in lines:
                line.message["audio"] = {"path": line.audio_path, "text": line.message["text"]}
            audios = [
                {
                    "path": practice.audio_path(incident["key"], service_id, level, s.name),
                    "text": s.text,
                }
                for s in stages
            ]
            issued = practice.training_plan(
                sid, service_id, stages, audios, events, block.get("after_s") if block else None
            )
            assert asyncio.run(training_plan(data, stub)) == issued, data["code"]
            row = scenario_row(data)
            payload = practice.scenario_payload(incident, service_id, level, ext[service_id])
            payload["reference"]["expected_call"]["required"] = True
            assert {**row, "id": str(row["id"])} == payload, data["code"]
            checked += 1
    if checked == 0:
        # С 17.10 все перенесённые сценарии выпущены новыми версиями (голос банка, ветки):
        # файлов версии 2 с прежним id не осталось, выданный стендам план версии 1 живёт в базе.
        pytest.skip("перенесённых файлов версии 2 не осталось")


def test_new_file_reaches_catalog_and_practice_pool(database_config, database_url, tmp_path):
    seed_training(database_url)
    directory = tmp_path / "scenarios"
    shutil.copytree(SCENARIOS_DIR, directory)
    data = sample(f"new-{uuid4().hex[:8]}", NEW_SAMPLE)
    write(directory, data)
    new_id = scenario_uuid(data)

    async def seed(db):
        return [item.id for item in await seed_scenarios(db, VOICES, directory)]

    assert new_id in run_db(database_url, seed)

    async def pool(db):
        return {item.id for item in await step_pool(db, step_by_number(2), "101")}

    assert new_id in run_db(database_url, pool)
    with TestClient(create_database_app(database_config)) as client:
        login(client)
        playable = client.get("/api/scenarios/playable").json()["scenario_ids"]
        assert str(new_id) in playable


def test_change_is_new_version_and_issued_is_not_rewritten(database_url, tmp_path):
    seed_training(database_url)
    data = sample(f"versioned-{uuid4().hex[:8]}", NEW_SAMPLE)
    write(tmp_path, data)
    first = scenario_uuid(data)

    async def seed(db):
        await seed_scenarios(db, VOICES, tmp_path)

    async def state(db, scenario_id: UUID):
        scenario = await db.get(Scenario, scenario_id)
        plan = await db.get(ScenarioTrainingPlan, (scenario_id, 1))
        return scenario.status, scenario.card["description"], plan.plan if plan else None

    run_db(database_url, seed)
    status, description, plan = run_db(database_url, lambda db: state(db, first))
    assert status == "approved"

    # Та же версия с другим текстом: выданный сценарий и план не переписываются.
    data["card"]["description"] = "Изменено без новой версии."
    data["plan"][0]["line"] = "Другой текст доклада."
    write(tmp_path, data)
    run_db(database_url, seed)
    assert run_db(database_url, lambda db: state(db, first)) == (status, description, plan)

    # Новая версия — новый сценарий; прежняя снята с выдачи, её план на месте.
    data["version"] = 2
    write(tmp_path, data)
    run_db(database_url, seed)
    second = scenario_uuid(data)
    assert second != first
    assert run_db(database_url, lambda db: state(db, first)) == ("retired", description, plan)
    status, new_description, new_plan = run_db(database_url, lambda db: state(db, second))
    assert status == "approved" and new_description == "Изменено без новой версии."
    assert new_plan is None  # план версии 2 хранится под scenario_version = 2

    async def second_plan(db):
        return await db.get(ScenarioTrainingPlan, (second, 2))

    assert run_db(database_url, second_plan).plan["messages"][0]["message"]["text"] == (
        "Другой текст доклада."
    )
