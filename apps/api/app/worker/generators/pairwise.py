"""Пары значений признаков пути; считаем только достижимые сочетания каталога."""

from collections.abc import Iterable
from itertools import combinations, product
from typing import Any

Pair = tuple[tuple[str, str], tuple[str, str]]


def features(data: dict[str, Any]) -> dict[str, list[str]]:
    reports = {r["key"]: r["justifies_state"] for r in data["plan"]}
    events = {e["key"]: e for e in data.get("events", [])}

    def stage(event: dict[str, Any], seen: frozenset[str] = frozenset()) -> str:
        trigger = event["trigger"]
        parent = trigger.get("event")
        if parent in events and parent not in seen:
            return stage(events[parent], seen | {parent})
        return reports.get(trigger.get("report")) or trigger.get(
            "state", trigger.get("requires_state", "unknown")
        )

    def stages(kinds: set[str], *, question: bool = False) -> list[str]:
        values = {
            ("on_scene" if question and stage(e) in {"arrived", "working"} else stage(e))
            for e in events.values()
            if e["kind"] in kinds
        }
        return sorted(values) or ["none"]

    kinds = {e["kind"] for e in events.values()}
    return {
        "readback": ["yes" if "readback_error" in kinds else "no"],
        "question": stages({"clarify"}, question=True),
        "other_service": ["yes" if "request_service" in kinds else "no"],
        "contact": stages({"silence", "alarm"}),
        "outcome": [data["reference"]["expected_flow"][-1]],
    }


def pairs(values: dict[str, list[str]]) -> set[Pair]:
    # На одном пути бывают вопросы и в дороге, и на месте либо два осложнения
    # связи. Такой путь покрывает оба значения, но пары всегда между разными признаками.
    return {
        ((left, a), (right, b))
        for left, right in combinations(sorted(values), 2)
        for a, b in product(values[left], values[right])
    }


def covered(rows: Iterable[Any]) -> set[Pair]:
    """Фактически сохранённые пути, в том числе после fallback и перезапуска worker."""
    result: set[Pair] = set()
    for row in rows:
        constructor = (row.generation_metadata or {}).get("constructor", {})
        values = constructor.get("pairwise_features")
        if values is None and constructor.get("variant_signature"):
            # Пакет мог быть начат предыдущей версией worker.
            from app.worker.generators import variant_paths

            available = variant_paths.options(row.target_service_id, row.level)
            if variant := available.get(constructor["variant_signature"]):
                values = features(variant[1])
        if values:
            result.update(pairs(values))
    return result


def universe(available: dict[str, tuple[dict[str, Any], dict[str, Any]]]) -> set[Pair]:
    return {pair for _, data in available.values() for pair in pairs(features(data))}
