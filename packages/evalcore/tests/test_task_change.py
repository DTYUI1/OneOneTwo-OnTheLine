"""TC-05: доклад с места меняет задачу — эталон оценки после доклада другой.

Доклад плана с `task_change` (contracts/evalcore.md, «Доклад меняет задачу») прозвучал —
эталон карточки меняется: звонок в 112 становится обязательным со сроком от доклада, ключевые
слова комментария дописываются, критерии называют перемену первой строкой разбора. Не
прозвучал — эталон и разбор прежние.
"""

from evalcore.criteria import CallCriterion
from evalcore.defaults import CRITERIA
from evalcore.models import CriterionResult, EvalContext
from evalcore.task_change import changed_reference, explain, with_task_changes

from .test_brigade_work import call, iso

CHANGE = {
    "kind": "other_service",
    "label": "Загорелась машина — нужна пожарная охрана: сообщить в 112",
    "expected_call": {"required": True, "service_id": "112", "phone_ext": "112", "within_s": 60},
    "expected_comment": "Под капотом загорелось, сообщено в 112.",
    "comment_keywords": ["пожар / загорелось"],
}
LINE = "Задача изменилась после доклада бригады: " + CHANGE["label"] + "."


def context(presented_at: float | None, calls=(), change=CHANGE) -> EvalContext:
    """Карточка выдана в 0 с; доклад о работах с переменой задачи — в `presented_at`."""
    return EvalContext(
        {
            "target_service_id": "102",
            "reference": {
                "expected_flow": ["received", "accepted", "working", "completed"],
                "expected_call": {
                    "required": False,
                    "service_id": "102",
                    "phone_ext": "102",
                    "before_s": 180,
                },
                "expected_comment": "ДТП без пострадавших.",
                "comment_keywords": ["знак"],
            },
        },
        {},
        [{"type": "deliver", "client_ts": iso(0), "payload": {}}],
        list(calls),
        {"weights": {key: 1.0 for key in CRITERIA}, "critical_cap": 0.5},
        planned_messages=(
            {"message_id": "m-arrival", "justifies_state": "arrived", "presented_at": iso(20)},
            {
                "message_id": "m-works",
                "justifies_state": "working",
                "presented_at": iso(presented_at) if presented_at is not None else None,
                "task_change": change,
            },
        ),
    )


def test_reference_changes_only_after_report_is_heard():
    before, none = changed_reference(context(None))
    assert none == []
    assert before["expected_call"] == {
        "required": False,
        "service_id": "102",
        "phone_ext": "102",
        "before_s": 180,
    }

    after, changes = changed_reference(context(100))
    assert [change.label for change in changes] == [CHANGE["label"]]
    # Срок — от выдачи карточки до доклада (100 с) плюс минута на звонок.
    assert after["expected_call"] == {
        "required": True,
        "service_id": "112",
        "phone_ext": "112",
        "before_s": 160,
    }
    assert after["expected_comment"] == CHANGE["expected_comment"]
    assert after["comment_keywords"] == ["знак", "пожар / загорелось"]
    assert after["expected_flow"] == before["expected_flow"]


def test_call_after_report_in_time_is_full_score():
    ctx, changes = with_task_changes(context(100, [call("112", 150, answered=152)]))
    result = CallCriterion().evaluate(ctx)
    assert result.score == 1.0
    assert explain([result], changes)[0].evidence[0] == LINE


def test_no_call_after_report_loses_call_score_and_says_why():
    ctx, changes = with_task_changes(context(100))
    result = explain([CallCriterion().evaluate(ctx)], changes)[0]
    assert result.score == 0.0
    # Обязательный звонок не сделан — как у любого обязательного звонка эталона.
    assert result.critical
    assert result.evidence[0] == LINE


def test_unheard_report_keeps_old_reference_and_review():
    ctx = context(None)
    same, changes = with_task_changes(ctx)
    assert same is ctx and changes == []
    result = CallCriterion().evaluate(same)
    assert result.score == 1.0
    assert result.evidence == ["Обязательный звонок не предусмотрен эталоном"]


def test_line_goes_only_to_criteria_whose_reference_changed():
    _, changes = changed_reference(context(100))
    results = [
        CriterionResult(key, 1.0, 1.0, False, ["факт"], "пояснение")
        for key in ("status_flow", "call", "comment_keywords", "address")
    ]
    lines = {result.key: result.evidence for result in explain(results, changes)}
    assert lines["call"] == [LINE, "факт"]
    assert lines["comment_keywords"] == [LINE, "факт"]
    assert lines["status_flow"] == ["факт"]
    assert lines["address"] == ["факт"]
