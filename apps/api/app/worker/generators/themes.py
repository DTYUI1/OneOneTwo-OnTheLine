"""Темы занятий: основной тип происшествия, независимо от обслуживающей службы."""

from typing import Any, Literal

Category = Literal[
    "traffic", "fire", "gas", "medicine", "utilities", "lift", "public_order", "animals", "other"
]
CATEGORIES: dict[str, str] = {
    "traffic": "ДТП",
    "fire": "Пожар и задымление",
    "gas": "Газ",
    "medicine": "Медицина",
    "utilities": "Вода и отопление",
    "lift": "Лифт",
    "public_order": "Общественный порядок",
    "animals": "Животные",
    "other": "Прочее",
}
INCIDENT_CATEGORIES: dict[str, Category] = {
    "fire_flat": "fire",
    "tree": "other",
    "missing": "public_order",
    "car_theft": "public_order",
    "stroke": "medicine",
    "child": "medicine",
    "gas_street": "gas",
    "car_fire": "fire",
    "door": "other",
    "theft": "public_order",
    "domestic": "public_order",
    "fall": "medicine",
    "co": "gas",
    "traffic": "traffic",
    "smoke": "fire",
    "gas_flat": "gas",
    "gas_smell": "gas",
    "heart": "medicine",
    "heating": "utilities",
    "leak_ceiling": "utilities",
    "no_water": "utilities",
    "pipe_basement": "utilities",
    "pipe_flat": "utilities",
    "sewer": "utilities",
    "electric": "utilities",
    "roof": "utilities",
    "lift": "lift",
    "lift_child": "lift",
    "lift_ill": "lift",
    "lift_fault": "lift",
    "lift_fire": "fire",
    "fight": "public_order",
    "injury": "public_order",  # Травмы после драки — то же происшествие, обслуживаемое 103.
    "animal": "animals",
}


def category(template: dict[str, Any]) -> Category:
    from app.worker.generators.gameplay import incident_of

    return INCIDENT_CATEGORIES.get(incident_of(template), "other")


def warning(service_id: str, level: int, categories: list[str] | tuple[str, ...]) -> str | None:
    from app.worker.generators.gameplay import template_candidates

    if categories and not any(
        category(t) in categories for t in template_candidates(service_id, level)
    ):
        labels = ", ".join(CATEGORIES[c] for c in dict.fromkeys(categories))
        return (
            f"Для службы {service_id}, уровня {level} нет сюжетов по темам «{labels}». "
            "Использован полный набор тем для этой службы и уровня."
        )
    return None


def warnings(payload: dict[str, Any]) -> list[str]:
    """Одинаковое предупреждение в прогрессе пакета и подготовки занятия."""
    categories = payload.get("categories", [])
    if not categories:
        return []
    return list(
        dict.fromkeys(
            message
            for item in payload.get("items", [payload])
            if (message := warning(item["service_id"], item["level"], categories))
        )
    )
