"""Неверная вводная меняет прибытие, но не факты сценария и обоснования статусов."""

import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

from app.api.training import briefing
from app.api.training.gating import ScheduledReport

PREFIX = "Диспетчер, вводная не совпала с обстановкой на месте. Уточнили, работаем по факту."


def test_real_recordings_preserve_both_wrong_address_and_wrong_incident():
    brigade_id, message_id = uuid4(), uuid4()
    now = datetime.now(UTC)
    report = ScheduledReport(
        planned={
            "message": {
                "id": str(message_id),
                "version": 1,
                "text": "Исходный доклад.",
                "audio": None,
            },
            "justifies_state": "arrived",
        },
        identity=(message_id, 1),
        brigade_id=brigade_id,
        target_id=uuid4(),
        issued=False,
        waiting_started_at=now,
        ready_at=now + timedelta(seconds=6),
    )
    sent = {
        brigade_id: SimpleNamespace(incident=False, address="wrong", heard_address="Другой адрес")
    }
    scenario = SimpleNamespace(target_service_id="101")
    (changed,) = briefing.apply_wrong_incident(
        briefing.apply_wrong_address([report], sent, scenario), sent, scenario
    )
    assert changed.planned["message"]["text"] == PREFIX + " " + briefing.MOVED_TEXT
    assert changed.planned["message"]["audio"] is not None
    assert changed.ready_at == now + timedelta(seconds=40)
    assert changed.identity == report.identity
    assert changed.planned["justifies_state"] == "arrived"


def test_catalog_arrival_and_event_replacements_have_composite_recordings(record_property):
    from app.seed.scenarios import load_catalog

    catalog = load_catalog({"101", "102", "103", "104", "GKH", "MOSLIFT"})
    assert not catalog.rejected
    composites = briefing.wrong_incident_items()
    checked, missing = [], []
    for scenario in catalog.scenarios:
        arrivals = {p["key"] for p in scenario["plan"] if p["justifies_state"] == "arrived"}
        lines = [p["line"] for p in scenario["plan"] if p["key"] in arrivals]

        def replacements(value, arrivals=arrivals, lines=lines):
            if isinstance(value, dict):
                if value.get("replace") in arrivals:
                    lines.append(value["with"])
                for nested in value.values():
                    replacements(nested)
            elif isinstance(value, list):
                for nested in value:
                    replacements(nested)

        replacements(scenario.get("events", []))
        for line in lines:
            text = line["text"] if isinstance(line, dict) else line
            key = (scenario["service_id"], text)
            checked.append(key)
            if key not in composites:
                missing.append((scenario["code"], *key))
    assert checked
    assert not missing, missing
    record_property("catalog_scenarios", len(catalog.scenarios))
    record_property("arrival_and_replacement_occurrences", len(checked))
    record_property("unique_arrival_and_replacement_texts", len(set(checked)))


def test_prefix_discovery_uses_exact_authorized_ids(tmp_path, monkeypatch):
    discover = getattr(briefing, "wrong_incident_prefix_items", None)
    assert callable(discover), "The six authorized prefix IDs must be discoverable and seedable"
    prefix = {"id": "101.update.wrong_briefing.1", "service_id": "101", "text": PREFIX}
    other = {**prefix, "id": "101.update.normal.1"}
    manifest = tmp_path / "bank-v10" / "manifest.json"
    manifest.parent.mkdir()
    manifest.write_text(json.dumps({"messages": [prefix, other]}))
    monkeypatch.setattr(briefing.settings, "information_audio_dir", tmp_path)
    discover.cache_clear()
    try:
        assert discover() == {"101": prefix}
    finally:
        discover.cache_clear()


def test_wrong_incident_only_needs_missing_address():
    from evalcore.briefing import Briefing

    result = Briefing(address="missing", heard_address=None, incident=False, incident_said=True)
    assert briefing.ask_again(result, "101") == briefing.ASK_AGAIN["101"]["address"]


def test_wrong_incident_preserves_arrival_facts_and_recording(tmp_path, monkeypatch):
    apply = getattr(briefing, "apply_wrong_incident", None)
    assert callable(apply), "Wrong incident must affect the actual arrival report"
    brigade_id, message_id = uuid4(), uuid4()
    now = datetime.now(UTC)
    original = {"text": "На месте. Газ перекрыт, жильцов вывели.", "audio": {"sha256": "a" * 64}}
    combined = {
        "id": "101.update.wrong_briefing.combined.1",
        "service_id": "101",
        "slot": "update",
        "text": PREFIX + " " + original["text"],
        "source_text": original["text"],
        "path": "bank-v10/combined.ogg",
        "sha256": "b" * 64,
        "duration_ms": 12000,
    }
    manifest = tmp_path / "bank-v10" / "manifest.json"
    manifest.parent.mkdir()
    manifest.write_text(json.dumps({"messages": [combined]}))
    monkeypatch.setattr(briefing.settings, "information_audio_dir", tmp_path)
    briefing.wrong_incident_items.cache_clear()
    try:
        report = ScheduledReport(
            planned={
                "message": {"id": str(message_id), "version": 1, **original},
                "justifies_state": "arrived",
                "requires_state": "responding",
                "task_change": {"description": "Keep actual scenario facts"},
            },
            identity=(message_id, 1),
            brigade_id=brigade_id,
            target_id=uuid4(),
            issued=False,
            waiting_started_at=now,
            ready_at=now,
        )
        row = SimpleNamespace(incident=False, address="ok")
        scenario = SimpleNamespace(target_service_id="101")
        (changed,) = apply([report], {brigade_id: row}, scenario)
        assert changed.planned["message"]["text"] == combined["text"]
        assert changed.planned["message"]["audio"] == briefing.asset_ref(combined)
        assert changed.identity == report.identity
        assert changed.ready_at == report.ready_at
        assert changed.planned["justifies_state"] == "arrived"
        assert changed.planned["task_change"] == report.planned["task_change"]
        assert report.planned["message"] == {"id": str(message_id), "version": 1, **original}
        for untouched in [
            replace(report, issued=True),
            replace(report, planned={**report.planned, "justifies_state": "working"}),
        ]:
            assert apply([untouched], {brigade_id: row}, scenario) == [untouched]
        assert apply([report], {brigade_id: SimpleNamespace(incident=True)}, scenario) == [report]
        assert apply([report], {}, scenario) == [report]
        assert apply([report], {brigade_id: row}, None) == [report]
    finally:
        briefing.wrong_incident_items.cache_clear()


def test_missing_composite_uses_recorded_prefix_without_losing_original(tmp_path, monkeypatch):
    apply = briefing.apply_wrong_incident
    prefix = {
        "id": "101.update.wrong_briefing.1",
        "service_id": "101",
        "slot": "update",
        "text": PREFIX,
        "path": "bank-v10/prefix.ogg",
        "sha256": "b" * 64,
        "duration_ms": 6500,
    }
    manifest = tmp_path / "bank-v10" / "manifest.json"
    manifest.parent.mkdir()
    manifest.write_text(json.dumps({"messages": [prefix]}))
    monkeypatch.setattr(briefing.settings, "information_audio_dir", tmp_path)
    briefing.wrong_incident_items.cache_clear()
    briefing.wrong_incident_prefix_items.cache_clear()
    brigade_id, message_id = uuid4(), uuid4()
    report = ScheduledReport(
        planned={
            "message": {
                "id": str(message_id),
                "version": 1,
                "text": "На месте.",
                "audio": {"sha256": "a" * 64},
            },
            "justifies_state": "arrived",
            "requires_state": "responding",
        },
        identity=(message_id, 1),
        brigade_id=brigade_id,
        target_id=uuid4(),
        issued=False,
        waiting_started_at=None,
        ready_at=None,
    )
    sent = {brigade_id: SimpleNamespace(incident=False)}
    scenario = SimpleNamespace(target_service_id="101")
    try:
        notice, unchanged = apply([report], sent, scenario)
        assert unchanged is report
        assert notice.planned["message"]["text"] == PREFIX
        assert notice.planned["message"]["audio"] == briefing.asset_ref(prefix)
        assert "justifies_state" not in notice.planned and "requires_state" not in notice.planned
        assert notice.brigade_id == report.brigade_id and notice.target_id == report.target_id
        assert notice.ready_at == report.ready_at
        repeated = apply([report], sent, scenario, {notice.identity})
        assert repeated[0].identity == notice.identity
        assert repeated[0].issued is True
        assert repeated[1] is report
    finally:
        briefing.wrong_incident_items.cache_clear()
        briefing.wrong_incident_prefix_items.cache_clear()
