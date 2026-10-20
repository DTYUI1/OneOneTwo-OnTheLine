"""Доклад с места меняет задачу (TC-05, contracts/evalcore.md, «Доклад меняет задачу»).

Доклад плана с `task_change`, который прозвучал на карточке, меняет эталон её оценки:
`expected_flow`, `expected_call` и `expected_comment` заменяют поля `scenario.reference`,
`comment_keywords` дописываются. Срок нового звонка `within_s` считается от предъявления
доклада: норматив критерия `call` (`before_s`, от выдачи карточки) — время до доклада плюс срок.
Не прозвучал — эталон прежний. Сценарий и план не меняются: эталон считается из журнала.
"""

import math
from dataclasses import dataclass, replace
from datetime import datetime

from evalcore.models import CriterionResult, EvalContext, Json

# Поле эталона → критерии, которые его читают: им — строка разбора о перемене задачи.
CRITERIA_BY_FIELD = {
    "expected_flow": ("status_flow",),
    "expected_call": ("call",),
    "comment_keywords": ("comment_keywords",),
}
REPLACED = ("expected_flow", "expected_comment")


@dataclass(frozen=True)
class TaskChange:
    """Сработавшая перемена задачи: что изменилось и какие поля эталона затронуты."""

    label: str
    fields: tuple[str, ...]


def _time(value: Json | None) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def _delivered_at(ctx: EvalContext) -> datetime | None:
    found = [
        _time(event.get("client_ts")) for event in ctx.events if event.get("type") == "deliver"
    ]
    return min((item for item in found if item is not None), default=None)


def changed_reference(ctx: EvalContext) -> tuple[dict[str, Json], list[TaskChange]]:
    """Эталон карточки после прозвучавших докладов с `task_change` и список перемен."""
    raw = ctx.scenario.get("reference")
    reference: dict[str, Json] = dict(raw) if isinstance(raw, dict) else {}
    changes: list[TaskChange] = []
    delivered_at = _delivered_at(ctx)
    for planned in ctx.planned_messages:
        change = planned.get("task_change")
        presented_at = _time(planned.get("presented_at"))
        if not isinstance(change, dict) or presented_at is None:
            continue
        fields: list[str] = []
        for field in REPLACED:
            if field in change:
                reference[field] = change[field]
                fields.append(field)
        call = change.get("expected_call")
        if isinstance(call, dict):
            within = call.get("within_s")
            within_s = float(within) if isinstance(within, (int, float)) else 0.0
            before = (presented_at - delivered_at).total_seconds() if delivered_at else 0.0
            reference["expected_call"] = {
                **{key: value for key, value in call.items() if key != "within_s"},
                "before_s": max(1, math.ceil(max(0.0, before) + within_s)),
            }
            fields.append("expected_call")
        keywords = change.get("comment_keywords")
        if isinstance(keywords, list):
            known = reference.get("comment_keywords")
            reference["comment_keywords"] = [
                *(known if isinstance(known, list) else []),
                *keywords,
            ]
            fields.append("comment_keywords")
        label = change.get("label")
        changes.append(TaskChange(str(label) if label else "задача изменилась", tuple(fields)))
    return reference, changes


def with_task_changes(ctx: EvalContext) -> tuple[EvalContext, list[TaskChange]]:
    """Контекст оценки с эталоном карточки; без перемен — тот же контекст."""
    reference, changes = changed_reference(ctx)
    if not changes:
        return ctx, []
    return replace(ctx, scenario={**ctx.scenario, "reference": reference}), changes


def explain(results: list[CriterionResult], changes: list[TaskChange]) -> list[CriterionResult]:
    """Первая строка доказательств критериев, чей эталон сменился: что изменилось."""
    if not changes:
        return results
    lines: dict[str, list[str]] = {}
    for change in changes:
        for field in change.fields:
            for key in CRITERIA_BY_FIELD.get(field, ()):
                line = f"Задача изменилась после доклада бригады: {change.label.rstrip('.')}."
                if line not in lines.setdefault(key, []):
                    lines[key].append(line)
    return [
        replace(result, evidence=[*lines[result.key], *result.evidence])
        if result.key in lines
        else result
        for result in results
    ]
