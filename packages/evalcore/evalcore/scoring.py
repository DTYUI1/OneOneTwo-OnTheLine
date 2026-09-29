from math import isfinite

from evalcore.comment import COMMENT_REGISTRY
from evalcore.criteria import REGISTRY, HandlingTimeCriterion, ReactionTimeCriterion
from evalcore.defaults import COMMENT_CRITERIA, CRITERIA
from evalcore.models import CriterionResult, EvalContext, Evaluation, Json
from evalcore.timing_contract import TimingResult


def _number(value: Json | None, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} должен быть числом")
    result = float(value)
    if not isfinite(result):
        raise ValueError(f"{name} должен быть конечным числом")
    return result


def configured_weights(settings: dict[str, Json]) -> dict[str, float]:
    """Прочитать неотрицательные веса семи критериев и заданных критериев комментария.

    Критерий комментария без веса в settings не считается (занятия до 28.09).
    """
    raw_weights = settings.get("weights")
    if not isinstance(raw_weights, dict):
        raise ValueError("settings.weights должен быть объектом")

    missing = [key for key in CRITERIA if key not in raw_weights]
    if missing:
        raise ValueError(f"Не заданы веса критериев: {', '.join(missing)}")

    weights: dict[str, float] = {}
    for key in (*CRITERIA, *(key for key in COMMENT_CRITERIA if key in raw_weights)):
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
    """Посчитать Σ(wᵢ·sᵢ)/Σwᵢ и применить critical_cap при критической ошибке."""
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
        if result.key not in CRITERIA and result.key not in COMMENT_CRITERIA:
            raise ValueError(f"Неизвестный критерий: {result.key}")
        if not isfinite(result.score) or not 0 <= result.score <= 1:
            raise ValueError(f"Балл {result.key} должен быть от 0 до 1")
        if not isfinite(result.weight) or result.weight < 0:
            raise ValueError(f"Вес {result.key} должен быть неотрицательным конечным числом")
        weighted_sum += result.weight * result.score
        weight_sum += result.weight
        if result.critical:
            critical_flags.append(result.key)

    if weight_sum == 0:
        raise ValueError("Сумма весов критериев должна быть больше нуля")

    total = weighted_sum / weight_sum
    if critical_flags:
        total = min(total, cap)
    return Evaluation(total=total, criteria=list(criteria), critical_flags=critical_flags)


def evaluate(ctx: EvalContext, *, timing: TimingResult | None = None) -> Evaluation:
    """Контракт T-006: Σ(wᵢ·sᵢ)/Σwᵢ; при critical — min(total, critical_cap).

    Критерии вызываются в порядке defaults.CRITERIA, затем критерии комментария с заданным
    весом (им нужен ctx.text_checker); веса всегда берутся из settings.
    При переданном TimingResult два временных критерия используют его версию и snapshot;
    отсутствие результата сохраняет прежнюю семантику для legacy-вызовов.
    """
    weights = configured_weights(ctx.settings)
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
        if result.weight != weights[key]:
            raise ValueError(
                f"Критерий {key} вернул вес {result.weight}, но в settings задано {weights[key]}"
            )
        results.append(result)
    for key in COMMENT_CRITERIA:
        if key not in weights:
            continue
        result = COMMENT_REGISTRY[key].evaluate(ctx)
        if result.key != key or result.weight != weights[key]:
            raise ValueError(f"Критерий {key} вернул чужой ключ или вес")
        results.append(result)

    raw_cap = ctx.settings.get("critical_cap")
    cap = _number(raw_cap, "settings.critical_cap")
    return aggregate(results, cap)
