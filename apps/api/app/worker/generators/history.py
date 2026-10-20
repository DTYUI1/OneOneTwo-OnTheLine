"""Ограниченная подсказка о повторах; полная история остаётся у подбора путей."""

import json
from typing import Any

from app.core.config import settings

HISTORY_LESSONS = 5


def prompt_history(
    used: list[dict[str, str]],
    phrases: dict[str, list[dict[str, Any]]],
    rejected: list[dict[str, str]],
) -> dict[str, Any]:
    """Свежие целые наборы и причины исключения, без неизвестных id и обрезки фраз.

    История — лишь подсказка, не весь prompt: её UTF-8-объём не превосходит уже
    выделенный резерв ответа generation_max_tokens (байт — верхняя оценка токена).
    Отдельного неограниченного бюджета для истории нет. Базовые факты не урезаются.
    """
    context: dict[str, Any] = {}
    texts = {state: {p["id"]: p["text"] for p in options} for state, options in phrases.items()}
    seen = set()

    def append(key: str, item: Any) -> bool:
        candidate = {**context, key: [*context.get(key, []), item]}
        size = len(json.dumps(candidate, ensure_ascii=False, sort_keys=True).encode("utf-8"))
        if size > settings.generation_max_tokens:
            return False
        context.update(candidate)
        return True

    for previous in reversed(used):
        # Набор с неизвестной фразой модель всё равно не может повторить. В частности,
        # не передаём ей произвольный текст из устаревших metadata вместо отсутствующего id.
        if set(previous) != set(texts) or any(previous[s] not in texts[s] for s in texts):
            continue
        signature = tuple(previous[s] for s in sorted(texts))
        if signature in seen:
            continue
        seen.add(signature)
        append("used_report_sets", {s: texts[s][previous[s]] for s in texts})
        if len(context.get("used_report_sets", [])) == HISTORY_LESSONS:
            break
    for item in rejected:
        append("rejected", item)
    return context
