"""Условные реплики банка не должны стать вариантами обычной генерации."""

import pytest
from app.worker.generators import phrases


@pytest.mark.parametrize("requires", [["wrong_briefing"], ["future_condition"]])
def test_conditional_phrase_is_not_an_ordinary_option(monkeypatch, requires):
    ordinary = {
        "id": "101.update.normal.1",
        "slot": "update",
        "incidents": ["*"],
        "text": "Работаем.",
        "facts": [],
    }
    conditional = {
        **ordinary,
        "id": "101.update.wrong_briefing.1",
        "text": "Вводная не совпала.",
        "requires": requires,
    }
    monkeypatch.setattr(phrases, "bank", lambda _service: {"phrases": [ordinary, conditional]})
    options = phrases.candidates(
        "101", "update", "gas_smell", {"victims": False}, seed=0, limit=100
    )
    assert options == [ordinary]


@pytest.mark.parametrize("service", ["101", "102", "103", "104", "GKH", "MOSLIFT"])
def test_actual_wrong_briefing_prefix_is_never_a_normal_option(service):
    prefix = phrases.phrase(service, f"{service}.update.wrong_briefing.1")
    assert prefix["requires"] == ["wrong_briefing"]
    options = phrases.candidates(
        service, "update", "gas_smell", {"victims": False}, seed=0, limit=10000
    )
    assert all(item["id"] != f"{service}.update.wrong_briefing.1" for item in options)
