"""Хранение оснований критериев с чтением старых строковых пояснений."""

from collections.abc import Sequence
from typing import Any

from evalcore.models import CriterionResult  # type: ignore[import-untyped]

from app.core.models import Call

DEFAULT_EXPLANATION = "Пояснение будет добавлено оценщиком."


def pack_explanations(criteria: Sequence[CriterionResult]) -> dict[str, dict[str, Any]]:
    """Сохранить текст и факты вместе; входные списки оценщика не изменяются."""
    return {
        item.key: {"explanation": item.explanation, "evidence": list(item.evidence)}
        for item in criteria
    }


def unpack_explanation(value: str | dict[str, Any]) -> tuple[str, list[str]]:
    """Старая строка не содержит evidence: его нельзя восстанавливать из догадок."""
    if isinstance(value, str):
        return value, []
    return value["explanation"], list(value["evidence"])


def call_context(call: Call) -> dict[str, Any]:
    """Звонок для оценщика — один вид для API и worker: поле, добавленное в одном месте,
    не должно потеряться в другом (оценка разошлась бы между ними)."""
    return {
        "id": str(call.id),
        "service_id": call.service_id,
        "phone_ext": call.dialed_ext,
        "brigade_id": str(call.brigade_id) if call.brigade_id else None,
        "direction": call.direction,
        "refusal": call.refusal,
        "started_at": call.started_at.isoformat(),
        "answered_at": call.answered_at.isoformat() if call.answered_at else None,
        "ended_at": call.ended_at.isoformat() if call.ended_at else None,
        "transcript": call.transcript,
    }
