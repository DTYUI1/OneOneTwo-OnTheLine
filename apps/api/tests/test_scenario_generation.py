"""Полный цикл генерации: допуск, доклады, происхождение, аренда и восстановление."""

import asyncio
import json
import re
from datetime import UTC, datetime, timedelta
from itertools import product
from uuid import uuid4

import pytest
from app.core.config import ROOT
from app.core.db import Database
from app.core.models import Job, Scenario, ScenarioTrainingPlan, User
from app.worker.generators.phrases import conflicts
from app.worker.generators.scenario import (
    REFUSAL_ARRIVAL,
    build_scenario,
    fallback_response,
    generation_input,
)
from app.worker.generators.storage import generate_bank_one
from app.worker.generators.validation import GenerationRejected
from app.worker.queue import enqueue_job
from app.worker.runtime import Worker
from sqlalchemy import select, update

BANK_TEXTS = {
    service: {
        item["text"]
        for item in json.loads(
            (ROOT / f"scripts/voices/bank/phrases/{service}.json").read_text(encoding="utf-8")
        )["phrases"]
    }
    for service in ("101", "102", "103", "104", "GKH", "MOSLIFT")
}


@pytest.mark.parametrize("service", ["101", "102", "103", "104", "GKH", "MOSLIFT"])
@pytest.mark.parametrize("level", [1, 2, 3, 4])
def test_supported_services_and_levels_have_reachable_report_bases(service, level):
    for seed in range(3):
        spec = generation_input(service_id=service, level=level, seed=seed)
        scenario, plan = build_scenario(
            spec,
            fallback_response(spec, seed),
            scenario_id=uuid4(),
            brigade_id=uuid4(),
            target_id=uuid4(),
            phone_ext="201",
            origin="template",
            auto_admit=True,
        )
        flow = scenario["reference"]["expected_flow"]
        assert [m["justifies_state"] for m in plan["messages"]] == flow[2:]
        assert [m["requires_state"] for m in plan["messages"]] == flow[1:-1]
        assert all(m["message"]["audio"] is None for m in plan["messages"])
        assert scenario["card"]["service_ids"] == scenario["reference"]["expected_service_ids"]
        # Мослифт: застревание и ребёнок в лифте — люди заблокированы, неисправность — нет.
        assert scenario["card"]["blocked_people"] == (service == "MOSLIFT" and seed in (0, 1))
        assert (flow[-1] == "refused") == (level == 2 and service != "103")
        assert len(plan.get("events", [])) == max(0, level - 2)
        # Реплики бригады — фразы банка (прибытие при отказе — текстом, его в банке нет).
        assert all(
            m["message"]["text"] in BANK_TEXTS[service] or m["message"]["text"] == REFUSAL_ARRIVAL
            for m in plan["messages"]
        )
        for event in plan.get("events", []):
            lines = [event["line"], *(b["line"] for b in event["branches"].values())]
            assert all(line["text"] in BANK_TEXTS[service] for line in lines if line)
        # Ответ на вопрос бригады есть в карточке: этаж или подъезд — с 3-го уровня.
        note = re.search(r"(Этаж|Подъезд): (\d+)\.$", scenario["card"]["description"])
        assert bool(note) == (level >= 3)
        if note:
            [clarify] = [e for e in plan["events"] if e["kind"] == "clarify"]
            answer = next(o for o in clarify["reply_options"] if o["key"] == "answer")
            assert answer["label"].endswith(note.group(1).casefold())


def test_unsupported_service_is_explicit_error():
    with pytest.raises(GenerationRejected, match="нет поддерживаемого"):
        generation_input(service_id="999", level=1, seed=1)


class ScriptedLLM:
    """Отвечает как модель: согласованный выбор фраз банка; invalid — меняет факт карточки."""

    name = "local:test-fixture"
    is_generative = True

    def __init__(self, invalid=False):
        self.invalid = invalid
        self.calls = 0

    async def complete_json(self, prompt):
        self.calls += 1
        facts = json.loads(prompt)
        if facts.get("kind") == "gameplay":
            return self.gameplay(facts)
        bank = {
            item["text"]: set(item.get("facts", ()))
            for item in json.loads(
                (ROOT / f"scripts/voices/bank/phrases/{facts['service']}.json").read_text()
            )["phrases"]
        }
        # Как модель по промпту: фразы одной истории, без «газ есть» и «газа нет».
        texts = next(
            combination
            for combination in product(*(r["options"] for r in facts["reports"]))
            if not conflicts(set().union(*(bank.get(text, set()) for text in combination)))
        )
        choices = {
            report["state"]: text for report, text in zip(facts["reports"], texts, strict=True)
        }
        response = {
            "status": "ready",
            "facts": {key: facts[key] for key in ("service", "address", "victims", "outcome")},
            "caller_name": facts["caller_name"],
            "description": f"{facts['address']}: {facts['situation']}",
            "tags": ["Учебное задание"],
            "choices": choices,
            "expected_comment": (
                f"{facts['situation']} {choices[facts['reports'][-1]['state']]} "
                + (
                    "Работы не проводились."
                    if facts["outcome"] == "refused"
                    else "Работы завершены."
                )
            ),
        }
        if self.invalid:
            response["facts"]["victims"] = not response["facts"]["victims"]
        return response

    def gameplay(self, facts):
        # Как модель по каркасу: согласованный набор фраз, по возможности не шаблона;
        # invalid — фраза не из вариантов (схема её не пропустит).
        bank = {
            item["text"]: set(item.get("facts", ()))
            for item in json.loads(
                (ROOT / f"scripts/voices/bank/phrases/{facts['service']}.json").read_text()
            )["phrases"]
        }
        texts = next(
            combination
            for combination in product(*(r["options"][::-1] for r in facts["reports"]))
            if not conflicts(set().union(*(bank.get(text, set()) for text in combination)))
        )
        choices = dict(zip((r["state"] for r in facts["reports"]), texts, strict=True))
        if self.invalid:
            choices[facts["reports"][0]["state"]] = "Свой текст доклада, не из банка."
        return {"choices": choices}


@pytest.mark.parametrize("invalid", [False, True])
@pytest.mark.usefixtures("clean_generated_content")
def test_new_scenario_is_complete_and_fallback_is_honest(database_url, invalid):
    async def check():
        database = Database(database_url)
        llm = ScriptedLLM(invalid)
        try:
            async with database.sessions.begin() as db:
                teacher = await db.scalar(select(User).where(User.role == "teacher"))
                existing_drafts = set(
                    await db.scalars(select(Scenario.id).where(Scenario.status == "draft"))
                )
                scenario_id = uuid4()
                row = await generate_bank_one(
                    db,
                    llm,
                    scenario_id=scenario_id,
                    author_id=teacher.id,
                    service_id="101",
                    level=2,
                    seed=0,
                    auto_admit=True,
                )
                assert row.status == "approved" and row.origin == ("template" if invalid else "llm")
                assert row.reference["expected_flow"] == [
                    "received",
                    "accepted",
                    "responding",
                    "arrived",
                    "refused",
                ]
                plan = await db.get(ScenarioTrainingPlan, (row.id, row.version))
                assert plan.plan["messages"][-1]["justifies_state"] == "refused"
                assert row.generation_metadata["fallback_used"] is invalid
                assert len(row.generation_metadata["attempts"]) == (2 if invalid else 1)
                same = await generate_bank_one(
                    db,
                    llm,
                    scenario_id=scenario_id,
                    author_id=teacher.id,
                    service_id="101",
                    level=2,
                    seed=0,
                    auto_admit=True,
                )
                assert same.id == row.id and llm.calls == (2 if invalid else 1)
                assert (
                    set(await db.scalars(select(Scenario.id).where(Scenario.status == "draft")))
                    == existing_drafts
                )
        finally:
            await database.close()

    asyncio.run(check())


@pytest.mark.usefixtures("clean_generated_content")
def test_live_generation_is_not_reclaimed_even_after_last_lease(database_config):
    async def check():
        worker = Worker(database_config, worker_id="live-generator")
        other = Worker(
            database_config.model_copy(
                update={"worker_max_attempts": 1, "worker_lease_seconds": 5}
            ),
            worker_id="second-generator",
        )
        entered, release = asyncio.Event(), asyncio.Event()

        async def long_handler(db, kind, payload):
            entered.set()
            await release.wait()
            return {"checked": True}

        worker.handlers.run = long_handler
        try:
            async with worker.database.sessions.begin() as db:
                await db.execute(
                    update(Job)
                    .where(Job.status.in_(["running", "pending"]))
                    .values(status="failed", locked_by=None, locked_at=None)
                )
                row = await enqueue_job(db, kind="generate", payload={}, entity_id=uuid4())
                job_id = row.id
            claimed = await worker.queue.claim()
            async with worker.database.sessions.begin() as db:
                await db.execute(
                    update(Job)
                    .where(Job.id == job_id)
                    .values(locked_at=datetime.now(UTC) - timedelta(minutes=5))
                )
            process = asyncio.create_task(worker.process(claimed))
            await entered.wait()
            assert await asyncio.wait_for(other.queue.claim(), timeout=2) is None
            release.set()
            assert await process
            async with worker.database.sessions() as db:
                row = await db.get(Job, job_id)
                assert row.status == "done" and row.attempts == 1
        finally:
            release.set()
            await worker.close()
            await other.close()

    asyncio.run(check())
