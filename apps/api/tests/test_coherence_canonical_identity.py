"""Прогон узнаёт подмену по UUID загрузчика, включая общую реплику otherwise и wrong."""

import asyncio
import copy
import json
from typing import Any

import pytest
from app.core.config import ROOT
from app.seed.scenarios import training_plan
from app.seed.service_defaults import with_service_defaults
from app.tools.coherence.harness import SimClock
from app.tools.coherence.invariants import check, failing
from app.tools.coherence.policies import REFERENCE
from app.tools.coherence.runner import HORIZON_S, ScenarioRun, sources_of


async def no_audio(path: str, text: str) -> None:
    return None


def test_deduplicated_fallback_report_schedules_its_status(monkeypatch):
    async def scenario() -> None:
        data = json.loads((ROOT / "data/scenarios/animal-shaft-gkh-1.json").read_text())
        canonical = await training_plan(data, no_audio)
        event = next(event for event in canonical["events"] if event["kind"] == "clarify")
        fallback = next(
            effect
            for effect in event["branches"]["met"]["awaits_call"]["otherwise"]
            if "replace" in effect
        )
        wrong = next(
            effect for effect in event["branches"]["wrong"]["effects"] if "replace" in effect
        )
        assert wrong["with"] == fallback["with"]
        delivery: dict[str, Any] = {"delivery_id": "replacement", "message": wrong["with"]}
        runner = ScenarioRun(None, SimClock(), data, REFERENCE, "trainee")
        runner.state = "arrived"

        async def hear() -> None:
            await runner._heard(delivery)

        async def done() -> None:
            pass

        # Подменены только API-жизненный цикл и внешний цикл тиков, не разбор сообщения.
        monkeypatch.setattr(runner, "_start", hear)
        monkeypatch.setattr(runner, "_loop", done)
        monkeypatch.setattr(runner, "_finish", done)
        await runner.run()
        assert runner.stage == "working"
        assert any(item.what == "статус «working»" for item in runner.plan)
        source, key = runner._origin(delivery)
        assert source == "replace"
        report = runner._report_for(delivery, source, key)
        assert report is not None and report["key"] == "works"

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "path", sorted((ROOT / "data/scenarios").glob("*.json")), ids=lambda p: p.stem
)
def test_catalog_sources_match_the_parser_without_merging_branches(path):
    async def scenario() -> None:
        data = with_service_defaults(json.loads(path.read_text()))
        original = copy.deepcopy(data)
        canonical = await training_plan(data, no_audio)
        runner = ScenarioRun(None, SimClock(), data, REFERENCE, "trainee")
        runner.src = await sources_of(data)
        reports = {
            parsed["message"]["id"]: raw
            for raw, parsed in zip(data["plan"], canonical["messages"], strict=True)
        }
        for mid, report in reports.items():
            assert runner.src.by_id[mid] == ("plan", report["key"])
            assert runner.src.report_by_id[mid] == report
        for raw, event in zip(data.get("events", []), canonical.get("events", []), strict=True):
            first_origin: dict[str, str] = {}
            for name, branch in event["branches"].items():
                if branch["line"] is not None:
                    delivery = {"message": branch["line"]}
                    origin = runner._origin(delivery)
                    assert origin == ("branch", f"{raw['key']}:{name}")
                    assert runner._report_for(delivery, *origin) is None
                for suffix, effects in (
                    (name, branch["effects"]),
                    (f"{name}-no-call", branch.get("awaits_call", {}).get("otherwise", [])),
                ):
                    for effect in effects:
                        if "replace" not in effect:
                            continue
                        delivery = {"message": effect["with"]}
                        mid = effect["with"]["id"]
                        owner = first_origin.setdefault(mid, f"{raw['key']}:{suffix}")
                        origin = runner._origin(delivery)
                        assert origin == ("replace", owner)
                        assert runner._report_for(delivery, *origin) == reports[effect["replace"]]
            if event["line"] is not None:
                delivery = {"message": event["line"]}
                origin = runner._origin(delivery)
                if event["line"]["id"] in runner.src.carried:
                    assert origin == ("plan", runner.src.carried[event["line"]["id"]])
                    assert runner._report_for(delivery, *origin) is not None
                    runner.carrying = False
                    assert runner._origin(delivery) == ("event", raw["key"])
                    runner.carrying = True
                else:
                    assert origin == ("event", raw["key"])
                    assert runner._report_for(delivery, *origin) is None
        assert data == original

    asyncio.run(scenario())


@pytest.mark.parametrize("fallback_first", [True, False])
@pytest.mark.parametrize("shared_text", [True, False])
@pytest.mark.parametrize("object_line", [True, False])
@pytest.mark.parametrize("explicit_id", [True, False])
def test_fallback_identity_follows_parser_order_not_known_ids(
    fallback_first, shared_text, object_line, explicit_id
):
    async def scenario() -> None:
        data = json.loads((ROOT / "data/scenarios/animal-shaft-gkh-1.json").read_text())
        data.pop("id", None)
        data["code"] = "canonical-identity-fixture"
        data["version"] = 31
        if explicit_id:
            data["id"] = "7c724976-2454-45f6-88d3-49abc2b0549e"
            data["version"] = 1
        event = next(event for event in data["events"] if event["kind"] == "clarify")
        event["key"] = "access-check"
        fallback = next(
            effect
            for effect in event["branches"]["met"]["awaits_call"]["otherwise"]
            if "replace" in effect
        )
        text = "Ведём работы другим способом."
        fallback["with"] = {"text": text, "audio": "test/not-loaded.wav"} if object_line else text
        if shared_text:
            wrong = next(
                effect for effect in event["branches"]["wrong"]["effects"] if "replace" in effect
            )
            # Дедупликация — по тексту, а не форме line или пути аудио.
            wrong["with"] = text if object_line else {"text": text}
        if not fallback_first:
            event["branches"] = {
                "wrong": event["branches"]["wrong"],
                **{k: v for k, v in event["branches"].items() if k != "wrong"},
            }
        canonical = await training_plan(data, no_audio)
        parsed = next(event for event in canonical["events"] if event["kind"] == "clarify")
        effect = next(
            effect
            for effect in parsed["branches"]["met"]["awaits_call"]["otherwise"]
            if "replace" in effect
        )
        runner = ScenarioRun(None, SimClock(), data, REFERENCE, "trainee")
        runner.src = await sources_of(data)
        delivery = {"message": effect["with"]}
        owner = "wrong" if shared_text and not fallback_first else "met-no-call"
        origin = runner._origin(delivery)
        assert origin == ("replace", f"access-check:{owner}")
        report = runner._report_for(delivery, *origin)
        assert report is not None and report["key"] == fallback["replace"]
        assert report["justifies_state"] == "working"
        await runner._heard(delivery)
        assert runner.stage == "working"
        assert any(item.what == "статус «working»" for item in runner.plan)

    asyncio.run(scenario())


def test_unknown_message_does_not_justify_status_or_hide_not_closed():
    async def scenario() -> None:
        data = json.loads((ROOT / "data/scenarios/animal-shaft-gkh-1.json").read_text())
        runner = ScenarioRun(None, SimClock(), data, REFERENCE, "trainee")
        runner.src = await sources_of(data)
        delivery = {"message": {"id": "unknown-message", "text": "Работа завершена."}}
        assert runner._origin(delivery) == ("plan", None)
        await runner._heard(delivery)
        assert runner.stage is None
        assert runner.plan == []
        assert not runner.tr.closed
        runner.clock.advance(HORIZON_S)
        await runner._loop()
        assert any(item.rule == "not_closed" and failing(item.rule) for item in check(runner.tr))

    asyncio.run(scenario())
