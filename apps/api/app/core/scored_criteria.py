"""Применимость сохранённых критериев без потери пояснений и legacy-оценок."""

from collections.abc import Mapping
from typing import Any


def criterion_weight(
    explanations: Any, key: str, weights: Mapping[str, Any] | None = None
) -> float:
    """Сохранённый вес главнее настроек: оценщик мог исключить критерий этой попытки.

    Старые строковые пояснения и записи без веса сохраняют прежний fallback: вес
    снимка, если он доступен читателю, иначе 1. Отсутствующий вес не означает нулевой.
    """
    stored = explanations.get(key) if isinstance(explanations, dict) else None
    fallback = (weights or {}).get(key, 1)
    return float(stored.get("weight", fallback) if isinstance(stored, dict) else fallback)


def applied_scores(
    scores: Mapping[str, Any], explanations: Any, weights: Mapping[str, Any] | None = None
) -> dict[str, float]:
    """Проекция для статистики; исходные баллы и audit-пояснения остаются нетронутыми."""
    return {
        key: float(score)
        for key, score in scores.items()
        if criterion_weight(explanations, key, weights) != 0
    }


def applied_critical_flags(flags: list[Any], explanations: Any) -> list[str]:
    """Не вменять исключённый критерий; неизвестные legacy-флаги не теряются."""
    return [str(key) for key in flags if criterion_weight(explanations, str(key)) != 0]
