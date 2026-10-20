"""Подпись пути, конечный перебор и расход новых вариантов при генерации."""

import asyncio
from collections import Counter
from copy import deepcopy
from types import SimpleNamespace
from uuid import uuid4

import pytest
from app.core.config import settings
from app.core.db import Database
from app.core.models import User
from app.worker.generators import gameplay, variant_paths
from app.worker.generators.storage import generate_gameplay_one
from sqlalchemy import select

from .test_scenario_generation import ScriptedLLM


def test_signature_ignores_cosmetics_but_keeps_actions_and_stage():
    template = next(t for t in gameplay.templates() if t["code"] == "pipe-flat-gkh-2")
    signature = variant_paths.signature(template, template["code"])
    changed = deepcopy(template)
    changed["card"]["caller_name"] = "Другой заявитель"
    changed["card"]["phone_aon"] = "+79000009999"
    for report in changed["plan"]:
        report["line"]["text"] = "Другая реплика"
        report["after_s"] += 1
    for event in changed["events"]:
        event["trigger"]["after_s"] += 1
        event["expect"][0]["within_s"] += 2
    assert variant_paths.signature(changed, template["code"]) == signature
    for mutate in (
        lambda d: d["events"].pop(),
        lambda d: d["events"][1]["trigger"].update(report="arrival"),
        lambda d: d["events"][1]["expect"][0].update(action="call_service", phone_exts=["103"]),
        lambda d: d["reference"]["expected_flow"].__setitem__(-1, "refused"),
    ):
        changed = deepcopy(template)
        mutate(changed)
        assert variant_paths.signature(changed, template["code"]) != signature
    assert variant_paths.signature(template, "other-template") != signature


def test_enumeration_is_checked_and_new_paths_precede_repeats():
    options = variant_paths.options("GKH", 3)
    counts = Counter()
    templates = Counter()
    for seed in range(len(options) * 2):
        source, data = variant_paths.pick("GKH", 3, seed, counts, templates)
        gameplay.check_file(data)
        sig = variant_paths.signature(data, source["code"])
        assert counts[sig] == min(counts[s] for s in options)
        counts[sig] += 1
        templates[source["code"]] += 1
    assert set(counts.values()) == {2}


def test_old_metadata_and_duplicate_rows_count_once():
    source, data = next(iter(variant_paths.options("GKH", 3).values()))
    from app.worker.generators.variation import describe

    metadata = describe(data, source)
    metadata["changes"] = ["моменты событий"]
    for event in metadata["events"]:
        if "after_s" in event["trigger"]:
            event["trigger"]["after_s"] += 2
    row = SimpleNamespace(
        id=uuid4(),
        target_service_id="GKH",
        level=3,
        generation_metadata={"constructor": {"template": source["code"], "variation": metadata}},
    )
    assert sum(variant_paths.usage([row, row], "GKH", 3).values()) == 1


@pytest.mark.usefixtures("clean_generated_content")
def test_generated_pack_consumes_each_new_path_once(database_url, monkeypatch):
    monkeypatch.setattr(settings, "generation_coherence", False)

    async def run():
        database = Database(database_url)
        try:
            async with database.sessions.begin() as db:
                teacher = await db.scalar(select(User).where(User.login == "teacher"))
                options = variant_paths.options("GKH", 3)
                signatures = []
                for seed in range(len(options)):
                    row = await generate_gameplay_one(
                        db,
                        ScriptedLLM(),
                        scenario_id=uuid4(),
                        author_id=teacher.id,
                        service_id="GKH",
                        level=3,
                        seed=seed,
                        auto_admit=False,
                    )
                    signatures.append(row.generation_metadata["constructor"]["variant_signature"])
                assert set(signatures) == set(options)
                assert len(signatures) == len(set(signatures))
                from app.api.packs.router import generation_variety

                request = SimpleNamespace(state=SimpleNamespace(db=db, user=teacher))
                state = await generation_variety(request, "GKH", 3)
                assert state.variants_total == len(options) and state.variants_left == 0
                await db.rollback()
        finally:
            await database.close()

    asyncio.run(run())


@pytest.mark.usefixtures("clean_generated_content")
@pytest.mark.parametrize("fallback_valid", [True, False])
@pytest.mark.parametrize("baseline_available", [True, False])
def test_coherence_fallback_does_not_repeat_used_baseline(
    database_url, monkeypatch, fallback_valid, baseline_available
):
    from app.worker.generators import storage, variation

    available = variant_paths.options("GKH", 3)
    source = next(t for t, _ in available.values() if t["code"] == "pipe-flat-gkh-2")
    baseline = variant_paths.signature(
        variation.select(source, 3, 0, enabled=False), source["code"]
    )
    choices = {s: pair for s, pair in available.items() if pair[0]["code"] == source["code"]}
    assert baseline in choices and len(choices) > 1
    if not baseline_available:
        choices.pop(baseline)
    monkeypatch.setattr(variant_paths, "options", lambda *_: choices)
    monkeypatch.setattr(
        variant_paths, "usage", lambda *_: Counter({baseline: int(baseline_available)})
    )
    monkeypatch.setattr(settings, "generation_coherence", True)
    verdicts = iter([False, False, fallback_valid])

    async def check(*_):
        return [] if next(verdicts) else [{"rule": "test", "policy": "test", "detail": "test"}]

    monkeypatch.setattr(storage, "coherence", check)

    async def run():
        database = Database(database_url)
        try:
            async with database.sessions.begin() as db:
                teacher = await db.scalar(select(User).where(User.login == "teacher"))

                async def generate():
                    return await generate_gameplay_one(
                        db,
                        ScriptedLLM(),
                        scenario_id=uuid4(),
                        author_id=teacher.id,
                        service_id="GKH",
                        level=3,
                        seed=0,
                        auto_admit=False,
                    )

                if fallback_valid:
                    row = await generate()
                    assert row.generation_metadata["constructor"]["variant_signature"] != baseline
                else:
                    # Вариация противоречива и с родными фразами — путь каркаса, пакет не рвётся.
                    row = await generate()
                    assert row.origin == "template"
                    assert row.generation_metadata["coherence"]["status"] == "catalog"
                    assert row.generation_metadata["constructor"]["variant_signature"] == baseline
                await db.rollback()
        finally:
            await database.close()

    asyncio.run(run())


def test_batch_repeated_template_maximizes_difference_even_over_pair_preference(monkeypatch):
    from app.worker.generators import variation

    available = {
        sig: value
        for sig, value in variant_paths.options("GKH", 2).items()
        if value[0]["code"] == "pipe-flat-gkh-2"
    }
    monkeypatch.setattr(variant_paths, "options", lambda *args: available)
    source, first = next(iter(available.values()))
    prior = [variation.describe(first, source)]
    for seed in range(3):
        _, selected = variant_paths.pick(
            "GKH",
            2,
            seed,
            Counter(),
            Counter(),
            covered_pairs=set(),
            batch_variations={source["code"]: prior},
        )
        got = variation.describe(selected, source)
        score = min(variant_paths.distance(got, old) for old in prior)
        assert score == max(
            min(variant_paths.distance(variation.describe(data, source), old) for old in prior)
            for _, data in available.values()
        )
        prior.append(got)
    assert prior[0] != prior[1]


def test_variant_label_describes_events_timing_and_outcome():
    assert variant_paths.label(None) == ""
    assert (
        variant_paths.label({"events": [], "terminal_state": "refused"})
        == "без дополнительных событий · отказ"
    )
    text = variant_paths.label(
        {
            "events": [
                {
                    "key": "q",
                    "kind": "clarify",
                    "trigger": {"on": "report", "report": "arrival", "after_s": 5},
                }
            ],
            "terminal_state": "completed",
        }
    )
    assert text == "вопрос бригады (по прибытии +5 с) · завершено"
