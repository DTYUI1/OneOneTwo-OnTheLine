from math import isfinite

from evalcore.brigade import BRIGADE_REGISTRY
from evalcore.comment import COMMENT_REGISTRY
from evalcore.criteria import REGISTRY, HandlingTimeCriterion, ReactionTimeCriterion
from evalcore.defaults import BRIGADE_CRITERIA, COMMENT_CRITERIA, CRITERIA
from evalcore.models import CriterionResult, EvalContext, Evaluation, Json
from evalcore.task_change import explain, with_task_changes
from evalcore.timing_contract import TimingResult

# Критерии с необязательным весом: без веса в settings не считаются (старые занятия).
OPTIONAL_CRITERIA = (*COMMENT_CRITERIA, *BRIGADE_CRITERIA)
SCORING_VERSION = "evalcore-report-completion-v3"


def _number(value: Json | None, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} должен быть числом")
    result = float(value)
    if not isfinite(result):
        raise ValueError(f"{name} должен быть конечным числом")
    return result


def configured_weights(settings: dict[str, Json]) -> dict[str, float]:
    """Прочитать неотрицательные веса семи критериев и заданных необязательных критериев.

    Критерий комментария (занятия до 28.09) или работы с бригадой (до 08.10) без веса в
    settings не считается.
    """
    raw_weights = settings.get("weights")
    if not isinstance(raw_weights, dict):
        raise ValueError("settings.weights должен быть объектом")

    missing = [key for key in CRITERIA if key not in raw_weights]
    if missing:
        raise ValueError(f"Не заданы веса критериев: {', '.join(missing)}")

    weights: dict[str, float] = {}
    for key in (*CRITERIA, *(key for key in OPTIONAL_CRITERIA if key in raw_weights)):
        weight = _number(raw_weights[key], f"settings.weights.{key}")
        if weight < 0:
            raise ValueError(f"Вес критерия {key} не может быть отрицательным")
        weights[key] = weight

    if not isfinite(sum(weights.values())):
        raise ValueError("Сумма весов критериев должна быть конечным числом")
    if sum(weights.values()) == 0:
        raise ValueError("Сумма весов критериев должна быть больше нуля")
    return weights


def aggregate(criteria: list[CriterionResult], critical_cap: float) -> Evaluation:
    """Взвешенная оценка; при critical сохранить различие между объёмами ошибок."""
    cap = float(critical_cap)
    if not isfinite(cap) or not 0 <= cap <= 1:
        raise ValueError("critical_cap должен быть конечным числом от 0 до 1")
    if not criteria:
        raise ValueError("Для оценки нужен хотя бы один критерий")

    seen: set[str] = set()
    weighted_sum = 0.0
    weight_sum = 0.0
    critical_flags: list[str] = []
    for result in criteria:
        if result.key in seen:
            raise ValueError(f"Критерий встречается дважды: {result.key}")
        seen.add(result.key)
        if result.key not in CRITERIA and result.key not in OPTIONAL_CRITERIA:
            raise ValueError(f"Неизвестный критерий: {result.key}")
        if not isfinite(result.score) or not 0 <= result.score <= 1:
            raise ValueError(f"Балл {result.key} должен быть от 0 до 1")
        if not isfinite(result.weight) or result.weight < 0:
            raise ValueError(f"Вес {result.key} должен быть неотрицательным конечным числом")
        weighted_sum += result.weight * result.score
        weight_sum += result.weight
        if result.critical and result.weight > 0:
            critical_flags.append(result.key)

    if weight_sum == 0:
        raise ValueError("Сумма весов критериев должна быть больше нуля")

    total = weighted_sum / weight_sum
    if critical_flags:
        # Прежний min(total, cap) склеивал все попытки с raw >= cap в один балл.
        # cap остаётся максимумом, а доля выполненной работы различает один
        # пропущенный звонок и попытку, в которой неверны несколько критериев.
        total *= cap
    return Evaluation(total=total, criteria=list(criteria), critical_flags=critical_flags)


def evaluate(ctx: EvalContext, *, timing: TimingResult | None = None) -> Evaluation:
    """Контракт T-006: Σ(wᵢ·sᵢ)/Σwᵢ; при critical — critical_cap × доля.

    Критерии вызываются в порядке defaults.CRITERIA, затем критерии комментария с заданным
    весом (им нужен ctx.text_checker), затем «Работа с бригадой» с заданным весом; веса
    всегда берутся из settings. Работа с бригадой без событий на карточке возвращает вес 0 —
    критерий не применялся: его нет ни в итоге, ни в списке критериев.
    При переданном TimingResult два временных критерия используют его версию и snapshot;
    отсутствие результата сохраняет прежнюю семантику для legacy-вызовов.
    """
    weights = configured_weights(ctx.settings)
    # Доклад с места, который прозвучал, меняет эталон карточки (TC-05).
    ctx, changes = with_task_changes(ctx)
    missing = [key for key in CRITERIA if key not in REGISTRY]
    if missing:
        raise NotImplementedError(f"T-006: не реализованы критерии: {', '.join(missing)}")

    results: list[CriterionResult] = []
    for key in CRITERIA:
        criterion = REGISTRY[key]
        if timing is not None and isinstance(
            criterion, (ReactionTimeCriterion, HandlingTimeCriterion)
        ):
            result = criterion.evaluate_timing(ctx, timing)
        else:
            result = criterion.evaluate(ctx)
        if result.key != key:
            raise ValueError(f"Критерий {key} вернул результат с ключом {result.key}")
        if result.weight != weights[key] and not (key == "handling_time" and result.weight == 0):
            raise ValueError(
                f"Критерий {key} вернул вес {result.weight}, но в settings задано {weights[key]}"
            )
        results.append(result)
    for key in COMMENT_CRITERIA:
        if key not in weights:
            continue
        result = COMMENT_REGISTRY[key].evaluate(ctx)
        if result.key != key or (
            result.weight != weights[key] and not (key == "spelling" and result.weight == 0)
        ):
            raise ValueError(f"Критерий {key} вернул чужой ключ или вес")
        results.append(result)
    for key in BRIGADE_CRITERIA:
        if key not in weights:
            continue
        result = BRIGADE_REGISTRY[key].evaluate(ctx)
        if result.key != key or result.weight not in {weights[key], 0.0}:
            raise ValueError(f"Критерий {key} вернул чужой ключ или вес")
        # Событий бригады не было — критерий не применялся: ни в итоге, ни в разборе.
        if result.weight == 0.0 and weights[key] != 0.0:
            continue
        results.append(result)

    raw_cap = ctx.settings.get("critical_cap")
    cap = _number(raw_cap, "settings.critical_cap")
    explained = explain(results, changes)
    # Настройки валидны, но все критерии с положительным весом могли оказаться
    # неприменимыми (например, только грамотность при отсутствии слов).
    # Баллы не начисляются; разбор сохраняет причины исключения каждого критерия.
    if not any(item.weight > 0 for item in explained):
        return Evaluation(total=0.0, criteria=explained, critical_flags=[])
    return aggregate(explained, cap)
