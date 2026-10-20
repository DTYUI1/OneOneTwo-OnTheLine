"""Воспроизводимый упор на слабые навыки без изменения правил уровня."""

import random
from typing import Any

LABELS = {
    "readback_error": "ловушкой повтора адреса",
    "request_service": "вызовом другой службы",
    "silence": "проверкой связи с молчащей бригадой",
    "clarify": "ответом на вопрос бригады",
    "reaction_time": "быстрой реакцией на тревогу",
}


def focus_orders(count: int, seed: int) -> set[int]:
    """Около 60% мест пакета; порядок перемешан, повтор задания сохраняет выбор."""
    orders = list(range(1, count + 1))
    random.Random(f"{seed}:weak-spots").shuffle(orders)
    return set(orders[: round(count * 0.6)])


def matched(data: dict[str, Any], profile: dict[str, Any]) -> list[str]:
    kinds = {e["kind"] for e in data.get("events", [])}
    return [
        skill
        for skill, value in sorted(profile.items())
        if value["rate"] > 0 and ("alarm" if skill == "reaction_time" else skill) in kinds
    ]


def selection(
    data: dict[str, Any], profile: dict[str, Any], focus: bool, user_id: str
) -> dict[str, Any]:
    skills = matched(data, profile)
    targeted = focus and bool(skills)
    reason = (
        "Упор на слабые места: "
        + "; ".join(
            f"задание с {LABELS[s]} — ошибки в {profile[s]['failed']} "
            f"из {profile[s]['total']} случаев"
            for s in skills
        )
        + "."
        if targeted
        else "Обычный вариант для закрепления навыков."
        if not focus or not profile
        else "На этом уровне нет доступного варианта под слабые места; выбран обычный вариант."
    )
    return {
        "user_id": user_id,
        "profile": profile,
        "focus": focus,
        "targeted": targeted,
        "skills": skills,
        "explanation": reason,
    }


def summary(login: str, scenarios: list[Any]) -> str:
    """Считаем фактически созданные карточки, включая откаты на шаблон."""
    selections = [
        (s.generation_metadata or {}).get("constructor", {}).get("personalization", {})
        for s in scenarios
    ]
    parts = []
    for skill, label in LABELS.items():
        count = sum(skill in item.get("skills", []) for item in selections)
        if count:
            parts.append(f"{count} из {len(scenarios)} с {label} — ранее допускал ошибки")
    return f"Подобрано для {login}: " + (
        "; ".join(parts) + "."
        if parts
        else "обычный подбор, подтверждённых слабых мест для этих вариантов нет."
    )
