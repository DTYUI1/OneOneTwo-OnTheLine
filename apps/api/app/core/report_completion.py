"""Дополнительный множитель итога за реально принятые доклады плана."""

from dataclasses import replace
from datetime import datetime

from evalcore.models import EvalContext, Evaluation  # type: ignore[import-untyped]
from evalcore.task_change import with_task_changes  # type: ignore[import-untyped]

REPORT_COMPLETION_VERSION = "confirmed-reports-v1"
_REPORT_STATES = frozenset({"responding", "arrived", "working", "completed", "refused"})
_TERMINAL_STATES = frozenset({"completed", "refused", "rejected", "redirected"})


def _timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def apply_report_completion(
    evaluation: Evaluation, context: EvalContext, terminal_state: str
) -> tuple[Evaluation, float]:
    """Итог × (принятые / требуемые доклады)²; без принятых докладов — ноль.

    Только доклады этапов действующего эталона и только до закрытия карточки. Законное
    перенаправление, отказ по сценарию без бригады и старые планы без связей не требуют
    выдуманных докладов. Множитель не меняет отдельные критерии: он ограничивает общий
    результат, чтобы нетронутые верные поля и быстрый отказ не заменяли выполнение задачи.
    """
    if terminal_state not in _TERMINAL_STATES:
        return evaluation, 1.0
    terminal_times = []
    for event in context.events:
        payload = event.get("payload")
        is_terminal = (
            event.get("type") == "redirect"
            or event.get("type") == "status_change"
            and isinstance(payload, dict)
            and isinstance(payload.get("state"), str)
            and payload.get("state") in _TERMINAL_STATES
        )
        if is_terminal:
            at = _timestamp(event.get("server_ts") or event.get("client_ts"))
            if at is not None:
                terminal_times.append(at)
    closed_at = max(terminal_times, default=None)
    if closed_at is not None:
        # Позднее подтверждение не меняет ни зачёт докладов, ни эталон уже закрытой карточки.
        context = replace(
            context,
            planned_messages=tuple(
                {**report, "presented_at": None}
                if (at := _timestamp(report.get("presented_at"))) is not None and at > closed_at
                else report
                for report in context.planned_messages
            ),
        )
    context, _ = with_task_changes(context)
    reference = context.scenario.get("reference")
    flow = reference.get("expected_flow") if isinstance(reference, dict) else None
    if not isinstance(flow, list):
        return evaluation, 1.0
    required_states = {state for state in flow if isinstance(state, str)} & _REPORT_STATES
    if not required_states:
        return evaluation, 1.0
    reports: dict[tuple[str, str], bool] = {}
    for report in context.planned_messages:
        state = report.get("justifies_state")
        if not isinstance(state, str) or state not in required_states:
            continue
        key = (str(report.get("message_id") or state), state)
        presented = _timestamp(report.get("presented_at"))
        heard = presented is not None and (closed_at is None or presented <= closed_at)
        reports[key] = reports.get(key, False) or heard
    if not reports or all(reports.values()):
        return evaluation, 1.0
    heard_count = sum(reports.values())
    factor = (heard_count / len(reports)) ** 2
    note = (
        "Карточка закрыта, но не принят ни один требуемый доклад бригады: итог 0 %."
        if heard_count == 0
        else (
            f"До закрытия принято {heard_count} из {len(reports)} требуемых докладов бригады. "
            f"Дополнительный множитель итога за незавершённую работу: {factor:.3f}."
        )
    )
    return (
        replace(
            evaluation,
            total=evaluation.total * factor,
            criteria=[
                replace(
                    item,
                    explanation=f"{item.explanation} {note}",
                    evidence=[*item.evidence, note],
                )
                if item.key == "status_flow"
                else item
                for item in evaluation.criteria
            ],
        ),
        factor,
    )
