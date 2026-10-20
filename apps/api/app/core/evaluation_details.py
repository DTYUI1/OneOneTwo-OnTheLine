"""Хранение оснований критериев с чтением старых строковых пояснений."""

from collections.abc import Sequence
from dataclasses import asdict
from typing import Any

from evalcore.models import CriterionResult  # type: ignore[import-untyped]
from evalcore.remarks import default_remarks  # type: ignore[import-untyped]

from app.core.models import Call

DEFAULT_EXPLANATION = "Пояснение будет добавлено оценщиком."


def pack_explanations(criteria: Sequence[CriterionResult]) -> dict[str, dict[str, Any]]:
    """Сохранить текст, факты и замечания разбора (TC-10); входные списки не изменяются."""
    return {
        item.key: {
            "weight": item.weight,
            "explanation": item.explanation,
            "evidence": list(item.evidence),
            "remarks": [asdict(remark) for remark in item.remarks],
        }
        for item in criteria
    }


def unpack_remarks(value: str | dict[str, Any], key: str, score: float) -> list[dict[str, Any]]:
    """Замечания критерия. Оценка до TC-10 (нет поля `remarks`) — общее замечание по ключу
    критерия при потере балла: страница памятки и последствие те же, что у нового оценщика."""
    if isinstance(value, dict) and isinstance(value.get("remarks"), list):
        return [dict(item) for item in value["remarks"]]
    text = value if isinstance(value, str) else str(value.get("explanation", ""))
    return [asdict(remark) for remark in default_remarks(key, score, text)]


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
        "end_reason": call.end_reason,
        "transcript": call.transcript,
    }
