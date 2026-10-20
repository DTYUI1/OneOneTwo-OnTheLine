"""L-01: ход статусов учитывает только предъявленные обучаемому доклады бригады."""

from dataclasses import replace

import pytest
from evalcore.criteria import StatusFlowCriterion
from evalcore.defaults import CRITERIA
from evalcore.models import EvalContext

FULL_FLOW = ["received", "accepted", "responding", "arrived", "working", "completed"]


def context(states, planned=()):
    events = [{"type": "deliver", "client_ts": "2026-09-27T09:00:00Z", "payload": {}}]
    events += [
        {
            "type": "status_change",
            "client_ts": f"2026-09-27T09:00:{index + 1:02d}Z",
            "payload": {"state": state},
        }
        for index, state in enumerate(states)
    ]
    return EvalContext(
        {"reference": {"expected_flow": FULL_FLOW}},
        {},
        events,
        [],
        {"weights": {key: 1.0 for key in CRITERIA}},
        planned_messages=tuple(planned),
    )


def reports(*presented):
    return [
        {
            "message_id": f"m-{state}",
            "justifies_state": state,
            "presented_at": "2026-09-27T09:00:00Z" if state in presented else None,
        }
        for state in ("responding", "arrived", "working", "completed")
    ]


SHORT = ["accepted", "responding", "arrived", "completed"]


def test_without_plan_scores_as_before():
    result = StatusFlowCriterion().evaluate(context(SHORT))

    assert result.score == pytest.approx(5 / 6)
    assert "Не потребовал" not in result.explanation


def test_plan_without_links_scores_as_before():
    planned = [{**item, "justifies_state": None} for item in reports()]

    result = StatusFlowCriterion().evaluate(context(SHORT, planned))

    assert result.score == pytest.approx(5 / 6)


def test_status_without_report_is_critical_even_when_report_was_not_presented():
    result = StatusFlowCriterion().evaluate(context(SHORT, reports("responding", "arrived")))

    assert result.score == pytest.approx(4 / 5)
    assert result.critical
    assert "Преждевременные статусы" in result.evidence[-1]
    assert "Работы завершены" in result.evidence[-1]
    assert "«Проведение работ»" in result.explanation
    assert "не был предъявлен" in result.explanation


def test_unpresented_report_without_status_is_not_required():
    states = ["accepted", "responding", "arrived"]
    result = StatusFlowCriterion().evaluate(context(states, reports("responding", "arrived")))

    assert result.score == 1.0
    assert not result.critical


def test_report_presented_after_status_does_not_retroactively_justify_it():
    late = [{**item, "presented_at": "2026-09-27T10:00:00Z"} for item in reports("responding")]
    result = StatusFlowCriterion().evaluate(context(["accepted", "responding"], late))

    assert result.score < 1
    assert result.critical


def test_presented_report_without_status_lowers_score():
    result = StatusFlowCriterion().evaluate(
        context(SHORT, reports("responding", "arrived", "working", "completed"))
    )

    assert result.score == pytest.approx(5 / 6)
    assert "Не потребовал" not in result.explanation


def test_single_unpresented_report_note():
    result = StatusFlowCriterion().evaluate(
        context(SHORT, reports("responding", "arrived", "completed"))
    )

    assert result.score == 1.0
    assert "Не потребовался статус «Проведение работ»: доклад бригады о нём" in result.explanation


def test_denied_status_is_named_without_changing_score():
    """GP-26: статус без доклада, который сервер не принял, — строка разбора, не балл."""
    planned = reports("responding", "arrived", "working", "completed")
    plain = context(FULL_FLOW[1:], planned)
    denied = {
        "type": "status_denied",
        "client_ts": "2026-09-27T09:00:01Z",
        "server_ts": "2026-09-27T09:00:01Z",
        "payload": {"state": "arrived", "code": "report_required", "message": "…"},
    }
    ctx = replace(plain, events=[*plain.events, denied, denied])

    before = StatusFlowCriterion().evaluate(plain)
    result = StatusFlowCriterion().evaluate(ctx)

    assert (result.score, result.critical) == (before.score, before.critical) == (1.0, False)
    line = "«Прибытие» — не было доклада бригады о прибытии"
    assert result.evidence[-1] == f"Не принят сервером: {line}"
    assert result.evidence.count(f"Не принят сервером: {line}") == 1
    assert result.explanation.endswith(f"Статус без доклада сервер не принял: {line}.")
    assert "Факт: Получена службой → Принята → Начало реагирования → Прибытие" in result.evidence[1]


@pytest.mark.parametrize("terminal", ["refused", "completed", "redirected"])
def test_early_terminal_action_does_not_reward_handling_time(terminal):
    import json
    from pathlib import Path

    from evalcore.criteria import HandlingTimeCriterion
    from evalcore.timing import calculate_timing
    from evalcore.timing_contract import TimingInput
    from pydantic import TypeAdapter

    ctx = context(["accepted", terminal], reports())
    criterion = HandlingTimeCriterion()
    legacy = criterion.evaluate(ctx)
    assert legacy.weight == 0
    assert "не оценивается" in legacy.explanation
    cases = json.loads(
        (Path(__file__).parents[3] / "contracts/examples/timing-v3.json").read_text()
    )
    timing = calculate_timing(TypeAdapter(TimingInput).validate_python(cases[0]["input"]))
    assert criterion.evaluate_timing(ctx, timing).weight == 0


def test_missing_stage_in_plan_is_data_issue_not_early_closure():
    from evalcore.criteria import HandlingTimeCriterion

    planned = [item for item in reports(*FULL_FLOW) if item["justifies_state"] != "working"]
    ctx = context(SHORT, planned)
    assert StatusFlowCriterion().evaluate(ctx).score == 1
    assert "досрочно" not in StatusFlowCriterion().evaluate(ctx).explanation
    assert HandlingTimeCriterion().evaluate(ctx).weight == 1


def test_rejected_is_not_terminal_and_can_be_followed_by_redirect():
    from evalcore.criteria import HandlingTimeCriterion

    ctx = context(["rejected"], reports())
    assert HandlingTimeCriterion().evaluate(ctx).weight == 1
    assert "досрочно" not in StatusFlowCriterion().evaluate(ctx).explanation
