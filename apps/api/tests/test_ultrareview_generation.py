"""PR109 G06/G07: реальные генератор и PostgreSQL, провайдер и сбой стенда управляемые."""

import asyncio
from uuid import uuid4

import pytest
from app.core.config import settings
from app.core.db import Database
from app.core.models import AuditLog, Scenario, ScenarioTrainingPlan, User
from app.worker.generators import gameplay, storage, variant_paths, variation
from app.worker.generators.validation import GenerationRejected
from sqlalchemy import select

from .test_scenario_generation import ScriptedLLM


async def isolated_teacher(db):
    """Retired-сценарий остаётся в lifetime-истории только своего нового автора."""
    sample = await db.scalar(select(User).where(User.login == "teacher"))
    teacher = User(
        login=uuid4().hex,
        password_hash=sample.password_hash,
        role=sample.role,
        full_name=sample.full_name,
        is_active=sample.is_active,
        workstation_number=sample.workstation_number,
        dds_service_id=sample.dds_service_id,
    )
    db.add(teacher)
    await db.flush()
    return teacher


@pytest.mark.usefixtures("clean_generated_content")
@pytest.mark.parametrize(
    "service,level",
    [(service, 3) for service in sorted(gameplay.SERVICES)]
    + [(service, 4) for service in ("101", "103", "104")],
)
def test_catalog_fallback_preserves_actual_requested_complexity(
    database_url, monkeypatch, service, level
):
    monkeypatch.setattr(settings, "generation_coherence", True)

    async def unavailable(db, data):
        return None

    monkeypatch.setattr(storage, "coherence", unavailable)
    built = []
    original = gameplay.build_gameplay

    def capture(*args, **kwargs):
        data = original(*args, **kwargs)
        built.append(data)
        return data

    monkeypatch.setattr(gameplay, "build_gameplay", capture)

    async def run():
        database = Database(database_url)
        scenario_id = uuid4()
        llm = ScriptedLLM()
        try:
            async with database.sessions.begin() as db:
                teacher = await isolated_teacher(db)
                await storage.generate_one(
                    db,
                    llm,
                    scenario_id=scenario_id,
                    author_id=teacher.id,
                    service_id=service,
                    level=level,
                    seed=42,
                    weight=9,
                    auto_admit=True,
                )
            # Проверяем commit отдельным соединением, а не только возвращённый ORM-объект.
            async with database.sessions() as db:
                row = await db.get(Scenario, scenario_id)
                plan = await db.get(ScenarioTrainingPlan, (row.id, row.version))
                metadata = row.generation_metadata
                assert row.level == level
                assert row.weight == 9
                assert metadata["constructor"]["level"] == level
                assert metadata["constructor"]["requested_level"] == level
                assert metadata["input"]["level"] == level
                assert variation.checked(built[-1], level)
                assert variation.level_ok(plan.plan["events"], level)
                source = next(
                    t
                    for t in gameplay.templates()
                    if t["code"] == metadata["constructor"]["template"]
                )
                assert built[-1]["events"] == source["events"]
                assert built[-1]["plan"] == source["plan"]
                assert row.reference["expected_flow"] == built[-1]["reference"]["expected_flow"]
                assert [m["justifies_state"] for m in plan.plan["messages"]] == row.reference[
                    "expected_flow"
                ][2:]
                assert (
                    row.reference["expected_address"]
                    == row.card["address"]
                    == source["card"]["address"]
                )
                assert metadata["constructor"]["variation"] == variation.describe(built[-1], source)
                assert metadata["constructor"]["variant_signature"] == variant_paths.signature(
                    built[-1], source["code"]
                )
                assert row.origin == "template" and row.status == "approved"
                assert metadata["fallback_used"] and metadata["auto_admitted"]
                assert metadata["coherence"]["status"] == "catalog"
                assert metadata["coherence"]["stand_unavailable"]
                assert llm.calls == 1
                assert await db.scalar(
                    select(AuditLog.id).where(
                        AuditLog.entity_id == str(row.id), AuditLog.action == "autoAdmitScenario"
                    )
                )
        finally:
            await database.close()

    asyncio.run(run())


@pytest.mark.usefixtures("clean_generated_content")
@pytest.mark.parametrize("service", ["GKH", "102", "MOSLIFT"])
def test_catalog_fallback_refuses_unavailable_complexity_without_writes(
    database_url, monkeypatch, service
):
    monkeypatch.setattr(settings, "generation_coherence", True)

    async def unavailable(db, data):
        return None

    monkeypatch.setattr(storage, "coherence", unavailable)
    assert not any(
        variation.checked(t, 4) for t in gameplay.templates() if t["service_id"] == service
    )

    async def run():
        database = Database(database_url)
        scenario_id = uuid4()
        try:
            async with database.sessions.begin() as db:
                teacher = await isolated_teacher(db)
                with pytest.raises(GenerationRejected, match="уровн"):
                    await storage.generate_one(
                        db,
                        ScriptedLLM(),
                        scenario_id=scenario_id,
                        author_id=teacher.id,
                        service_id=service,
                        level=4,
                        seed=42,
                        auto_admit=True,
                    )
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
