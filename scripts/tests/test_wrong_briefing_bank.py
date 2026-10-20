"""Реплика о неверной вводной не должна становиться случайной обстановкой."""

import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def bank_module():
    path = ROOT / "scripts/voices/bank/bank.py"
    spec = importlib.util.spec_from_file_location("wrong_briefing_bank", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def checked(monkeypatch, requires):
    bank = bank_module()
    phrase = {
        "id": "101.update.wrong_briefing.1",
        "slot": "update",
        "incidents": ["*"],
        "text": "Вводная не совпала с обстановкой на месте.",
    }
    if requires is not None:
        phrase["requires"] = requires
    book = {"service": "101", "speaker": "brigade", "gender": "male", "phrases": [phrase]}
    monkeypatch.setattr(bank, "books", lambda: [book])
    monkeypatch.setattr(bank, "code_problems", lambda _: ([], []))
    monkeypatch.setattr(bank.web, "caller_plot_problems", lambda: [])
    return bank.check()


@pytest.mark.parametrize("requires", [None, [], "wrong_briefing", ["unknown_condition"]])
def test_wrong_briefing_phrase_requires_explicit_known_condition(monkeypatch, requires):
    assert checked(monkeypatch, requires)


def test_wrong_briefing_phrase_accepts_its_explicit_condition(monkeypatch):
    assert checked(monkeypatch, ["wrong_briefing"]) == []


def test_six_recordings_match_guarded_phrase_books():
    manifest = json.loads((ROOT / "data/voices/bank-v10/manifest.json").read_text())
    items = manifest["messages"]
    assert {item["service_id"] for item in items} == {"101", "102", "103", "104", "GKH", "MOSLIFT"}
    assert len(items) == 6
    for item in items:
        book = json.loads(
            (ROOT / f"scripts/voices/bank/phrases/{item['service_id']}.json").read_text()
        )
        phrase = next(phrase for phrase in book["phrases"] if phrase["id"] == item["id"])
        assert phrase["requires"] == ["wrong_briefing"]
        assert phrase["text"] == item["text"]
        path = ROOT / "data/voices" / item["path"]
        assert path.read_bytes().startswith(b"OggS")
        assert hashlib.sha256(path.read_bytes()).hexdigest() == item["sha256"]
        assert item["duration_ms"] > 1000


def test_combined_recordings_preserve_all_recorded_arrival_sources():
    manifests = [
        json.loads(path.read_text())
        for path in sorted((ROOT / "data/voices").glob("bank-v*/manifest.json"))
    ]
    # Имя набора не определяет порядок словарного обхода (v10 идёт перед v2).
    prefixes = {
        item["service_id"]: item
        for manifest in manifests
        for item in manifest["messages"]
        if item["id"].endswith(".update.wrong_briefing.1")
    }
    sources = {
        (item["service_id"], item["text"]): item
        for manifest in manifests
        for item in manifest["messages"]
        if item.get("slot") == "arrived"
        or item["id"].endswith((".wrong_place.moved", ".wrong_place.moved2"))
    }
    combined = {
        (item["service_id"], item["source_text"]): item
        for manifest in manifests
        for item in manifest["messages"]
        if "source_text" in item
    }
    assert sources
    assert set(combined) == set(sources)
    for key, source in sources.items():
        item = combined[key]
        prefix = prefixes[item["service_id"]]
        assert item["text"] == f"{prefix['text']} {source['text']}"
        assert item["source_sha256"] == source["sha256"]
        assert item["prefix_sha256"] == prefix["sha256"]
        path = ROOT / "data/voices" / item["path"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == item["sha256"]
        assert item["duration_ms"] > prefix["duration_ms"]
