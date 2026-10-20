"""Первая полная вводная — отдельный вклад в работу с каждой бригадой."""

from dataclasses import replace

import pytest
from evalcore.brigade import BrigadeWorkCriterion
from evalcore.criteria import wrong_briefings
from evalcore.scoring import evaluate

from .test_brigade_work import CREW, clarify, context, fired, golden, iso, reply


def briefing(correct: bool, *, brigade: str = CREW, complete: bool = True, seconds: int = 0):
    return {
        "brigade_id": brigade,
        "at": iso(seconds),
        "mode": "parts",
        "text": "улица Плеханова, 11. Драка на улице",
        "address": "ok",
        "heard_address": "улица Плеханова, 11",
        "incident": correct,
        "complete": complete,
    }


def test_wrong_incident_scores_without_scenario_events() -> None:
    ctx = replace(context([]), briefings=(briefing(False),))
    result = BrigadeWorkCriterion().evaluate(ctx)
    assert result.score == 0
    assert result.weight == 1
    assert not result.critical
    assert result.evidence
    assert len(result.remarks) == 1
    remark = result.remarks[0]
    assert remark.kind == "error"
    assert remark.quote == ctx.briefings[0]["text"]
    assert "происшеств" in remark.text
    assert "прибыт" in remark.consequence
    assert remark.repeat.startswith("Повторите:")


@pytest.mark.parametrize("correct", (True, False))
@pytest.mark.parametrize("weight", (0.0, 0.25, 2.0))
@pytest.mark.parametrize("event_correct", (None, True, False))
def test_briefing_and_events_are_independent_mean_contributions(
    correct: bool, weight: float, event_correct: bool | None
) -> None:
    events = (
        []
        if event_correct is None
        else [fired(clarify(), replies=[reply(10, "floor_9" if event_correct else "unknown")])]
    )
    ctx = replace(context(events, weight=weight), briefings=(briefing(correct),))
    result = BrigadeWorkCriterion().evaluate(ctx)
    scores = [float(correct)] + ([] if event_correct is None else [float(event_correct)])
    assert result.score == sum(scores) / len(scores)
    assert result.weight == weight
    assert not result.critical
    assert wrong_briefings(ctx) == []


@pytest.mark.parametrize("first_correct", (False, True))
def test_only_first_complete_briefing_per_brigade_counts(first_correct: bool) -> None:
    items = (
        briefing(not first_correct, complete=False),
        briefing(first_correct, seconds=1),
        briefing(not first_correct, seconds=2),
        briefing(not first_correct, brigade="second", seconds=3),
    )
    result = BrigadeWorkCriterion().evaluate(replace(context([]), briefings=items))
    assert result.score == 0.5
    assert len(result.remarks) == 1
    assert len(result.evidence) == 2


def test_no_complete_briefings_preserves_legacy_non_applicability() -> None:
    for items in ((), (briefing(False, complete=False),)):
        result = BrigadeWorkCriterion().evaluate(replace(context([]), briefings=items))
        assert result.score == 1
        assert result.weight == 0
        assert not result.remarks


def test_absent_brigade_weight_keeps_old_evaluation_criteria() -> None:
    ctx = replace(golden([]), briefings=(briefing(False),))
    result = evaluate(ctx)
    assert all(item.key != "brigade_work" for item in result.criteria)
    assert not result.critical_flags


def test_explanation_distinguishes_briefings_from_events() -> None:
    result = BrigadeWorkCriterion().evaluate(
        replace(context([]), briefings=(briefing(False), briefing(True, brigade="second")))
    )
    assert "вводн" in result.explanation.lower()
    assert "названо другое происшествие" in result.explanation.lower()


@pytest.mark.parametrize("weight", (0.0, 0.25, 2.0))
def test_evaluation_applies_only_configured_brigade_weight(weight: float) -> None:
    ctx = golden([], brigade_work=weight)
    baseline = evaluate(ctx)
    failed = evaluate(replace(ctx, briefings=(briefing(False),)))
    before = {item.key: item for item in baseline.criteria}
    after = {item.key: item for item in failed.criteria}
    assert not failed.critical_flags
    assert after["address"] == before["address"]
    assert after["brigade_work"].score == 0
    assert after["brigade_work"].weight == weight
    weighted_sum = sum(item.score * item.weight for item in baseline.criteria)
    old_weight = sum(item.weight for item in baseline.criteria)
    assert failed.total == pytest.approx(weighted_sum / (old_weight + weight))
