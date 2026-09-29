"""Реестр детерминированных критериев оценки."""

import re
from datetime import datetime
from math import isfinite
from typing import cast

from evalcore.address import address_components_match, normalize_address_component
from evalcore.defaults import CRITERIA, REACTION_NORMATIVE_S
from evalcore.models import Criterion, CriterionResult, EvalContext, Json
from evalcore.timing_contract import TimingResult

REGISTRY: dict[str, Criterion] = {}

_TIMING_QUALITY_RU = {
    "verified": "подтверждённое",
    "estimated": "оценочное",
    "invalid": "некорректное",
    "legacy": "историческое",
}
_TIMING_SOURCE_RU = {
    "corrected_client": "скорректированные часы клиента",
    "server_fallback": "резервное время сервера",
    "legacy_client": "исторические часы клиента",
    "server": "время сервера",
}
_TIMING_ANOMALY_RU = {
    "missing_direct": "нет направления карточки",
    "missing_deliver": "нет доставки карточки",
    "missing_open": "нет открытия карточки",
    "missing_primary_status": "нет первичного решения",
    "missing_terminal": "нет завершения обработки",
    "non_monotonic": "нарушена хронология",
    "waiting_unavailable": "неизвестны интервалы ожидания",
    "untrusted_clock": "часы не подтверждены",
}
# Подписи статусов как в АРМ (apps/web/src/arm/cardModel.ts, STATE_LABELS).
_STATE_RU = {
    "added": "Добавлена",
    "received": "Получена службой",
    "accepted": "Принята",
    "rejected": "Не принята",
    "responding": "Начало реагирования",
    "arrived": "Прибытие",
    "working": "Проведение работ",
    "refused": "Отказ от выполнения работ",
    "completed": "Работы завершены",
    "redirected": "Перенаправлена",
}
# Подмножество _STATE_RU — только те, что обосновывает доклад бригады
# (PlannedMessage.justifies_state).
_REPORTED_STATE_RU = {
    key: _STATE_RU[key] for key in ("responding", "arrived", "working", "completed", "refused")
}
# Названия событий журнала (Card/Call) по-русски для пояснений критериев.
_EVENT_RU = {
    "deliver": "доставка",
    "open": "открытие",
}
# Названия полей карточки и адреса как их видит обучаемый (АРМ, памятка ДДС).
_FIELD_RU = {
    "service_number": "номер наряда",
    "comment": "комментарий",
    "city": "город",
    "street": "улица",
    "house": "дом",
    "building": "корпус",
    "apartment": "квартира",
}


def _join_states(states: list[str]) -> str:
    return " → ".join(_STATE_RU.get(state, state) for state in states) or "нет"


def _join_fields(fields: list[str]) -> str:
    return ", ".join(_FIELD_RU.get(field, field) for field in fields) or "нет"


def register(criterion: Criterion) -> None:
    """Зарегистрировать один из критериев T-006 по его уникальному ключу."""
    key = criterion.key
    if key not in CRITERIA:
        raise ValueError(f"Неизвестный критерий: {key}")
    if key in REGISTRY:
        raise ValueError(f"Критерий уже зарегистрирован: {key}")
    REGISTRY[key] = criterion


def registered_criteria() -> tuple[Criterion, ...]:
    """Вернуть зарегистрированные критерии в стабильном порядке из defaults.CRITERIA."""
    return tuple(REGISTRY[key] for key in CRITERIA if key in REGISTRY)


def _timestamp(value: Json | None, field: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"{field} должен быть строкой в формате date-time")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"Некорректное значение {field}: {value}") from error
    if parsed.tzinfo is None:
        raise ValueError(f"{field} должен содержать часовой пояс")
    return parsed


def _first_event_time(ctx: EvalContext, event_type: str) -> datetime | None:
    timestamps = [
        _timestamp(event.get("client_ts"), f"events[{index}].client_ts")
        for index, event in enumerate(ctx.events)
        if event.get("type") == event_type
    ]
    return min(timestamps, default=None)


def _ordered_events(ctx: EvalContext) -> list[dict[str, Json]]:
    return sorted(
        ctx.events,
        key=lambda event: _timestamp(event.get("client_ts"), "events[].client_ts"),
    )


def _reference(ctx: EvalContext) -> dict[str, Json]:
    reference = ctx.scenario.get("reference")
    if not isinstance(reference, dict):
        raise ValueError("scenario.reference должен быть объектом")
    return reference


def _string_list(value: Json | None, field: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"{field} должен быть массивом строк")
    return cast(list[str], value)


def _normalized(value: str) -> str:
    return " ".join(re.sub(r"[^0-9a-zа-я]+", " ", value.casefold().replace("ё", "е")).split())


def _longest_common_subsequence(left: list[str], right: list[str]) -> int:
    row = [0] * (len(right) + 1)
    for left_item in left:
        previous = 0
        for index, right_item in enumerate(right, start=1):
            saved = row[index]
            if left_item == right_item:
                row[index] = previous + 1
            else:
                row[index] = max(row[index], row[index - 1])
            previous = saved
    return row[-1]


def _setting_number(
    settings: dict[str, Json], key: str, default: int | float | None = None
) -> float:
    value = settings.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"settings.{key} должен быть числом")
    result = float(value)
    if not isfinite(result):
        raise ValueError(f"settings.{key} должен быть конечным числом")
    return result


def _criterion_weight(ctx: EvalContext, key: str) -> float:
    weights = ctx.settings.get("weights")
    if not isinstance(weights, dict) or key not in weights:
        raise ValueError(f"Не задан settings.weights.{key}")
    value = weights[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"settings.weights.{key} должен быть числом")
    weight = float(value)
    if not isfinite(weight) or weight < 0:
        raise ValueError(f"settings.weights.{key} должен быть неотрицательным конечным числом")
    return weight


def _time_score(duration_s: float, normative_s: float) -> float:
    """Вернуть 1 до норматива и линейно снизить балл до 0 за следующий норматив."""
    return 1.0 if duration_s <= normative_s else max(0.0, 2.0 - duration_s / normative_s)


def _timing_evidence(timing: TimingResult, measurement: str) -> list[str]:
    """Кратко объяснить версию, качество и основания общего расчёта I-TIME."""
    sources = sorted({_TIMING_SOURCE_RU[item.source] for item in timing.evidence})
    evidence = [
        (
            f"Методика I-TIME v{timing.timing_version}; "
            f"качество: {_TIMING_QUALITY_RU[timing.quality]}"
        ),
        f"Источники времени: {', '.join(sources) if sources else 'нет подтверждённых событий'}",
        measurement,
    ]
    if timing.anomalies:
        anomalies = [_TIMING_ANOMALY_RU[item] for item in timing.anomalies]
        evidence.append(f"Аномалии времени: {', '.join(anomalies)}")
    return evidence


class ReactionTimeCriterion:
    """Оценить реакцию I-TIME; без TimingResult сохранить legacy deliver → open.

    Формула: score = 1 при t <= N, иначе max(0, 2 - t/N), где N — норматив.
    """

    key = "reaction_time"

    def evaluate_timing(self, ctx: EvalContext, timing: TimingResult) -> CriterionResult:
        """Оценить рассчитанную I-TIME реакцию с нормативом из снимка занятия."""
        weight = _criterion_weight(ctx, self.key)
        duration = timing.reaction_s
        normative = timing.reaction_normative_s
        if normative <= 0 or not isfinite(normative):
            raise ValueError("timing.reaction_normative_s должен быть положительным числом")
        if duration is None:
            return CriterionResult(
                self.key,
                0.0,
                weight,
                False,
                _timing_evidence(timing, "Время реакции не определено"),
                "Время реакции невозможно подтвердить по общему расчёту I-TIME.",
            )

        score = _time_score(duration, normative)
        return CriterionResult(
            self.key,
            score,
            weight,
            False,
            _timing_evidence(timing, f"Реакция {duration:g} с при нормативе {normative:g} с"),
            (
                "Первичное решение принято в пределах норматива реакции."
                if score == 1
                else "Норматив реакции превышен; применён линейный штраф."
            ),
        )

    def evaluate(self, ctx: EvalContext) -> CriterionResult:
        """Вернуть балл реакции по client_ts событий deliver и open."""
        weight = _criterion_weight(ctx, self.key)
        normative = _setting_number(ctx.settings, "reaction_normative_s", REACTION_NORMATIVE_S)
        if normative <= 0:
            raise ValueError("settings.reaction_normative_s должен быть больше нуля")

        delivered_at = _first_event_time(ctx, "deliver")
        opened_at = _first_event_time(ctx, "open")
        if delivered_at is None or opened_at is None:
            missing = []
            if delivered_at is None:
                missing.append("deliver")
            if opened_at is None:
                missing.append("open")
            absent = ", ".join(_EVENT_RU.get(item, item) for item in missing)
            return CriterionResult(
                key=self.key,
                score=0.0,
                weight=weight,
                critical=False,
                evidence=[f"Отсутствуют события: {absent}"],
                explanation="Время реакции невозможно подтвердить по журналу событий.",
            )

        elapsed_s = (opened_at - delivered_at).total_seconds()
        if elapsed_s < 0:
            return CriterionResult(
                key=self.key,
                score=0.0,
                weight=weight,
                critical=False,
                evidence=[f"Открытие зафиксировано на {-elapsed_s:g} с раньше доставки"],
                explanation="Хронология событий некорректна, поэтому реакция не засчитана.",
            )

        score = _time_score(elapsed_s, normative)
        evidence = [f"Реакция {elapsed_s:g} с при нормативе {normative:g} с"]
        if score == 1:
            explanation = "Карточка открыта в пределах норматива реакции."
        elif score == 0:
            explanation = "Время реакции превысило двойной норматив."
        else:
            explanation = "Норматив реакции превышен; применён линейный штраф."
        return CriterionResult(
            key=self.key,
            score=score,
            weight=weight,
            critical=False,
            evidence=evidence,
            explanation=explanation,
        )


class HandlingTimeCriterion:
    """Оценить обработку I-TIME; без TimingResult сохранить прежний расчёт по событиям."""

    key = "handling_time"
    _terminal_states = frozenset({"completed", "refused", "rejected"})

    def evaluate_timing(self, ctx: EvalContext, timing: TimingResult) -> CriterionResult:
        """Оценить v3 по активной обработке, а legacy/v2 — по полной длительности."""
        weight = _criterion_weight(ctx, self.key)
        normative = timing.handling_normative_s
        if normative <= 0 or not isfinite(normative):
            raise ValueError("timing.handling_normative_s должен быть положительным числом")
        duration = timing.active_handling_s if timing.timing_version == 3 else timing.handling_s
        measurement_name = "Активная обработка" if timing.timing_version == 3 else "Обработка"
        if duration is None:
            return CriterionResult(
                self.key,
                0.0,
                weight,
                False,
                _timing_evidence(timing, f"{measurement_name} не определена"),
                "Время обработки невозможно подтвердить по общему расчёту I-TIME.",
            )

        score = _time_score(duration, normative)
        return CriterionResult(
            self.key,
            score,
            weight,
            False,
            _timing_evidence(
                timing, f"{measurement_name} {duration:g} с при нормативе {normative:g} с"
            ),
            (
                "Карточка обработана в пределах норматива."
                if score == 1
                else "Норматив обработки превышен; применён линейный штраф."
            ),
        )

    def evaluate(self, ctx: EvalContext) -> CriterionResult:
        """Вернуть линейный балл времени обработки карточки."""
        weight = _criterion_weight(ctx, self.key)
        normative = _setting_number(ctx.settings, "handling_normative_s", 180)
        if normative <= 0:
            raise ValueError("settings.handling_normative_s должен быть больше нуля")

        opened_at = _first_event_time(ctx, "open")
        terminal_at = None
        for event in _ordered_events(ctx):
            payload = event.get("payload")
            state = payload.get("state") if isinstance(payload, dict) else None
            if event.get("type") == "redirect" or state in self._terminal_states:
                terminal_at = _timestamp(event.get("client_ts"), "terminal_event.client_ts")
                break

        if opened_at is None or terminal_at is None:
            return CriterionResult(
                self.key,
                0.0,
                weight,
                False,
                ["Не найдены открытие карточки и/или терминальное действие"],
                "Время обработки невозможно подтвердить по журналу событий.",
            )
        elapsed_s = (terminal_at - opened_at).total_seconds()
        if elapsed_s < 0:
            score = 0.0
            explanation = "Терминальное действие предшествует открытию карточки."
        else:
            score = _time_score(elapsed_s, normative)
            explanation = (
                "Карточка обработана в пределах норматива."
                if score == 1
                else "Норматив обработки превышен; применён линейный штраф."
            )
        return CriterionResult(
            self.key,
            score,
            weight,
            False,
            [f"Обработка {elapsed_s:g} с при нормативе {normative:g} с"],
            explanation,
        )


class StatusFlowCriterion:
    """Сравнить фактический поток статусов с эталоном через LCS."""

    key = "status_flow"

    def evaluate(self, ctx: EvalContext) -> CriterionResult:
        """Вернуть LCS(expected, actual) / max(len(expected), len(actual))."""
        weight = _criterion_weight(ctx, self.key)
        expected = _string_list(_reference(ctx).get("expected_flow"), "reference.expected_flow")
        expected = [state for state in expected if state != "added"]
        actual: list[str] = []
        scored_actual: list[str] = []
        reports: dict[str, list[datetime]] = {}
        required_by_report: set[str] = set()
        for planned in ctx.planned_messages:
            state = planned.get("justifies_state")
            if not isinstance(state, str):
                continue
            required_by_report.add(state)
            if planned.get("presented_at") is not None:
                reports.setdefault(state, []).append(
                    _timestamp(planned["presented_at"], "planned_messages[].presented_at")
                )
        premature: set[str] = set()
        # Очерёдность решения и доклада определяет сервер, а не часы браузера.
        for event in sorted(
            ctx.events,
            key=lambda item: _timestamp(
                item.get("server_ts") or item.get("client_ts"), "events[].server_ts"
            ),
        ):
            event_type = event.get("type")
            payload = event.get("payload")
            if event_type == "deliver":
                actual.append("received")
                scored_actual.append("received")
            elif event_type == "redirect":
                actual.append("redirected")
                scored_actual.append("redirected")
            elif event_type == "status_change" and isinstance(payload, dict):
                state = payload.get("state")
                if isinstance(state, str):
                    actual.append(state)
                    at = _timestamp(
                        event.get("server_ts") or event.get("client_ts"),
                        "events[].server_ts",
                    )
                    if state in required_by_report and not any(
                        presented <= at for presented in reports.get(state, [])
                    ):
                        premature.add(state)
                        scored_actual.append(f"before_report:{state}")
                    else:
                        scored_actual.append(state)

        # Статус, чей доклад обучаемому не предъявили, не требуется и не снижает балл.
        unpresented = _unpresented_states(ctx) & set(expected)
        if unpresented:
            expected = [state for state in expected if state not in unpresented]
        denominator = max(len(expected), len(scored_actual))
        score = (
            1.0
            if denominator == 0
            else _longest_common_subsequence(expected, scored_actual) / denominator
        )
        return CriterionResult(
            self.key,
            score,
            weight,
            bool(premature),
            [
                f"Эталон: {_join_states(expected)}",
                f"Факт: {_join_states(actual)}",
                *(
                    [f"Преждевременные статусы: {_join_states(sorted(premature))}"]
                    if premature
                    else []
                ),
            ],
            (
                "Последовательность статусов соответствует эталону."
                if score == 1
                else _flow_mismatch(expected, actual)
            )
            + _unpresented_note(unpresented - set(actual))
            + (" Статус поставлен до подтверждённого доклада бригады." if premature else ""),
        )


def _flow_mismatch(expected: list[str], actual: list[str]) -> str:
    """Что именно не так со статусами: чего не хватает, что лишнее, чем закрыть карточку."""
    missing = [state for state in expected if state not in actual]
    extra = [state for state in actual if state not in expected and state != "added"]
    parts = []
    if missing:
        parts.append(f"Не хватает: {_join_states(missing)}.")
    if extra:
        parts.append(f"Лишние: {_join_states(extra)}.")
    if not parts:
        parts.append("Статусы поставлены не в том порядке.")
    # Работ на месте не было — карточку закрывает отказ, а не «Работы завершены».
    if expected and expected[-1] == "refused" and "completed" in actual:
        parts.append(
            "Бригада доложила, что работы на месте не проводились: по памятке ДДС (стр. 22) "
            "такую карточку закрывают «Отказ от выполнения работ» с причиной в комментарии."
        )
    return " ".join(parts)


def _unpresented_states(ctx: EvalContext) -> set[str]:
    """Статусы, которые обосновывают только непредъявленные доклады плана."""
    justified: dict[str, bool] = {}
    for message in ctx.planned_messages:
        state = message.get("justifies_state")
        if isinstance(state, str):
            presented = message.get("presented_at") is not None
            justified[state] = justified.get(state, False) or presented
    return {state for state, presented in justified.items() if not presented}


def _unpresented_note(states: set[str]) -> str:
    if not states:
        return ""
    labels = ", ".join(
        f"«{_REPORTED_STATE_RU.get(state, state)}»"
        for state in _REPORTED_STATE_RU
        if state in states
    )
    return (
        f" Не потребовались статусы {labels}: доклады бригады о них не были предъявлены обучаемому."
        if len(states) > 1
        else f" Не потребовался статус {labels}: доклад бригады о нём не был предъявлен обучаемому."
    )


class RoutingCriterion:
    """Проверить принятое решение и адресата перенаправления по эталону сценария."""

    key = "routing"
    _decisions = frozenset({"accepted", "rejected", "redirected"})

    def evaluate(self, ctx: EvalContext) -> CriterionResult:
        """Вернуть 1 за эталонное решение, иначе критический 0."""
        weight = _criterion_weight(ctx, self.key)
        reference = _reference(ctx)
        expected_flow = _string_list(reference.get("expected_flow"), "reference.expected_flow")
        expected_decisions = [state for state in expected_flow if state in self._decisions]
        expected_decision = expected_decisions[-1] if expected_decisions else None
        if expected_decision is None:
            raise ValueError("reference.expected_flow не содержит решения по маршрутизации")
        expected_services = _string_list(
            reference.get("expected_service_ids"), "reference.expected_service_ids"
        )

        actual_decision = None
        redirected_service = None
        actual_decisions = []
        for event in _ordered_events(ctx):
            payload = event.get("payload")
            if event.get("type") == "redirect":
                actual_decision = "redirected"
                actual_decisions.append(actual_decision)
                redirected_service = (
                    payload.get("service_id") if isinstance(payload, dict) else None
                )
            if event.get("type") == "status_change" and isinstance(payload, dict):
                state = payload.get("state")
                if isinstance(state, str) and state in {"accepted", "rejected"}:
                    actual_decision = state
                    actual_decisions.append(state)

        # Исправленный первичный отказ не меняет конечную маршрутизацию в принятом сценарии.
        corrected_acceptance = expected_decisions == ["accepted"] and actual_decisions == [
            "rejected",
            "accepted",
        ]
        correct = actual_decisions == expected_decisions or corrected_acceptance
        if correct and expected_decision == "redirected":
            correct = redirected_service in expected_services
        evidence = [
            f"Ожидались решения: {_join_states(expected_decisions)}; "
            f"получены: {_join_states(actual_decisions)}"
        ]
        if expected_decision == "redirected" or actual_decision == "redirected":
            evidence.append(
                f"Допустимые адресаты: {', '.join(expected_services) or 'нет'}; "
                f"адресат перенаправления: {redirected_service or 'нет'}"
            )
        return CriterionResult(
            self.key,
            1.0 if correct else 0.0,
            weight,
            not correct,
            evidence,
            (
                "Маршрутизация соответствует эталону."
                if correct
                else "Карточка маршрутизирована неверно."
            ),
        )


class RequiredFieldsCriterion:
    """Оценить долю заполненных обязательных редактируемых полей."""

    key = "required_fields"

    def evaluate(self, ctx: EvalContext) -> CriterionResult:
        """Вернуть filled / required; пробельная строка считается пустой."""
        weight = _criterion_weight(ctx, self.key)
        required = _string_list(_reference(ctx).get("required_fields"), "reference.required_fields")
        missing = [
            field
            for field in required
            if not isinstance(ctx.current.get(field), str) or not str(ctx.current[field]).strip()
        ]
        score = 1.0 if not required else (len(required) - len(missing)) / len(required)
        return CriterionResult(
            self.key,
            score,
            weight,
            False,
            [f"Заполнено {len(required) - len(missing)} из {len(required)} обязательных полей"],
            (
                "Все обязательные поля заполнены."
                if not missing
                else f"Не заполнены поля: {_join_fields(missing)}."
            ),
        )


class AddressCriterion:
    """Проверить ручной структурированный адрес, сохранив fallback старых карточек."""

    key = "address"

    # Тип улицы между названием и номером дома: «Дубнинская улица, 1», «Мира пр 5».
    _STREET_TYPE = r"(?:улица|ул|проспект|пр|переулок|пер|шоссе|ш|бульвар|набережная|наб|проезд)"

    @classmethod
    def _component_present(cls, field: str, value: str, comment: str, street: str = "") -> bool:
        normalized = _normalized(value)
        if field == "street":
            # «ул.» и «улица» не отличают улицу (address.py); похожая другая улица —
            # другое слово целиком: «Дубнинская» ≠ «Дубининская».
            core = normalize_address_component("street", value)
            return bool(core) and bool(
                re.search(rf"(?<![0-9a-zа-я]){re.escape(core)}(?![0-9a-zа-я])", comment)
            )
        if field == "house":
            number = re.escape(normalized)
            if re.search(rf"\b(?:дом|д)\s*{number}\b", comment):
                return True
            # 29.09: номер сразу за улицей — обычная запись адреса («Дубнинская улица, 1»).
            core = normalize_address_component("street", street)
            return bool(core) and bool(
                re.search(rf"{re.escape(core)}(?:\s+{cls._STREET_TYPE})?\s+{number}\b", comment)
            )
        if field == "building":
            return bool(re.search(rf"\b(?:корпус|корп|к)\s*{re.escape(normalized)}\b", comment))
        if field == "apartment":
            return bool(re.search(rf"\b(?:квартира|кв)\s*{re.escape(normalized)}\b", comment))
        return normalized in comment

    def evaluate(self, ctx: EvalContext) -> CriterionResult:
        """Вернуть долю совпавших компонентов ручного или legacy-адреса."""
        weight = _criterion_weight(ctx, self.key)
        address = _reference(ctx).get("expected_address")
        if not isinstance(address, dict):
            raise ValueError("reference.expected_address должен быть объектом")
        manual = ctx.current.get("address")
        if isinstance(manual, dict):
            return self._evaluate_manual(weight, address, manual)

        raw_comment = ctx.current.get("comment")
        comment = _normalized(raw_comment) if isinstance(raw_comment, str) else ""
        checked = {
            field: value
            for field in ("city", "street", "house", "building", "apartment")
            if isinstance((value := address.get(field)), str) and value.strip()
        }
        missing = [
            field
            for field, value in checked.items()
            if not self._component_present(field, value, comment, checked.get("street", ""))
        ]
        score = 1.0 if not checked else (len(checked) - len(missing)) / len(checked)
        critical = "street" in missing or "house" in missing
        return CriterionResult(
            self.key,
            score,
            weight,
            critical,
            [f"Найдено {len(checked) - len(missing)} из {len(checked)} компонентов адреса"],
            (
                "Адрес в комментарии соответствует эталону."
                if not missing
                else f"Не подтверждены компоненты адреса: {_join_fields(missing)}."
            ),
        )

    def _evaluate_manual(
        self, weight: float, expected: dict[str, Json], actual: dict[str, Json]
    ) -> CriterionResult:
        """Сравнить введённые поля с эталоном без нечёткого совпадения улиц."""
        fields = ("city", "street", "house", "building", "apartment")
        checked: list[str] = []
        missing: list[str] = []
        evidence = ["Проверен ручной адрес из полей ручного ввода"]
        for field in fields:
            expected_value = expected.get(field)
            actual_value = actual.get(field)
            if not isinstance(expected_value, str):
                raise ValueError(f"reference.expected_address.{field} должен быть строкой")
            if not isinstance(actual_value, str):
                raise ValueError(f"current.address.{field} должен быть строкой")
            if not expected_value.strip() and not actual_value.strip():
                continue
            checked.append(field)
            if not address_components_match(field, expected_value, actual_value):
                missing.append(field)

        score = 1.0 if not checked else (len(checked) - len(missing)) / len(checked)
        critical = "street" in missing or "house" in missing
        evidence.append(f"Совпало {len(checked) - len(missing)} из {len(checked)} компонентов")
        if missing:
            evidence.append(f"Не совпали: {_join_fields(missing)}")
        return CriterionResult(
            self.key,
            score,
            weight,
            critical,
            evidence,
            (
                "Ручной адрес соответствует эталону."
                if not missing
                else f"Ошибки ручного адреса в полях: {_join_fields(missing)}."
            ),
        )


class CallCriterion:
    """Проверить факт, адресата и своевременность обязательного звонка."""

    key = "call"

    def evaluate(self, ctx: EvalContext) -> CriterionResult:
        """Вернуть лучший средний балл за соединение, адресата и время звонка."""
        weight = _criterion_weight(ctx, self.key)
        expected = _reference(ctx).get("expected_call")
        if not isinstance(expected, dict):
            raise ValueError("reference.expected_call должен быть объектом")
        required = expected.get("required")
        if not isinstance(required, bool):
            raise ValueError("reference.expected_call.required должен быть boolean")
        if not required:
            return CriterionResult(
                self.key,
                1.0,
                weight,
                False,
                ["Обязательный звонок не предусмотрен эталоном"],
                "Требований к звонку в этом сценарии нет.",
            )

        service_id = expected.get("service_id")
        phone_ext = expected.get("phone_ext")
        before_s = expected.get("before_s")
        if not isinstance(service_id, str) or not isinstance(phone_ext, str):
            raise ValueError("service_id и phone_ext ожидаемого звонка должны быть строками")
        if isinstance(before_s, bool) or not isinstance(before_s, (int, float)) or before_s <= 0:
            raise ValueError("reference.expected_call.before_s должен быть положительным числом")

        delivered_at = _first_event_time(ctx, "deliver")
        candidates: list[tuple[float, list[str], bool]] = []
        refused_calls = 0
        for call in ctx.calls:
            # Обязательный звонок делает диспетчер; входящий вызов бригады — не он.
            if call.get("direction") == "inbound":
                continue
            answered = isinstance(call.get("answered_at"), str)
            service_correct = call.get("service_id") == service_id
            phone_correct = call.get("phone_ext") == phone_ext
            # Бригада не была направлена на происшествие и ответила отказом: информацию
            # никто не принял, поэтому такой звонок обязательным не считается. Отдельного
            # штрафа нет — потерянное время и так учтено, а балл берётся по лучшему звонку.
            refused = call.get("refusal") is not None
            refused_calls += int(refused)
            # Прямой номер направленной бригады той же службы — тоже служба: так учит
            # тренировка («позвоните бригаде по её прямому номеру»), и это не ошибка адресата.
            brigade_of_service = (
                service_correct and call.get("brigade_id") is not None and not refused
            )
            addressee_correct = service_correct and (phone_correct or brigade_of_service)
            started_at_raw = call.get("started_at")
            delay_s = None
            time_score = 0.0
            if delivered_at is not None and isinstance(started_at_raw, str):
                started_at = _timestamp(started_at_raw, "calls[].started_at")
                delay_s = (started_at - delivered_at).total_seconds()
                if delay_s >= 0:
                    time_score = (
                        1.0
                        if delay_s <= float(before_s)
                        else max(0.0, 2.0 - delay_s / float(before_s))
                    )
            score = (float(answered) + float(addressee_correct) + time_score) / 3
            evidence = [
                f"Звонок отвечен: {'да' if answered else 'нет'}",
                (
                    f"Адресат {call.get('service_id')}/{call.get('phone_ext')}"
                    f"{' (бригада службы)' if brigade_of_service else ''}"
                    f"{' (бригада не направлена на происшествие)' if refused else ''}: "
                    f"{'верно' if addressee_correct else 'неверно'}"
                ),
                (
                    f"Начало через {delay_s:g} с при нормативе {before_s:g} с; "
                    f"временной балл {time_score:.2f}"
                    if delay_s is not None
                    else "Время начала звонка невозможно определить"
                ),
            ]
            successful_contact = answered and addressee_correct
            candidates.append((score, evidence, successful_contact))

        if not candidates:
            return CriterionResult(
                self.key,
                0.0,
                weight,
                True,
                ["Обязательный звонок отсутствует"],
                "Обязательный звонок не выполнен.",
            )
        score, evidence, successful_contact = max(
            candidates, key=lambda candidate: (candidate[0], candidate[2])
        )
        if refused_calls:
            # Только сведение для преподавателя: на балл не влияет.
            evidence = [
                *evidence,
                f"Звонков бригадам, не направленным на происшествие: {refused_calls} "
                "(бригада отказала, доклада не было)",
            ]
        return CriterionResult(
            self.key,
            score,
            weight,
            not successful_contact,
            evidence,
            "Звонок соответствует эталону." if score == 1 else "Звонок выполнен с нарушениями.",
        )


register(ReactionTimeCriterion())
register(HandlingTimeCriterion())
register(StatusFlowCriterion())
register(RoutingCriterion())
register(RequiredFieldsCriterion())
register(AddressCriterion())
register(CallCriterion())
