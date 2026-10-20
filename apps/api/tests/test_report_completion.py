"""Закрытие карточки без докладов не приносит баллы за нетронутые поля."""

from dataclasses import replace
from uuid import uuid4

import pytest
from app.api.analysis.service import evaluation_analysis
from app.core.models import Evaluation as StoredEvaluation
from app.core.report_completion import apply_report_completion
from app.worker.judging import combine, combine_scores
from app.worker.providers.judge import JudgeVerdict
from evalcore.models import CriterionResult, EvalContext, Evaluation

STATES = ("arrived", "working", "completed")
HEARD_AT = "2026-10-19T10:00:00+00:00"
CLOSED_AT = "2026-10-19T10:05:00+00:00"


def context(heard: int, *, terminal: str = "completed") -> EvalContext:
    return EvalContext(
        scenario={"reference": {"expected_flow": ["received", "accepted", *STATES]}},
        current={},
        events=[
            {
                "type": "status_change",
                "server_ts": CLOSED_AT,
                "payload": {"state": terminal},
            }
        ],
        calls=[],
        settings={},
        planned_messages=tuple(
            {
                "message_id": f"report-{index}",
                "justifies_state": state,
                "presented_at": HEARD_AT if index < heard else None,
            }
            for index, state in enumerate(STATES)
        ),
    )


def evaluation() -> Evaluation:
    return Evaluation(
        total=0.9,
        criteria=[CriterionResult("status_flow", 1, 1, False, [], "Ход карточки.")],
        critical_flags=[],
    )


@pytest.mark.parametrize("terminal", ["completed", "refused", "rejected", "redirected"])
def test_no_confirmed_reports_zeroes_terminal_attempt(terminal):
    scored, factor = apply_report_completion(evaluation(), context(0, terminal=terminal), terminal)

    assert scored.total == 0
    assert factor == 0
    assert "не принят ни один" in scored.criteria[0].explanation
    assert evaluation().total == 0.9


@pytest.mark.parametrize("heard", [1, 2])
def test_missing_reports_reduce_whole_result_by_squared_completion(heard):
    scored, factor = apply_report_completion(evaluation(), context(heard), "completed")

    assert factor == pytest.approx((heard / 3) ** 2)
    assert scored.total == pytest.approx(0.9 * factor)
    assert "Дополнительный множитель" in scored.criteria[0].explanation


def test_all_confirmed_reports_preserve_score():
    original = evaluation()
    scored, factor = apply_report_completion(original, context(3), "completed")

    assert scored is original
    assert factor == 1


@pytest.mark.parametrize("terminal", ["refused", "rejected", "redirected"])
def test_scenario_without_required_reports_is_not_penalized(terminal):
    ctx = context(0, terminal=terminal)
    ctx = replace(ctx, scenario={"reference": {"expected_flow": ["received", terminal]}})

    assert apply_report_completion(evaluation(), ctx, terminal)[1] == 1


def test_refusal_supported_by_its_report_is_not_zeroed():
    ctx = context(0, terminal="refused")
    ctx = replace(
        ctx,
        scenario={"reference": {"expected_flow": ["received", "accepted", "refused"]}},
        planned_messages=(
            {"message_id": "refusal", "justifies_state": "refused", "presented_at": HEARD_AT},
        ),
    )

    assert apply_report_completion(evaluation(), ctx, "refused")[1] == 1


def test_no_plan_preserves_legacy_evaluation():
    ctx = replace(context(0), planned_messages=())

    assert apply_report_completion(evaluation(), ctx, "completed")[1] == 1


def test_report_presented_after_closure_does_not_earn_credit():
    ctx = context(3)
    ctx = replace(
        ctx,
        planned_messages=tuple(
            {**item, "presented_at": "2026-10-19T10:06:00+00:00"} for item in ctx.planned_messages
        ),
    )

    assert apply_report_completion(evaluation(), ctx, "completed")[0].total == 0


def test_heard_task_change_can_remove_remaining_reports_from_required_flow():
    ctx = context(0, terminal="redirected")
    ctx = replace(
        ctx,
        planned_messages=(
            {
                "message_id": "new-task",
                "justifies_state": None,
                "presented_at": HEARD_AT,
                "task_change": {"expected_flow": ["received", "rejected", "redirected"]},
            },
            *ctx.planned_messages,
        ),
    )

    assert apply_report_completion(evaluation(), ctx, "redirected")[1] == 1


def test_ai_layer_cannot_restore_points_for_unheard_reports():
    verdict = JudgeVerdict(["факт"], [], 1.0, "Комментарий понятен.")

    assert combine(0, False, 0.5, verdict, completion_factor=0) == 0
    assert combine(0.9 * 0.25, False, 0.5, verdict, completion_factor=0.25) == pytest.approx(
        combine(0.9, False, 0.5, verdict) * 0.25
    )


def test_final_zero_does_not_wait_forever_for_skipped_ai_check():
    row = StoredEvaluation(
        id=uuid4(),
        version=1,
        total=0,
        status="complete",
        rules_scores={"status_flow": 0.5},
        llm_scores=None,
        explanation={},
        model_info={
            "rules": "rules-test",
            "llm": "rule:no-reports",
            "report_completion_factor": "0.0",
        },
    )

    result = evaluation_analysis(row, None, False, {})

    assert result["status"] == "complete"
    assert result["effective_total"] == 0
    assert result["partial_reasons"] == []
    assert result["required_layers"] == ["rules"]
    assert next(item for item in result["layers"] if item["layer"] == "llm")["status"] == (
        "not_applicable"
    )


def test_late_rules_refresh_cannot_restore_points_from_saved_ai_scores():
    saved_scores = {"comment_completeness": 1.0, "comment_clarity": 1.0}

    assert combine_scores(0, False, 0.5, saved_scores, completion_factor=0) == 0


def test_early_refusal_uses_completion_penalty_and_excludes_inapplicable_criteria():
    """Правила dev дают ноль без докладов; время и пустой текст не добавляют баллы."""
    from evalcore.comment import SpellingCriterion
    from evalcore.criteria import HandlingTimeCriterion, StatusFlowCriterion
    from evalcore.scoring import aggregate

    ctx = context(0, terminal="refused")
    ctx = replace(
        ctx,
        settings={"weights": {"status_flow": 1, "handling_time": 1, "spelling": 1}},
        events=[
            {"type": "deliver", "server_ts": HEARD_AT, "payload": {}},
            {
                "type": "status_change",
                "server_ts": HEARD_AT,
                "payload": {"state": "accepted", "comment": ""},
            },
            *ctx.events,
        ],
    )
    ctx = replace(ctx, events=[{**event, "client_ts": event["server_ts"]} for event in ctx.events])
    results = [
        StatusFlowCriterion().evaluate(ctx),
        HandlingTimeCriterion().evaluate(ctx),
        SpellingCriterion().evaluate(ctx),
    ]
    raw = aggregate(results, 0.5)
    scored, factor = apply_report_completion(raw, ctx, "refused")

    assert raw.total > 0
    assert scored.total == factor == 0
    assert not scored.critical_flags  # Нет второго, дублирующего штрафа за отказ.
    assert scored.criteria[1].weight == scored.criteria[2].weight == 0
    assert "Время обработки не оценивается" in scored.criteria[1].explanation
    assert "Грамотность не оценивается" in scored.criteria[2].explanation
    assert scored.criteria[0].explanation.count("не принят ни один") == 1
