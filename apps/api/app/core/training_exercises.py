"""Служебные упражнения первого этапа: не каталог преподавателя."""

from uuid import NAMESPACE_URL, UUID, uuid5

TRAINING_EXERCISE_IDS = frozenset(
    uuid5(NAMESPACE_URL, f"arm112:c04:tutorial:bank:{service}")
    for service in ("101", "102", "103", "104", "GKH", "MOSLIFT")
)


def is_training_exercise(scenario_id: UUID) -> bool:
    return scenario_id in TRAINING_EXERCISE_IDS
