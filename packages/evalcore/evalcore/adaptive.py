from collections.abc import Mapping, Sequence
from datetime import datetime
from math import isfinite
from typing import Literal

from evalcore.iteration_contract import CalibrationObservation, Recommendation
from evalcore.models import Json, Prediction, Trainee

RECOMMENDATION_WINDOW = 5
COLD_START_ATTEMPTS = 3
INCREASE_SCORE = 0.8
DECREASE_SCORE = 0.6
MODEL_VERSION = "rules-v1"
METHODOLOGY_VERSION = "v03-explainable-1"


def predict(trainee: Trainee, scenario: dict[str, Json]) -> Prediction:
    """Контракт T-022: P = 1/(1+exp(-(θ-b))); время — лог-нормальная EWMA.

    MVP-STUB Verwelius: параметры обучения и калибровка реализуются в T-022.
    """
    raise NotImplementedError("T-022: реализовать прогноз и калибровку")


def _completed_at(observation: CalibrationObservation) -> datetime:
    try:
        value = datetime.fromisoformat(observation.completed_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("completed_at должен быть строкой date-time") from error
    if value.tzinfo is None:
        raise ValueError("completed_at должен содержать часовой пояс")
    return value


def _validated_score(observation: CalibrationObservation) -> float:
    if isinstance(observation.effective_score, bool):
        raise ValueError("effective_score должен быть конечным числом от 0 до 1")
    score = float(observation.effective_score)
    if not isfinite(score) or not 0 <= score <= 1:
        raise ValueError("effective_score должен быть конечным числом от 0 до 1")
    return score


def _confirmed_timeliness(observation: CalibrationObservation) -> bool | None:
    """Вернуть факт норматива только для подтверждённых сопоставимых измерений."""
    duration = observation.handling_s
    normative = observation.handling_normative_s
    if observation.timing_quality != "verified" or duration is None or normative is None:
        return None
    if isinstance(duration, bool) or not isfinite(duration) or duration < 0:
        raise ValueError("handling_s должен быть неотрицательным конечным числом")
    if isinstance(normative, bool) or not isfinite(normative) or normative <= 0:
        raise ValueError("handling_normative_s должен быть положительным конечным числом")
    return duration <= normative


def recommend_level(
    current_level: int,
    history: list[CalibrationObservation],
    *,
    critical_flags_by_card: Mapping[str, Sequence[str]] | None = None,
) -> Recommendation:
    """Предложить уровень по последним пяти попыткам понятными пороговыми правилами.

    До трёх попыток действует холодный старт. После него средний балл не ниже 0.8 без
    критических ошибок повышает сложность, балл ниже 0.6, повторные критические ошибки
    или большинство подтверждённых превышений понижают её. Остальные случаи сохраняют
    текущую сложность; уровень меняется не более чем на один шаг.
    """
    if (
        isinstance(current_level, bool)
        or not isinstance(current_level, int)
        or not 1 <= current_level <= 4
    ):
        raise ValueError("current_level должен быть целым числом от 1 до 4")

    recent = sorted(history, key=_completed_at)[-RECOMMENDATION_WINDOW:]
    scores = [_validated_score(item) for item in recent]
    based_on = len(recent)
    current_weight = recent[-1].weight if recent else min(10, current_level * 2)
    if (
        isinstance(current_weight, bool)
        or not isinstance(current_weight, int)
        or not 1 <= current_weight <= 10
    ):
        raise ValueError("weight должен быть целым числом от 1 до 10")

    flags_known = critical_flags_by_card is not None
    flags = critical_flags_by_card or {}
    critical_attempts = (
        sum(bool(flags.get(item.card_id, ())) for item in recent) if flags_known else None
    )
    timing = [value for item in recent if (value := _confirmed_timeliness(item)) is not None]
    timely = sum(timing)
    overdue = len(timing) - timely

    evidence = [f"Учтено последних завершённых попыток: {based_on}."]
    if scores:
        mean_score = sum(scores) / based_on
        evidence.append(f"Средний итоговый балл: {mean_score:.2f}.")
    else:
        mean_score = None
        evidence.append("Завершённых оценённых попыток пока нет.")
    if critical_attempts is None:
        evidence.append("Сведения о критических ошибках не переданы.")
    else:
        evidence.append(f"Попыток с критическими ошибками: {critical_attempts}.")
    if timing:
        evidence.append(f"Норматив времени соблюдён в {timely} из {len(timing)} измерений.")
    else:
        evidence.append("Подтверждённых сопоставимых измерений времени нет.")

    if based_on < COLD_START_ATTEMPTS:
        evidence.insert(0, "Холодный старт: данных для изменения уровня мало.")
        return Recommendation(
            level=current_level,
            weight=current_weight,
            direction="keep",
            based_on_attempts=based_on,
            model_version=MODEL_VERSION,
            methodology_version=METHODOLOGY_VERSION,
            evidence=evidence,
            explanation="Холодный старт: сохраняем текущий уровень до накопления трёх попыток.",
        )

    decrease = bool(
        mean_score is not None
        and (
            mean_score < DECREASE_SCORE
            or (critical_attempts is not None and critical_attempts >= 2)
            or (timing and overdue > len(timing) / 2)
        )
    )
    increase = bool(
        mean_score is not None
        and mean_score >= INCREASE_SCORE
        and critical_attempts == 0
        and overdue == 0
    )
    direction: Literal["increase", "keep", "decrease"]
    if decrease:
        level = max(1, current_level - 1)
        weight = max(1, current_weight - 1)
        direction = "decrease" if (level, weight) != (current_level, current_weight) else "keep"
    elif increase:
        level = min(4, current_level + 1)
        weight = min(10, current_weight + 1)
        direction = "increase" if (level, weight) != (current_level, current_weight) else "keep"
    else:
        level, weight, direction = current_level, current_weight, "keep"

    explanations = {
        "increase": "Результаты устойчивы: рекомендуется повысить сложность на один шаг.",
        "decrease": "Есть повторяющиеся затруднения: рекомендуется снизить сложность на один шаг.",
        "keep": "Недостаточно оснований для изменения: рекомендуется сохранить сложность.",
    }
    return Recommendation(
        level=level,
        weight=weight,
        direction=direction,
        based_on_attempts=based_on,
        model_version=MODEL_VERSION,
        methodology_version=METHODOLOGY_VERSION,
        evidence=evidence,
        explanation=explanations[direction],
    )
