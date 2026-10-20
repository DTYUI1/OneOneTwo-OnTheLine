"""CF-01: обязательные передачи после звонка должны влиять на brigade_work."""

from dataclasses import replace
from uuid import UUID

import pytest
from app.api.training.scenario_events import Firing, apply_world, due_events, world
from evalcore.brigade import BrigadeWorkCriterion, fired_events
from evalcore.defaults import BRIGADE_CRITERIA, CRITERIA
from evalcore.models import EvalContext

from .test_caller_fact_relay import CODES, pending_world
from .test_live_brigade import at, call


def replay(code, choices=(None, None), *, facts=True):
    """Настоящие parser, runtime и evaluator; подставлен только журнал действий."""
    plan, state, work = pending_world(
        code, [call(20, ext="74951234567", brigade=None, answered=21, ended=35)]
    )
    required = plan["events"][0]["branches"]["met"]["awaits_call"]["required_facts"]
    state = replace(
        state,
        caller_facts=[{"key": key, "at": at(30), "answered_at": at(21)} for key in required]
        if facts
        else [],
    )
    for index, choice in enumerate(choices, 1):
        due = due_events(plan["events"], state, set(), at(40 + index * 5))
        if not due:
            break
        assert [event["id"] for event, _ in due] == [plan["events"][index]["id"]]
        event, moment = due[0]
        eid, lid, crew = UUID(event["id"]), UUID(event["line"]["id"]), UUID(event["brigade_id"])
        state = replace(
            state,
            firings={**state.firings, eid: Firing(eid, moment, "plan")},
            presented={**state.presented, lid: at(40 + index * 5)},
            delivered={**state.delivered, lid: crew},
            replies={
                **state.replies,
                lid: []
                if choice is None
                else [{"at": at(41 + index * 5).isoformat(), "option_key": choice}],
            },
        )
    ctx = EvalContext(
        scenario={"reference": {"expected_flow": []}},
        current={},
        events=[],
        calls=state.calls,
        settings={
            "weights": dict.fromkeys((*CRITERIA, *BRIGADE_CRITERIA), 1.0),
            "critical_cap": 0.5,
        },
        scenario_events=tuple(
            {
                "event": event,
                "fired_at": state.firings[UUID(event["id"])].fired_at.isoformat(),
                "source": "plan",
                "presented_at": state.presented[UUID(event["line"]["id"])].isoformat(),
                "replies": state.replies.get(UUID(event["line"]["id"]), []),
            }
            for event in plan["events"]
            if UUID(event["id"]) in state.firings
        ),
    )
    result = world(
        {UUID(event["id"]): event for event in plan["events"]},
        state,
        at(200),
        contact_exts={"caller": {"74951234567"}},
    )
    adjusted = apply_world([work], result, set())[0]
    return ctx, BrigadeWorkCriterion().evaluate(ctx), fired_events(ctx), result, adjusted, work


@pytest.mark.parametrize("code", CODES)
def test_full_caller_facts_without_relay_cannot_receive_full_brigade_score(code):
    _, grade, outcomes, result, _, work = replay(code)
    assert [item.outcome.branch for item in outcomes] == ["met", "missed"]
    assert outcomes[1].outcome.expectations[0].state == "missed"
    assert "бригаде не ответили" in grade.evidence[1]
    assert result.delays[work.identity[0]] == 40
    assert grade.weight > 0
    assert not grade.critical
    assert grade.score < 1.0, (grade.score, grade.explanation, grade.evidence)


@pytest.mark.parametrize("code", CODES)
@pytest.mark.parametrize("choices", [("guess", None), ("relay", "guess"), ("relay", None)])
def test_wrong_or_missing_relay_part_is_scored(code, choices):
    _, grade, outcomes, result, _, work = replay(code, choices)
    assert outcomes[-1].outcome.branch in {"wrong", "missed"}
    assert result.delays[work.identity[0]] == 40
    assert grade.score == pytest.approx(0.5 if choices[0] == "guess" else 2 / 3)
    assert grade.remarks
    assert not grade.critical
    assert all(not item.fallback for item in outcomes)
    assert all("Страховка мира" not in text for text in grade.evidence)


@pytest.mark.parametrize("code", CODES)
def test_complete_caller_relay_retains_full_score(code):
    _, grade, outcomes, result, adjusted, work = replay(code, ("relay", "relay"))
    assert [item.outcome.branch for item in outcomes] == ["met", "met", "met"]
    assert work.identity[0] not in result.delays
    assert adjusted.ready_at == at(51)
    assert grade.score == 1.0
    assert grade.weight > 0
    assert not grade.critical
    assert not grade.remarks
    assert all(not item.fallback for item in outcomes)


@pytest.mark.parametrize("parent_branch", ("met", "late"))
def test_explicit_relay_gate_scores_continuation_and_preserves_parent_penalty(parent_branch):
    from copy import deepcopy

    ctx, _, _, _, _, _ = replay(CODES[0])
    rows = deepcopy(list(ctx.scenario_events))
    parent, relay = (row["event"] for row in rows)
    gate = parent["branches"]["met"]["awaits_call"]
    parent["branches"][parent_branch]["awaits_call"] = gate
    relay["trigger"]["branch"] = parent_branch
    if parent_branch == "late":
        rows[0]["replies"][0]["at"] = at(41).isoformat()
    grade = BrigadeWorkCriterion().evaluate(replace(ctx, scenario_events=tuple(rows)))
    assert grade.score == pytest.approx(0.5 if parent_branch == "met" else 0.25)
    assert not grade.critical
    assert grade.remarks


def test_legacy_continuation_without_explicit_relay_gate_stays_fallback():
    from copy import deepcopy

    ctx, _, _, _, _, _ = replay(CODES[0])
    rows = deepcopy(list(ctx.scenario_events))
    del rows[0]["event"]["branches"]["met"]["awaits_call"]["relay_event"]
    grade = BrigadeWorkCriterion().evaluate(replace(ctx, scenario_events=tuple(rows)))
    assert grade.score == 1.0
    assert not grade.remarks
    assert grade.evidence[1].startswith("Страховка мира. ")


def test_fallback_after_terminal_relay_is_not_counted_again():
    from copy import deepcopy

    ctx, _, _, _, _, _ = replay(CODES[0], ("relay", "relay"))
    rows = deepcopy(list(ctx.scenario_events))
    terminal = rows[-1]["event"]
    nudge = deepcopy(rows[-1])
    nudge["event"]["id"] = "legacy-nudge"
    nudge["event"]["trigger"]["event_id"] = terminal["id"]
    nudge["replies"] = []
    rows.append(nudge)
    grade = BrigadeWorkCriterion().evaluate(replace(ctx, scenario_events=tuple(rows)))
    assert grade.score == 1.0
    assert not grade.remarks
    assert grade.evidence[-1].startswith("Страховка мира. ")
