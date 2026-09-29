"""L-03: пояснения оценщика — по-русски, без ключей критериев и репрезентаций Python."""

import json
import re
from pathlib import Path

import pytest
from evalcore.criteria import (
    AddressCriterion,
    CallCriterion,
    HandlingTimeCriterion,
    ReactionTimeCriterion,
    RequiredFieldsCriterion,
    RoutingCriterion,
    StatusFlowCriterion,
)
from evalcore.defaults import CRITERIA
from evalcore.models import CriterionResult, EvalContext
from evalcore.scoring import evaluate

GOLDEN_DIR = Path(__file__).parents[3] / "data" / "golden_scenarios"
# Допустимая латиница: обозначение автомата времени и формат отчёта.
LATIN_ALLOWED = {"CSV", "I-TIME"}
LATIN_TOKEN = re.compile(r"[A-Za-z][A-Za-z-]*")
PY_REPR = re.compile(r"\[(?:'[^']*'(?:,\s*)?)*\]")


def assert_russian(result: CriterionResult) -> None:
    texts = [result.explanation, *result.evidence]
    for text in texts:
        for token in LATIN_TOKEN.findall(text):
            # Код службы (MOSLIFT, GKH) — идентификатор, а не английское слово.
            if token.isupper():
                continue
            assert token in LATIN_ALLOWED, f"{result.key}: латиница {token!r} в {text!r}"
        assert not PY_REPR.search(text), f"{result.key}: список Python в {text!r}"


def load_golden_context(case: str) -> EvalContext:
    fixture = json.loads((GOLDEN_DIR / case).read_text(encoding="utf-8"))
    return EvalContext(
        scenario=fixture["scenario"],
        current=fixture["current"],
        events=fixture["events"],
        calls=fixture["calls"],
        settings=fixture["settings"],
    )


@pytest.mark.parametrize("fixture_path", sorted(GOLDEN_DIR.glob("case-*.json")))
def test_golden_scenarios_explanations_are_russian(fixture_path):
    ctx = load_golden_context(fixture_path.name)

    evaluation = evaluate(ctx)

    for item in evaluation.criteria:
        assert_russian(item)


def test_reaction_time_without_events_is_russian():
    ctx = load_golden_context("case-01.json")
    ctx.events[:] = []

    assert_russian(ReactionTimeCriterion().evaluate(ctx))


def test_reaction_time_non_monotonic_is_russian():
    ctx = load_golden_context("case-01.json")
    for event in ctx.events:
        if event.get("type") == "open":
            event["client_ts"] = "2026-09-19T08:00:00Z"

    assert_russian(ReactionTimeCriterion().evaluate(ctx))


def test_handling_time_without_terminal_is_russian():
    ctx = load_golden_context("case-01.json")
    ctx.events[:] = [event for event in ctx.events if event.get("type") != "status_change"]

    assert_russian(HandlingTimeCriterion().evaluate(ctx))


def test_status_flow_penalizes_missing_state_is_russian():
    ctx = load_golden_context("case-01.json")
    ctx.events[:] = [
        event
        for event in ctx.events
        if not (
            event.get("type") == "status_change"
            and isinstance(event.get("payload"), dict)
            and event["payload"].get("state") == "responding"
        )
    ]

    assert_russian(StatusFlowCriterion().evaluate(ctx))


def test_routing_wrong_decision_is_russian():
    ctx = load_golden_context("case-01.json")
    accepted = next(
        event
        for event in ctx.events
        if event.get("type") == "status_change" and event["payload"].get("state") == "accepted"
    )
    accepted["payload"]["state"] = "rejected"

    assert_russian(RoutingCriterion().evaluate(ctx))


def test_routing_redirect_is_russian():
    ctx = load_golden_context("case-01.json")
    ctx.scenario["reference"]["expected_flow"] = ["received", "rejected", "redirected"]
    ctx.scenario["reference"]["expected_service_ids"] = ["101"]
    ctx.events[:] = [
        {
            "type": "status_change",
            "client_ts": "2026-09-19T09:00:20Z",
            "payload": {"state": "rejected"},
        },
        {
            "type": "redirect",
            "client_ts": "2026-09-19T09:00:30Z",
            "payload": {"service_id": "102"},
        },
    ]

    assert_russian(RoutingCriterion().evaluate(ctx))


def test_required_fields_missing_is_russian():
    ctx = load_golden_context("case-01.json")
    ctx.current["comment"] = "   "

    assert_russian(RequiredFieldsCriterion().evaluate(ctx))


def test_address_legacy_mismatch_is_russian():
    ctx = load_golden_context("case-01.json")
    ctx.current["comment"] = "Москва, Тверская улица, дом 1. Направлен экипаж."

    assert_russian(AddressCriterion().evaluate(ctx))


def test_address_manual_mismatch_is_russian():
    ctx = load_golden_context("case-01.json")
    ctx.current["address"] = {
        "city": "Москва",
        "street": "Дубининская улица",
        "house": "1",
        "building": "",
        "apartment": "",
    }

    assert_russian(AddressCriterion().evaluate(ctx))


def test_call_missing_is_russian():
    ctx = load_golden_context("case-01.json")
    ctx.calls[:] = []

    assert_russian(CallCriterion().evaluate(ctx))


def test_call_unanswered_is_russian():
    ctx = load_golden_context("case-01.json")
    ctx.calls[0]["answered_at"] = None

    assert_russian(CallCriterion().evaluate(ctx))


def test_all_criteria_keys_are_covered():
    assert {
        "reaction_time",
        "handling_time",
        "status_flow",
        "routing",
        "required_fields",
        "address",
        "call",
    } == set(CRITERIA)
