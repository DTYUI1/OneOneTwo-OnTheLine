"""Недоступный проход не допускает модель к занятию; адрес не меняет учебный путь."""

import asyncio
from copy import deepcopy
from types import SimpleNamespace
from uuid import uuid4

import pytest
from app.api.scenarios.service import serialize, update_scenario
from app.core.config import settings
from app.core.db import Database
from app.core.models import AuditLog, Scenario, ScenarioTrainingPlan, User
from app.tools.coherence import check as check_module
from app.worker.generators import addresses, gameplay, storage, variant_paths, variation
from app.worker.generators.validation import GenerationRejected
from sqlalchemy import select

from .test_scenario_generation import ScriptedLLM


def build_without_trap():
    template = next(t for t in gameplay.templates() if t["code"] == "pipe-flat-gkh-2")
    prepared = next(
        data
        for source, data in variant_paths.options("GKH", 2).values()
        if source["code"] == template["code"]
        and not any(e["kind"] == "readback_error" for e in data["events"])
    )
    spec = gameplay.gameplay_input(
        service_id="GKH", level=2, seed=42, template=template, prepared=prepared
    )
    data = gameplay.build_gameplay(
        spec, gameplay.fallback_response(spec), scenario_id=uuid4(), origin="llm", auto_admit=False
    )
    return spec, data


def test_new_address_is_consistent_deterministic_and_not_a_new_path():
    spec, data = build_without_trap()
    old = spec["template"]["card"]["address"]
    assert data["card"]["address"]["street"] != old["street"]
    assert data["reference"]["expected_address"] == data["card"]["address"]
    assert data["card"]["address"]["apartment"] == old["apartment"]
    assert variant_paths.signature(data, "same") == variant_paths.signature(
        spec["template"], "same"
    )
    from app.seed.card_fields import fill

    label = fill("{address}", data["card"])
    assert data["card"]["address"]["street"] in label and old["street"] not in label
    assert old["street"] not in data["reference"]["expected_comment"]
    gameplay.check_file(data)
    _, again = build_without_trap()
    assert again["card"]["address"] == data["card"]["address"]


def test_trap_preserves_address():
    source = next(t for t in gameplay.templates() if t["code"] == "pipe-flat-gkh-2")
    spec = gameplay.gameplay_input(service_id="GKH", level=3, seed=42, template=source)
    data = gameplay.build_gameplay(
        spec, gameplay.fallback_response(spec), scenario_id=uuid4(), origin="llm", auto_admit=False
    )
    assert any(e["kind"] == "readback_error" for e in data["events"])
    assert data["card"]["address"] == source["card"]["address"]


@pytest.mark.parametrize("place", ["report", "branch", "replacement", "description", "outcome"])
def test_spoken_or_written_template_location_blocks_change(place):
    spec, data = build_without_trap()
    data["card"]["address"] = deepcopy(spec["template"]["card"]["address"])
    data["reference"]["expected_address"] = deepcopy(data["card"]["address"])
    assert addresses.change(deepcopy(data), 1)
    text = "Едем на Кировоградскую улицу, дом двадцать два."
    if place == "report":
        data["plan"][0]["line"]["text"] = text
    elif place == "description":
        data["card"]["description"] = text
    elif place == "outcome":
        data["outcome"] = {"why": {"text": text}}
    else:
        event = deepcopy(next(e for e in spec["base_template"]["events"] if e["kind"] == "clarify"))
        branch = next(iter(event["branches"].values()))
        if place == "branch":
            branch["line"] = {"text": text}
        else:
            branch["effects"] = [{"replace": "arrival", "with": {"text": text}}]
        data["events"] = [event]
    original = deepcopy(data)
    assert not addresses.change(data, 1)
    assert data == original


@pytest.mark.usefixtures("clean_generated_content")
@pytest.mark.parametrize("service_id,auto_admit", [("GKH", False), ("101", True)])
def test_stand_error_catalog_for_lesson_marked_draft_for_studio(
    database_url, monkeypatch, service_id, auto_admit
):
    monkeypatch.setattr(settings, "generation_coherence", True)

    def unavailable(*args, **kwargs):
        raise check_module.StandError("Проверочный стенд недоступен")

    monkeypatch.setattr(check_module, "check_scenario", unavailable)
    built = []
    original = gameplay.build_gameplay

    def capture(*args, **kwargs):
        data = original(*args, **kwargs)
        built.append(data)
        return data

    monkeypatch.setattr(gameplay, "build_gameplay", capture)

    async def run():
        database = Database(database_url)
        try:
            async with database.sessions.begin() as db:
                teacher = await db.scalar(select(User).where(User.login == "teacher"))
                row = await storage.generate_one(
                    db,
                    ScriptedLLM(),
                    scenario_id=uuid4(),
                    author_id=teacher.id,
                    service_id=service_id,
                    level=4,
                    seed=42,
                    auto_admit=auto_admit,
                )
                metadata = row.generation_metadata
                assert metadata["coherence"]["stand_unavailable"] is True
                assert metadata["coherence"]["status"] == ("catalog" if auto_admit else "unchecked")
                assert row.origin == ("template" if auto_admit else "llm")
                assert row.status == ("approved" if auto_admit else "draft")
                assert serialize(row).coherence_unchecked is (not auto_admit)
                assert metadata["attempts"][0]["accepted"] is (not auto_admit)
                if auto_admit:
                    source = next(
                        t
                        for t in gameplay.templates()
                        if t["code"] == metadata["constructor"]["template"]
                    )
                    assert built[-1]["events"] == source["events"]
                    assert row.card["address"] == source["card"]["address"]
                    assert [r["line"] for r in built[-1]["plan"]] == [
                        r["line"] for r in source["plan"]
                    ]
                    gameplay.check_file(built[-1])
                    assert row.level == 4
                    assert metadata["constructor"]["level"] == 4
                    assert metadata["constructor"]["requested_level"] == 4
                    assert variation.checked(built[-1], 4)
                    assert built[-1]["plan"] == source["plan"]
                    assert row.reference["expected_address"] == source["card"]["address"]
                    assert row.reference["expected_flow"] == source["reference"]["expected_flow"]
                    plan = await db.get(ScenarioTrainingPlan, (row.id, row.version))
                    assert variation.level_ok(plan.plan["events"], 4)
                else:
                    assert "Связность не проверена" in row.teacher_comment
                    forged = serialize(row).model_copy(
                        update={"status": "approved", "coherence_unchecked": False}
                    )
                    request = SimpleNamespace(state=SimpleNamespace(db=db))
                    saved = await update_scenario(request, row.id, forged)
                    assert saved.status == "approved" and saved.coherence_unchecked
                    assert row.generation_metadata == metadata
                await db.rollback()
        finally:
            await database.close()

    asyncio.run(run())


@pytest.mark.usefixtures("clean_generated_content")
def test_stand_error_rejects_unavailable_catalog_level_without_writes(database_url, monkeypatch):
    monkeypatch.setattr(settings, "generation_coherence", True)

    def unavailable(*args, **kwargs):
        raise check_module.StandError("Проверочный стенд недоступен")

    monkeypatch.setattr(check_module, "check_scenario", unavailable)
    # У ЖКХ нет целого каталожного пути уровня 4: уровень 2 не заменяет его.
    assert not any(
        variation.checked(t, 4) for t in gameplay.templates() if t["service_id"] == "GKH"
    )

    async def run():
        database = Database(database_url)
        scenario_id = uuid4()
        try:
            async with database.sessions.begin() as db:
                teacher = await db.scalar(select(User).where(User.login == "teacher"))
                with pytest.raises(
                    GenerationRejected, match="Нет проверенного каталожного пути уровня 4"
                ):
                    await storage.generate_one(
                        db,
                        ScriptedLLM(),
                        scenario_id=scenario_id,
                        author_id=teacher.id,
                        service_id="GKH",
                        level=4,
                        seed=42,
                        auto_admit=True,
                    )
            # Исключение перехвачено до commit: rollback не скрывает случайные записи.
            async with database.sessions() as db:
                assert await db.get(Scenario, scenario_id) is None
                assert await db.get(ScenarioTrainingPlan, (scenario_id, 1)) is None
                assert (
                    await db.scalar(
                        select(AuditLog.id).where(AuditLog.entity_id == str(scenario_id))
                    )
                    is None
                )
        finally:
            await database.close()

    asyncio.run(run())
