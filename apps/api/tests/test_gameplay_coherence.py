"""Проход связности сгенерированного сценария (check_scenario, HQ-027): нарушения — модели во
вторую попытку, сбой стенда прохода генерацию не останавливает."""

import asyncio
import json
from uuid import uuid4

import pytest
from app.core.config import settings
from app.core.db import Database
from app.core.models import User
from app.worker.generators import gameplay, storage, variant_paths
from app.worker.generators.variation import describe
from sqlalchemy import select

from .test_scenario_generation import ScriptedLLM


def violation(data):
    # Как check_scenario: реплика, которая звучала в момент нарушения, — доклад о прибытии.
    text = data["plan"][1]["line"]["text"]
    return {
        "rule": "stage_regress",
        "policy": "эталон",
        "at": 40.0,
        "detail": "доклад о прибытии противоречит карточке",
        "line": f"Бригада 1: {text}",
        "failing": True,
    }


def generate(database_url, monkeypatch, verdicts, enabled=True):
    """verdicts[n] — ответ прохода на n-й вызов: 'bad' — нарушение, [] — связно, None — стенд
    прохода недоступен."""
    monkeypatch.setattr(settings, "generation_coherence", enabled)
    seen = []

    async def fake(db, data):
        seen.append(data)
        verdict = verdicts[len(seen) - 1]
        return [violation(data)] if verdict == "bad" else verdict

    monkeypatch.setattr(storage, "coherence", fake)
    llm = ScriptedLLM()
    prompts = []
    answer = llm.complete_json

    async def spy(prompt):
        prompts.append(json.loads(prompt))
        return await answer(prompt)

    llm.complete_json = spy

    async def run():
        database = Database(database_url)
        try:
            async with database.sessions.begin() as db:
                teacher = await db.scalar(select(User).where(User.role == "teacher"))
                row = await storage.generate_one(
                    db,
                    llm,
                    scenario_id=uuid4(),
                    author_id=teacher.id,
                    service_id="101",
                    level=2,
                    seed=0,
                    auto_admit=False,
                )
                result = row.origin, row.generation_metadata
                await db.rollback()
                return result
        finally:
            await database.close()

    origin, metadata = asyncio.run(run())
    return origin, metadata, prompts, seen


@pytest.mark.usefixtures("clean_generated_content")
def test_violation_goes_to_second_attempt_without_that_phrase(database_url, monkeypatch):
    origin, metadata, prompts, seen = generate(database_url, monkeypatch, ["bad", []])
    assert origin == "llm" and len(prompts) == 2 and len(seen) == 2
    first, second = metadata["attempts"]
    assert not first["accepted"] and first["error"].startswith("Проход связности: stage_regress")
    assert first["diagnostics"]["coherence"]["violations"][0]["rule"] == "stage_regress"
    assert second["accepted"] and second["diagnostics"]["coherence"] == {
        "checked": True,
        "violations": [],
    }
    # Модель видит причину; фраза не шаблона убрана из вариантов своего доклада.
    rejected = prompts[1]["rejected"]
    assert rejected and rejected[0]["why"].startswith("stage_regress:")
    if rejected[0]["state"] is not None:
        options = next(r for r in prompts[1]["reports"] if r["state"] == rejected[0]["state"])
        assert rejected[0]["text"] not in options["options"]
    assert "rejected" not in prompts[0]
    template = next(
        t for t in gameplay.templates() if t["code"] == metadata["constructor"]["template"]
    )
    assert metadata["constructor"]["variation"] == describe(seen[-1], template)
    assert metadata["phrases"]["reports"] == {
        r["justifies_state"]: gameplay.phrase_of(r["line"])["id"] for r in seen[-1]["plan"]
    }


@pytest.mark.usefixtures("clean_generated_content")
def test_stand_failure_does_not_block_generation(database_url, monkeypatch):
    origin, metadata, prompts, _ = generate(database_url, monkeypatch, [None])
    assert origin == "llm" and len(prompts) == 1
    assert metadata["attempts"][0]["diagnostics"]["coherence"] == {"checked": False}


@pytest.mark.usefixtures("clean_generated_content")
def test_two_failed_passes_fall_back_to_checked_available_path(database_url, monkeypatch):
    origin, metadata, prompts, seen = generate(database_url, monkeypatch, ["bad", "bad", []])
    assert origin == "template" and metadata["fallback_used"] and len(prompts) == 2
    assert not any(attempt["accepted"] for attempt in metadata["attempts"])
    template = next(
        t for t in gameplay.templates() if t["code"] == metadata["constructor"]["template"]
    )
    assert len(seen) == 3
    assert metadata["constructor"]["variant_signature"] in variant_paths.options("101", 2)
    assert metadata["constructor"]["variation"] == describe(seen[-1], template)
    _, prepared = variant_paths.options("101", 2)[metadata["constructor"]["variant_signature"]]
    own = {r["justifies_state"]: r["line"]["text"] for r in prepared["plan"]}
    assert all(r["line"]["text"] == own[r["justifies_state"]] for r in seen[-1]["plan"])


@pytest.mark.usefixtures("clean_generated_content")
def test_pass_is_off_by_setting(database_url, monkeypatch):
    origin, metadata, _, seen = generate(database_url, monkeypatch, [], enabled=False)
    assert origin == "llm" and seen == []
    assert "coherence" not in metadata["attempts"][0]["diagnostics"]
