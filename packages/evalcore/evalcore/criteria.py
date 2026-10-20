"""Реестр детерминированных критериев оценки."""

import re
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from datetime import datetime
from math import isfinite
from typing import cast
from uuid import UUID

from evalcore import remarks
from evalcore.address import (
    address_components_match,
    normalize_address_component,
    normalize_text,
    other_street,
    similar_street,
    street_words,
)
from evalcore.defaults import (
    CARD_REPORT_EXT,
    CARD_TERMINAL_STATES,
    CLICKTHROUGH_S,
    CRITERIA,
    NO_REFUSAL_SERVICES,
    REACTION_NORMATIVE_S,
    REPORT_CHOICE_FACTOR,
    phone_contacts,
)
from evalcore.loudness import LOUDNESS_TEXT
from evalcore.models import Criterion, CriterionResult, EvalContext, Json, Remark
from evalcore.remarks import STATE_LABELS as _STATE_RU
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
# Подмножество _STATE_RU — только те, что обосновывает доклад бригады
# (PlannedMessage.justifies_state).
_REPORTED_STATE_RU = {
    key: _STATE_RU[key] for key in ("responding", "arrived", "working", "completed", "refused")
}
# О каком этапе докладывает бригада, обосновывая статус (PlannedMessage.justifies_state).
_REPORT_RU = {
    "responding": "о выезде",
    "arrived": "о прибытии",
    "working": "о проведении работ",
    "completed": "о завершении работ",
    "refused": "о том, что работы не проводились",
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
    """Перед сверкой: регистр, «ё», латинские двойники, пунктуация (address.normalize_text)."""
    return normalize_text(value)


def _all_comments(ctx: EvalContext) -> str:
    """Все комментарии диспетчера по карточке: каждый статус затирает текущий комментарий,
    а ключевые сведения обычно пишут при «Принята» — их нельзя терять к «Работы завершены»."""
    texts: list[str] = []
    for event in ctx.events:
        payload = event.get("payload")
        if event.get("type") in ("status_change", "redirect", "comment") and isinstance(
            payload, dict
        ):
            text = payload.get("comment")
            if isinstance(text, str) and text.strip() and text not in texts:
                texts.append(text)
    current = ctx.current.get("comment")
    if isinstance(current, str) and current.strip() and current not in texts:
        texts.append(current)
    return "\n".join(texts)


_ADDRESS_COMPONENTS = ("city", "street", "house", "building", "apartment")


def address_clarified(ctx: EvalContext) -> bool:
    """Эталонный адрес отличается от адреса в карточке: адрес уточнили по ходу работы.

    DT-14 (08.10): диспетчер ДДС адрес не вводит. Верный адрес карточки он в комментарии может
    не повторять; уточнённый (бригада доложила другой, осложнение `wrong_address`) — обязан.
    Карточка без адреса (старые фикстуры) считается уточнённой: адрес ищется, как раньше.
    """
    expected = _reference(ctx).get("expected_address")
    card = ctx.scenario.get("card")
    shown = card.get("address") if isinstance(card, dict) else None
    if not isinstance(expected, dict) or not isinstance(shown, dict):
        return True
    for field in _ADDRESS_COMPONENTS:
        want, have = expected.get(field, ""), shown.get(field, "")
        if not isinstance(want, str) or not isinstance(have, str):
            return True
        if not address_components_match(field, want, have):
            return True
    return False


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
                (_unconfirmed_reaction(normative),),
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
            ()
            if score == 1
            else (
                remarks.late_reaction(
                    f"Первичный статус поставлен через {round(duration)} с при нормативе "
                    f"{round(normative)} с.",
                    normative,
                ),
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
                remarks=(_unconfirmed_reaction(normative),),
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
                remarks=(_unconfirmed_reaction(normative),),
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
            remarks=()
            if score == 1
            else (
                remarks.late_reaction(
                    f"Карточка открыта через {round(elapsed_s)} с при нормативе "
                    f"{round(normative)} с.",
                    normative,
                ),
            ),
        )


def _early_closure(ctx: EvalContext) -> bool:
    """Обучаемый завершил карточку, пропустив требуемые эталоном этапы.

    Используем серверный порядок и действующий эталон (после смены задачи).
    Незавершённая попытка не лишается защиты от непредъявленных докладов.
    """
    actual: list[str] = []
    for event in sorted(
        ctx.events,
        key=lambda item: _timestamp(
            item.get("server_ts") or item.get("client_ts"), "events[].server_ts"
        ),
    ):
        payload = event.get("payload")
        if event.get("type") == "redirect":
            actual.append("redirected")
        elif event.get("type") == "status_change" and isinstance(payload, dict):
            state = payload.get("state")
            if isinstance(state, str):
                actual.append(state)
    if not actual or actual[-1] not in CARD_TERMINAL_STATES:
        return False
    expected = _string_list(_reference(ctx).get("expected_flow"), "reference.expected_flow")
    planned_states = {
        state
        for item in ctx.planned_messages
        if isinstance(state := item.get("justifies_state"), str)
    }
    unreported = (
        (set(expected) & set(_REPORTED_STATE_RU)) - planned_states if planned_states else set()
    )
    required = [state for state in expected if state not in {"added", "received"} | unreported]
    return bool(expected) and (
        actual[-1] != expected[-1] or _longest_common_subsequence(required, actual) < len(required)
    )


def _unscored_early_handling() -> CriterionResult:
    return CriterionResult(
        "handling_time",
        0.0,
        0.0,
        False,
        ["Карточка закрыта досрочно: требуемые этапы не выполнены"],
        "Время обработки не оценивается: быстрое досрочное закрытие "
        "не означает выполнение задания.",
    )


class HandlingTimeCriterion:
    """Оценить обработку I-TIME; без TimingResult сохранить прежний расчёт по событиям."""

    key = "handling_time"
    _terminal_states = frozenset({"completed", "refused", "rejected"})

    def evaluate_timing(self, ctx: EvalContext, timing: TimingResult) -> CriterionResult:
        """Оценить v3 по активной обработке, а legacy/v2 — по полной длительности."""
        weight = _criterion_weight(ctx, self.key)
        if _early_closure(ctx):
            return _unscored_early_handling()
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
                (_unconfirmed_handling(),),
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
            () if score == 1 else (_slow_handling(duration, normative),),
        )

    def evaluate(self, ctx: EvalContext) -> CriterionResult:
        """Вернуть линейный балл времени обработки карточки."""
        weight = _criterion_weight(ctx, self.key)
        if _early_closure(ctx):
            return _unscored_early_handling()
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
                (_unconfirmed_handling(),),
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
            ()
            if score == 1
            else (
                _slow_handling(elapsed_s, normative) if elapsed_s >= 0 else _unconfirmed_handling(),
            ),
        )


def _slow_handling(duration_s: float, normative_s: float) -> Remark:
    return remarks.slow_handling(
        f"Карточка обработана за {round(duration_s)} с при нормативе {round(normative_s)} с."
    )


def _unconfirmed_handling() -> Remark:
    return remarks.slow_handling("Время обработки не подтверждено: в журнале нет нужных событий.")


def _unconfirmed_reaction(normative_s: float) -> Remark:
    return remarks.late_reaction(
        "Время первичного статуса не подтверждено: в журнале нет нужных событий.", normative_s
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
        # Вопрос к данным (TC-10): у плана есть связи доклад → статус, а эталон ждёт статус хода
        # работ, о котором доклада нет. По памятке (с. 22) без доклада статус не ставится —
        # обучаемому это не вменяется: статус не требуется и не считается лишним.
        unreported = (
            {state for state in expected if state in _REPORTED_STATE_RU} - required_by_report
            if required_by_report
            else set()
        )
        # И наоборот: доклад плана обосновывает статус, которого эталон не ждёт. Обучаемый,
        # поставивший его по докладу, действовал по памятке — статус не считается лишним.
        unexpected = {
            state
            for state in required_by_report
            if state in _REPORTED_STATE_RU and state not in expected
        }
        followed: set[str] = set()
        premature: set[str] = set()
        # Статус без доклада, который сервер не принял (GP-26): в разборе, но не в факте.
        denied: list[str] = []
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
            elif event_type == "status_denied" and isinstance(payload, dict):
                state = payload.get("state")
                if isinstance(state, str) and state not in denied:
                    denied.append(state)
            elif event_type == "status_change" and isinstance(payload, dict):
                state = payload.get("state")
                if isinstance(state, str):
                    actual.append(state)
                    if state in unreported:
                        continue
                    at = _timestamp(
                        event.get("server_ts") or event.get("client_ts"),
                        "events[].server_ts",
                    )
                    reported = any(presented <= at for presented in reports.get(state, []))
                    if state in required_by_report and not reported:
                        premature.add(state)
                        scored_actual.append(f"before_report:{state}")
                    elif state in unexpected:
                        followed.add(state)
                    else:
                        scored_actual.append(state)

        # Статус, чей доклад обучаемому не предъявили, не требуется и не снижает балл.
        unpresented = _unpresented_states(ctx) & set(expected)
        if unpresented or unreported:
            expected = [
                state for state in expected if state not in unpresented and state not in unreported
            ]
        denominator = max(len(expected), len(scored_actual))
        score = (
            1.0
            if denominator == 0
            else _longest_common_subsequence(expected, scored_actual) / denominator
        )
        checked = [state for state in actual if state not in unreported and state not in followed]
        found = _flow_remarks(expected, checked, sorted(premature, key=_flow_order), score)
        if unreported:
            found.append(remarks.report_missing_from_plan(sorted(unreported, key=_flow_order)))
        if followed:
            found.append(remarks.status_missing_from_reference(sorted(followed, key=_flow_order)))
        fast = _clickthrough(ctx)
        if fast:
            found.append(remarks.clickthrough(fast, CLICKTHROUGH_S))
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
                *(f"Не принят сервером: {_denied_text(state)}" for state in denied),
            ],
            (
                "Последовательность статусов соответствует эталону."
                if score == 1
                else _flow_mismatch(expected, actual, ctx.scenario.get("target_service_id"))
            )
            + _unpresented_note(unpresented - set(actual))
            + (" Статус поставлен до подтверждённого доклада бригады." if premature else "")
            + (
                " Статус без доклада сервер не принял: "
                + "; ".join(_denied_text(state) for state in denied)
                + "."
                if denied
                else ""
            ),
            tuple(found),
        )


def _flow_order(state: str) -> int:
    order = list(_STATE_RU)
    return order.index(state) if state in order else len(order)


def _flow_remarks(
    expected: list[str], actual: list[str], premature: list[str], score: float
) -> list[Remark]:
    """Замечания по статусам: раньше доклада, пропущенные, лишние, не по порядку."""
    found: list[Remark] = []
    if premature:
        found.append(remarks.premature_status(premature))
    if score >= 1:
        return found
    missing = [state for state in expected if state not in actual]
    extra = [state for state in actual if state not in expected and state != "added"]
    for state in missing:
        if state == "refused" and "completed" in extra:
            # Работ не было, а карточку закрыли «Работы завершены» (памятка, с. 22).
            found.append(remarks.completed_instead_of_refused())
            extra.remove("completed")
        else:
            found.append(remarks.missing_status(state))
    if "rejected" in extra and "accepted" in expected and "accepted" in actual:
        # «Не принята», потом «Принята» — исправленная ошибка (памятка, с. 32).
        found.append(remarks.corrected_rejection())
        extra.remove("rejected")
    if extra:
        found.append(remarks.extra_status(list(dict.fromkeys(extra))))
    if not found:
        found.append(remarks.wrong_order())
    return found


def _clickthrough(ctx: EvalContext) -> str | None:
    """Первый статус быстрее CLICKTHROUGH_S после открытия карточки или прошлого статуса.

    Время — по часам браузера (`client_ts`): очередь событий может уйти на сервер пачкой, а
    промежутки между действиями одного обучаемого на одних часах достоверны. Открытие
    считается только первое: вернуться к уже прочитанной карточке и сразу поставить статус —
    не прокликивание. Нет — None.
    """
    previous: tuple[str, datetime] | None = None
    for event in _ordered_events(ctx):
        payload = event.get("payload")
        at = _timestamp(event.get("client_ts"), "events[].client_ts")
        if event.get("type") == "open" and previous is None:
            previous = ("открытия карточки", at)
            continue
        if event.get("type") != "status_change" or not isinstance(payload, dict):
            continue
        state = payload.get("state")
        if not isinstance(state, str):
            continue
        if previous is not None:
            gap = (at - previous[1]).total_seconds()
            if 0 <= gap < CLICKTHROUGH_S:
                return f"{remarks.label(state)} — через {round(gap)} с после {previous[0]}"
        previous = (remarks.label(state), at)
    return None


def _denied_text(state: str) -> str:
    """«Прибытие» — не было доклада бригады о прибытии: какой статус и какого доклада не было."""
    report = _REPORT_RU.get(state)
    label = f"«{_STATE_RU.get(state, state)}»"
    return f"{label} — не было доклада бригады {report}" if report else label


def _flow_mismatch(expected: list[str], actual: list[str], service_id: object = None) -> str:
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
    if service_id in NO_REFUSAL_SERVICES and {"rejected", "refused"} & set(actual):
        parts.append(
            f"Служба {service_id} не ставит «Не принята» и «Отказ от выполнения работ»: по памятке "
            "ДДС (стр. 23) вместо них — «Работы завершены: завершение работ без бригады» с "
            "причиной в комментарии."
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
        reason: str | None = None
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
                    comment = payload.get("comment")
                    if state == "rejected" and reason is None and isinstance(comment, str):
                        reason = comment

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
            ()
            if correct
            else (_routing_remark(expected_decision, actual_decision, actual_decisions, reason),),
        )


def _routing_remark(
    expected: str, actual: str | None, decisions: list[str], reason: str | None
) -> Remark:
    """Что не так с решением: своя не принята, чужая принята, не та служба, решения нет."""
    if expected == "accepted" and "rejected" in decisions:
        return remarks.own_card_rejected(remarks.excerpt(reason) if reason else None)
    if expected in {"rejected", "redirected"} and actual == "accepted":
        return remarks.foreign_card_accepted()
    if expected == "redirected" and actual == "redirected":
        return remarks.wrong_redirect()
    return remarks.no_decision()


class RequiredFieldsCriterion:
    """Оценить долю верно заполненных обязательных редактируемых полей."""

    key = "required_fields"

    def evaluate(self, ctx: EvalContext) -> CriterionResult:
        """Вернуть верно заполненные / обязательные; пробельная строка считается пустой.

        «Номер наряда» — прямой номер бригады, направленной на карточку («Старший бригады ·
        201», справка АРМ): сверяется по цифрам с любым из `ctx.brigade_numbers`
        (`service_number_problem`). Неверный номер — как незаполненное поле.
        """
        weight = _criterion_weight(ctx, self.key)
        required = _string_list(_reference(ctx).get("required_fields"), "reference.required_fields")
        found = [
            (field, problem)
            for field in required
            if (problem := _field_problem(field, ctx.current.get(field), ctx.brigade_numbers))
        ]
        problems = [problem for _, problem in found]
        correct = len(required) - len(problems)
        score = 1.0 if not required else correct / len(required)
        return CriterionResult(
            self.key,
            score,
            weight,
            False,
            [*problems, f"Заполнено {correct} из {len(required)} обязательных полей"],
            (
                "Все обязательные поля заполнены."
                if not problems
                else " ".join(f"{problem}." for problem in problems)
            ),
            tuple(
                remarks.empty_field(field)
                if _is_empty(ctx.current.get(field))
                else remarks.wrong_service_number(problem)
                for field, problem in found
            ),
        )


def _is_empty(value: Json) -> bool:
    return not isinstance(value, str) or not value.strip()


def _field_problem(field: str, value: Json, brigade_numbers: tuple[str, ...]) -> str | None:
    """Что не так с обязательным полем: не заполнено или номер наряда не той бригады."""
    if _is_empty(value) or not isinstance(value, str):
        if field in {"service_number", "comment"}:
            return f"Не заполнен {_FIELD_RU[field]}"
        return f"Не заполнено поле: {_join_fields([field])}"
    if field == "service_number":
        return service_number_problem(value, brigade_numbers)
    return None


def service_number_problem(value: str, brigade_numbers: tuple[str, ...]) -> str | None:
    """Номер наряда сверяется по цифрам: «№ 201», «бригада 2 0 1» и «201, 203» — верно.

    Совпасть должна вся цифровая часть с номером одной из бригад карточки или каждое
    число отдельно (две бригады через запятую). Без бригад сверять не с чем — None.
    """
    numbers = {re.sub(r"\D", "", item) for item in brigade_numbers} - {""}
    if not numbers:
        return None
    groups = re.findall(r"\d+", value)
    if "".join(groups) in numbers or (groups and all(group in numbers for group in groups)):
        return None
    word = "номером бригады" if len(numbers) == 1 else "номерами бригад"
    return f"Номер наряда {value.strip()} не совпадает с {word}: {', '.join(sorted(numbers))}"


def wrong_briefings(ctx: EvalContext) -> list[str]:
    """Адреса, по которым бригады уехали не туда (GP-05): первая полная вводная бригаде.

    Бригада едет по первой полной вводной (`evalcore.briefing`); её адрес `wrong` —
    критическая ошибка адреса, как искажённая улица или дом в комментарии.
    """
    dispatched: dict[str, dict[str, Json]] = {}
    for item in ctx.briefings:
        brigade = item.get("brigade_id")
        if item.get("complete") is True and isinstance(brigade, str):
            dispatched.setdefault(brigade, item)
    return [
        str(item.get("heard_address") or "")
        for item in dispatched.values()
        if item.get("address") == "wrong"
    ]


def _expected_line(address: dict[str, Json]) -> str:
    street, house = address.get("street"), address.get("house")
    parts = [value.strip() for value in (street, house) if isinstance(value, str) and value.strip()]
    return ", ".join(parts)


class AddressCriterion:
    """Проверить адрес там, где диспетчер ДДС его пишет: в комментариях к статусам.

    DT-14 (08.10): поле ввода адреса из АРМ ДДС убрано. Ручной `current.address` старых попыток
    (до 08.10) по-прежнему сравнивается по полям — старые события остаются валидными.
    """

    key = "address"

    # Тип улицы между названием и номером дома: «Дубнинская улица, 1», «Мира пр 5».
    _STREET_TYPE = r"(?:улица|ул|проспект|пр|переулок|пер|шоссе|ш|бульвар|набережная|наб|проезд)"
    # Как записывают номер компонента: «д. 1», «корп. 2», «кв. 3».
    _NUMBER_PREFIX = {
        "house": r"(?:дом|д)",
        "building": r"(?:корпус|корп|к)",
        "apartment": r"(?:квартира|кв)",
    }

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
            if re.search(rf"\b{cls._NUMBER_PREFIX[field]}\s*{number}\b", comment):
                return True
            # 29.09: номер сразу за улицей — обычная запись адреса («Дубнинская улица, 1»).
            core = normalize_address_component("street", street)
            return bool(core) and bool(
                re.search(rf"{re.escape(core)}(?:\s+{cls._STREET_TYPE})?\s+{number}\b", comment)
            )
        if field in cls._NUMBER_PREFIX:
            number = re.escape(normalized)
            return bool(re.search(rf"\b{cls._NUMBER_PREFIX[field]}\s*{number}\b", comment))
        return normalized in comment

    @classmethod
    def _numbers_at_street(cls, field: str, comment: str, street: str) -> set[str]:
        """Номера компонента в записи адреса, которая начинается с улицы эталона:
        «Дубнинская ул., д. 14, кв. 50» → дом {14}, квартира {50}.

        Номер в другом месте комментария — не адрес происшествия: «эвакуировали в дом 14
        напротив», «соседка из кв. 50» (ревью DT-14, 11.10)."""
        core = normalize_address_component("street", street)
        if not core:
            return set()
        prefixes = "|".join(cls._NUMBER_PREFIX.values()) + "|строение|стр"
        mentions = re.finditer(
            rf"(?<![0-9a-zа-я]){re.escape(core)}(?:\s+{cls._STREET_TYPE})?"
            rf"(?:\s+{cls._NUMBER_PREFIX['house']})?\s+(\d+[а-я]?)\b"
            rf"((?:\s+(?:{prefixes})\s*\d+[а-я]?\b)*)",
            comment,
        )
        numbers: set[str] = set()
        for mention in mentions:
            if field == "house":
                numbers.add(mention.group(1))
            else:
                numbers |= set(
                    re.findall(rf"\b{cls._NUMBER_PREFIX[field]}\s*(\d+[а-я]?)\b", mention.group(2))
                )
        return numbers

    def evaluate(self, ctx: EvalContext) -> CriterionResult:
        """Вернуть долю верных компонентов адреса.

        Адрес карточки верен (эталон совпадает с карточкой): ошибка — только искажённый адрес
        в комментарии (опечатка в улице, другой номер в записи адреса — `_distorted`);
        адреса нет — балл 1.
        Адрес уточнён (`address_clarified`): каждый компонент эталона должен быть в комментарии
        (город — только если уточнился и он).
        Балл — доля компонентов эталона без ошибки; ошибка улицы или дома — critical.
        """
        weight = _criterion_weight(ctx, self.key)
        address = _reference(ctx).get("expected_address")
        if not isinstance(address, dict):
            raise ValueError("reference.expected_address должен быть объектом")
        manual = ctx.current.get("address")
        if isinstance(manual, dict):
            return self._evaluate_manual(weight, address, manual)

        raw_comment = _all_comments(ctx)
        comment = _normalized(raw_comment)
        checked = {
            field: value
            for field in _ADDRESS_COMPONENTS
            if isinstance((value := address.get(field)), str) and value.strip()
        }
        street = checked.get("street", "")
        present = [
            field
            for field, value in checked.items()
            if self._component_present(field, value, comment, street)
        ]
        clarified = address_clarified(ctx)
        if clarified:
            # Город уточнённого адреса обязателен, только если он и уточнился: ДДС московская,
            # «Москва» в каждом комментарии — шум, а не сведения для следующего звена.
            errors = [
                field
                for field in checked
                if field not in present and (field != "city" or self._city_changed(ctx, address))
            ]
        else:
            errors = self._distorted(checked, present, raw_comment, comment)
        score = 1.0 if not checked else (len(checked) - len(errors)) / len(checked)
        evidence = [
            "Адрес уточнён по ходу работы: уточнённый адрес нужен в комментарии"
            if clarified
            else "Адрес карточки верен: в комментарии его можно не повторять, но не искажать",
            f"Найдено {len(present)} из {len(checked)} компонентов адреса в комментариях",
        ]
        if errors:
            evidence.append(f"Не совпали: {_join_fields(errors)}")
        named = other_street if clarified else similar_street
        wrong_street = named(raw_comment, street) if "street" in errors else None
        if wrong_street:
            evidence.append(f"В комментарии другая улица: «{wrong_street}»")
        explanation = self._explanation(
            clarified, errors, bool(present), len(present) == len(checked), wrong_street
        )
        address_remarks = self._remarks(clarified, errors, checked, raw_comment, wrong_street)
        sent = wrong_briefings(ctx)
        if sent:
            # GP-05: бригада уехала по адресу вводной — адрес в комментарии этого не исправит.
            heard = ", ".join(f"«{item}»" for item in sent)
            evidence.append(f"Во вводной бригаде назван другой адрес: {heard}")
            explanation = (
                f"Критическая ошибка: во вводной бригаде назван адрес {heard} вместо "
                f"«{_expected_line(address)}» — бригада уехала не туда. {explanation}"
            )
            score = 0.0
            address_remarks += (
                Remark(
                    "Во вводной бригаде назван другой адрес.",
                    f"Бригада уехала по адресу {heard} вместо «{_expected_line(address)}».",
                    remarks.MEMO_WHAT_IF,
                    "Повторите: перед направлением бригады сверьте улицу и дом вводной "
                    "с адресом карточки.",
                    "; ".join(sent) or None,
                ),
            )
        return CriterionResult(
            self.key,
            score,
            weight,
            "street" in errors or "house" in errors or bool(sent),
            evidence,
            explanation,
            address_remarks,
        )

    @staticmethod
    def _remarks(
        clarified: bool,
        errors: list[str],
        checked: dict[str, str],
        raw_comment: str,
        wrong_street: str | None,
    ) -> tuple[Remark, ...]:
        """Замечания адреса: другая улица (с цитатой), нет уточнённого, искажён номер."""
        found: list[Remark] = []
        street = checked.get("street", "")
        rest = [field for field in errors if not (wrong_street and field == "street")]
        if wrong_street:
            found.append(
                remarks.other_street_named(
                    wrong_street, street, remarks.quote_word(raw_comment, wrong_street)
                )
            )
        if rest and clarified:
            place = ", ".join(
                f"{_FIELD_RU[field]} {checked[field]}" if field != "street" else checked[field]
                for field in _ADDRESS_COMPONENTS
                if field in checked and field != "city"
            )
            found.append(remarks.clarified_address_missing(_join_fields(rest), place))
        elif rest:
            mention = next(
                (
                    quoted
                    for word in street_words(street)
                    if (quoted := remarks.quote_word(raw_comment, word))
                ),
                None,
            )
            found.append(remarks.distorted_address(_join_fields(rest), mention))
        return tuple(found)

    @staticmethod
    def _city_changed(ctx: EvalContext, expected: dict[str, Json]) -> bool:
        card = ctx.scenario.get("card")
        shown = card.get("address") if isinstance(card, dict) else None
        want = expected.get("city")
        have = shown.get("city") if isinstance(shown, dict) else None
        if not isinstance(want, str) or not isinstance(have, str):
            return True
        return not address_components_match("city", want, have)

    def _distorted(
        self, checked: dict[str, str], present: list[str], raw_comment: str, comment: str
    ) -> list[str]:
        """Компоненты, названные в комментарии неверно, когда адрес карточки верен.

        Ошибка — только опечатка в названии улицы («Дубининская» при «Дубнинская») и другой
        номер в записи адреса с улицей эталона. Другая улица целиком («гидрант на ул. Ленина»)
        и номер дома вне адреса («в дом 14 напротив») — не искажение (ревью DT-14, 11.10).
        """
        street = checked.get("street", "")
        errors: list[str] = []
        for field in checked:
            if field in present:
                continue
            if field == "street":
                wrong = similar_street(raw_comment, street) is not None
            elif field in self._NUMBER_PREFIX:
                wrong = bool(self._numbers_at_street(field, comment, street))
            else:
                wrong = False
            if wrong:
                errors.append(field)
        return errors

    @staticmethod
    def _explanation(
        clarified: bool,
        errors: list[str],
        mentioned: bool,
        complete: bool,
        wrong_street: str | None,
    ) -> str:
        if errors and wrong_street:
            return (
                f"В комментарии указана другая улица — «{wrong_street}». "
                "Проверьте название улицы по буквам."
            )
        if errors and clarified:
            return f"Не подтверждены компоненты уточнённого адреса: {_join_fields(errors)}."
        if errors:
            return f"Адрес в комментарии искажён: {_join_fields(errors)}."
        if clarified or complete:
            return "Адрес в комментарии соответствует эталону."
        if mentioned:
            return "Адрес в комментарии не искажён."
        return "Адрес карточки верен и не менялся; в комментарии его можно не повторять."

    def _evaluate_manual(
        self, weight: float, expected: dict[str, Json], actual: dict[str, Json]
    ) -> CriterionResult:
        """Сравнить введённые поля с эталоном без нечёткого совпадения улиц."""
        fields = _ADDRESS_COMPONENTS
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
            (remarks.manual_address(_join_fields(missing)),) if missing else (),
        )


# Части доклада службе — порядок памятки ДДС, с. 32, строка «Ситуация на месте происшествия
# отличается от изначально заявленной либо изменилась, требуется вызов других служб»:
# представиться (ФИО, должность, служба), назвать адрес и повод, сообщить, что служба работает
# по ранее направленной карточке (можно номер), сообщить об изменении ситуации. Для звонка
# руководителю и в другие службы памятка своего порядка не даёт — берём тот же, но без
# карточки: её памятка требует только в звонке в 112 (допущение).
REPORT_PARTS = {
    "who": "кто вы",
    "address": "адрес и повод",
    "card": "карточка",
    "change": "что изменилось",
}


def required_parts(phone_ext: object) -> tuple[str, ...]:
    """Обязательные части доклада по номеру собеседника: карточка — только для 112.

    Номер не известен (`None`) — все части, как до этого правила.
    """
    if phone_ext is None or phone_ext == CARD_REPORT_EXT:
        return tuple(REPORT_PARTS)
    return tuple(part for part in REPORT_PARTS if part != "card")


# Вид неполного доклада — первая недостающая часть по порядку памятки.
PART_GAPS = {
    "who": "no_who",
    "address": "no_address",
    "card": "no_card",
    "change": "no_change",
}
# Виды доклада службе (call_hangup.report_choices): что не так в неверном докладе.
# Голосовой доклад сводится к тем же видам по частям (evalcore.report).
REPORT_GAPS = {
    "no_who": "не представился",
    "no_address": "без адреса и повода",
    "no_card": "без карточки",
    "no_change": "без того, что изменилось",
    "extra": "с лишними сведениями: догадки, оценки, просьбы",
    # Виды до порядка памятки (журналы занятий до 08.10.2026): только читаются.
    "no_victims": "без сведений о пострадавших и силах",
    "no_incident": "без сути происшествия",
}
# Каких частей не было в докладе прежнего вида (report_parts тогда не писались).
_LEGACY_MISSING = {"no_victims": "change", "no_incident": "address"}


def report_parts_of(choice: str) -> tuple[str, ...]:
    """Части доклада по его виду: полный и «с лишним» — все четыре, неполный — без одной."""
    gaps = {gap: part for part, gap in PART_GAPS.items()} | _LEGACY_MISSING
    missing = gaps.get(choice)
    return tuple(part for part in REPORT_PARTS if part != missing)


# После стольких нераспознанных голосовых докладов АРМ предлагает варианты ответа.
VOICE_FAILURES_BEFORE_CHOICES = 2


@dataclass(frozen=True)
class CallReport:
    """Доклад службе в одном звонке: виды по порядку, как сказан каждый, неудачи голоса.

    modes[i] — "voice" (сказан и распознан) или "option" (выбран вариантом ответа).
    Нет report_modes в отбое (занятия до голосового ввода) — все доклады вариантами.
    parts[i] — какие части памятки прозвучали в докладе i; нет report_parts (варианты
    ответа, занятия до 08.10.2026) — части по виду доклада (`report_parts_of`).
    """

    choices: list[str]
    modes: list[str]
    voice_failures: int
    parts: list[tuple[str, ...]]
    # Громкость голосовых докладов (evalcore.loudness): quiet, ok, loud; None — вариант
    # ответа или не измерено.
    loudness: list[str | None] = dataclass_field(default_factory=list)


def _parts(raw: object, choice: str) -> tuple[str, ...]:
    if isinstance(raw, list) and all(isinstance(item, str) for item in raw):
        return tuple(part for part in REPORT_PARTS if part in raw)
    return report_parts_of(choice)


def _call_key(value: object) -> str:
    """UUID одного звонка может прийти в разном регистре; старые фикстуры имеют иные id."""
    try:
        return str(UUID(str(value)))
    except ValueError:
        return str(value)


def _call_reports(ctx: EvalContext) -> dict[str, CallReport]:
    """Последний явный накопительный снимок доклада из удержания или отбоя.

    Снятие удержания и отсутствие нового снимка не стирают сохранённый доклад. Удержание
    и серверный timeout — современные записи: без доклада им не положен legacy-балл.
    Исторические звонки без этих признаков и без report_choices сохраняют прежнюю оценку.
    """
    reports: dict[str, CallReport] = {
        _call_key(call.get("id")): CallReport([], [], 0, [])
        for call in ctx.calls
        if call.get("end_reason") == "hold_timeout"
    }
    for event in ctx.events:
        payload = event.get("payload")
        if event.get("type") not in {"call_hold", "call_hangup"} or not isinstance(payload, dict):
            continue
        call_id = _call_key(payload.get("call_id"))
        if event.get("type") == "call_hold":
            reports.setdefault(call_id, CallReport([], [], 0, []))
        choices = payload.get("report_choices")
        if not isinstance(choices, list):
            continue
        raw_modes = payload.get("report_modes")
        modes = [str(item) for item in raw_modes] if isinstance(raw_modes, list) else []
        raw_parts = payload.get("report_parts")
        parts = raw_parts if isinstance(raw_parts, list) else []
        failures = payload.get("voice_failures")
        raw_loudness = payload.get("report_loudness")
        loudness = raw_loudness if isinstance(raw_loudness, list) else []
        reports[call_id] = CallReport(
            [str(item) for item in choices],
            [modes[index] if index < len(modes) else "option" for index in range(len(choices))],
            failures if isinstance(failures, int) and not isinstance(failures, bool) else 0,
            [
                _parts(parts[index] if index < len(parts) else None, str(choice))
                for index, choice in enumerate(choices)
            ],
            [str(item) if item in LOUDNESS_TEXT else None for item in loudness[: len(choices)]],
        )
    return reports


def _report_factor(ctx: EvalContext) -> float:
    factor = _setting_number(ctx.settings, "report_choice_factor", REPORT_CHOICE_FACTOR)
    if not 0 <= factor <= 1:
        raise ValueError("settings.report_choice_factor должен быть от 0 до 1")
    return factor


def _reported(report: CallReport, factor: float) -> float:
    """Доля балла за доклад: полный голосом — 1, полный вариантом ответа — factor, иначе 0."""
    if "full" not in report.choices:
        return 0.0
    return 1.0 if report.modes[report.choices.index("full")] == "voice" else factor


def _report_line(phone_ext: object, report: CallReport) -> str:
    """Замечание разбора по докладу службе: полный ли он, как сказан и что упущено до него."""
    choices = report.choices
    complete = "full" in choices
    before = choices[: choices.index("full")] if complete else choices
    # Одна и та же ошибка подряд — одной строкой с числом: «без карточки (3 раза)».
    gaps = "; ".join(
        REPORT_GAPS.get(item, item)
        + (f" ({before.count(item)} раза)" if before.count(item) > 1 else "")
        for item in dict.fromkeys(before)
    )
    if complete:
        how = "голосом" if report.modes[choices.index("full")] == "voice" else "ответ вариантом"
        line = (
            f"Доклад службе {phone_ext}: полный, {how}"
            if not gaps
            else f"Доклад службе {phone_ext}: полный, {how}, после уточнения; сначала — {gaps}"
        )
    elif not gaps:
        line = f"Доклад службе {phone_ext}: не сделан, трубка положена до доклада"
    else:
        line = f"Доклад службе {phone_ext}: полного доклада нет — {gaps}"
    measured = [item for item in report.loudness if item is not None]
    off = [item for item in measured if item != "ok"]
    if off:
        worst = max(set(off), key=off.count)
        line += f"; громкость голоса: {LOUDNESS_TEXT[worst]} ({len(off)} из {len(measured)})"
    elif measured:
        line += "; громкость голоса в норме"
    if report.voice_failures:
        line += f"; голос не распознан: {report.voice_failures}"
        if report.voice_failures >= VOICE_FAILURES_BEFORE_CHOICES:
            line += ", предложены варианты ответа"
    return line


def _parts_line(phone_ext: object, report: CallReport) -> str | None:
    """Какие части памятки прозвучали: «кто вы ✓, адрес и повод ✓, карточка ✗, …».

    Берётся первый доклад звонка — то, что обучаемый сказал сам, до уточнений службы.
    """
    if not report.parts:
        return None
    first = report.parts[0]
    marks = ", ".join(
        f"{REPORT_PARTS[part]} {'✓' if part in first else '✗'}"
        for part in required_parts(phone_ext)
    )
    which = "первого доклада" if len(report.parts) > 1 else "доклада"
    return f"Части {which} службе {phone_ext} по памятке ДДС, с. 32: {marks}"


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
        # Диспетчер ДДС работает с бригадами: звонок своей службе ради звонка не нужен,
        # обязательные звонки задают события сценария (brigade_work). Правило — для
        # сценариев с планом докладов, в том числе выданных до GP-04 с required: true.
        contact_role = expected.get("contact_role")
        own_service = (
            bool(ctx.planned_messages)
            and expected.get("service_id") == ctx.scenario.get("target_service_id")
            and not contact_role
        )
        if not required or own_service:
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

        # Доклад абоненту телефона ДДС (GP-09): адресат — номер этой роли в списке ДДС занятия.
        contact_numbers = (
            {
                item["number"]
                for item in phone_contacts(ctx.settings, service_id)
                if item.get("role") == contact_role
            }
            if isinstance(contact_role, str)
            else None
        )
        delivered_at = _first_event_time(ctx, "deliver")
        reports = _call_reports(ctx)
        factor = _report_factor(ctx)
        candidates: list[tuple[float, list[str], bool, bool, list[str], list[Remark], bool]] = []
        refused_calls = 0
        for call in ctx.calls:
            # Обязательный звонок делает диспетчер; входящий вызов бригады — не он.
            if call.get("direction") == "inbound":
                continue
            # Доклад абоненту телефона ДДС — не разговор с бригадой своей службы (GP-08).
            if contact_numbers is not None and call.get("brigade_id") is not None:
                continue
            answered = isinstance(call.get("answered_at"), str)
            # Доклад записан (голосом или вариантами): состоявшимся считается разговор с
            # полным докладом. Без полного доклада связь есть, но первая треть балла не
            # засчитывается; полный вариантом ответа — только её доля report_choice_factor.
            report = reports.get(_call_key(call.get("id")))
            reported = float(answered)
            report_lines: list[str] = []
            if report is not None and answered:
                report_lines.append(_report_line(call.get("phone_ext"), report))
                parts_line = _parts_line(call.get("phone_ext"), report)
                if parts_line:
                    report_lines.append(parts_line)
                reported = _reported(report, factor)
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
            addressee_correct = service_correct and (
                call.get("phone_ext") in contact_numbers
                if contact_numbers is not None
                else phone_correct or brigade_of_service
            )
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
            score = (reported + float(addressee_correct) + time_score) / 3
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
            # Отбой с пустым списком докладов — соединение было, но адресат
            # ничего не узнал. Старые записи без report_choices не меняем.
            hung_up_silent = report is not None and not report.choices
            successful_contact = answered and addressee_correct and not hung_up_silent
            # Единственное отличие от эталона — доклад вариантом: объяснение говорит об этом.
            only_choice = 0 < reported < 1 and addressee_correct and time_score == 1
            found: list[Remark] = []
            transcript = call.get("transcript")
            if not successful_contact:
                found.append(remarks.call_not_reached(phone_ext, not addressee_correct))
            elif report is not None and reported == 0:
                found.append(_incomplete_report(report, phone_ext, transcript))
            elif 0 < reported < 1:
                found.append(remarks.call_by_choice())
            if successful_contact and time_score < 1:
                found.append(
                    remarks.call_late(
                        f"Звонок начат через {round(delay_s)} с при нормативе {before_s:g} с."
                        if delay_s is not None and delay_s >= 0
                        else "Время начала звонка не подтверждено."
                    )
                )
            candidates.append(
                (
                    score,
                    evidence,
                    successful_contact,
                    only_choice,
                    report_lines,
                    found,
                    hung_up_silent,
                )
            )

        if not candidates:
            return CriterionResult(
                self.key,
                0.0,
                weight,
                True,
                ["Обязательный звонок отсутствует"],
                "Обязательный звонок не выполнен.",
                (remarks.call_missing(phone_ext),),
            )
        best = max(candidates, key=lambda candidate: (candidate[0], candidate[2]))
        score, evidence, successful_contact, by_choice, best_lines, best_remarks, silent = best
        # Доклады других звонков — сведения, а не причина балла: балл берётся по лучшему
        # звонку, и «не сделан» рядом с «отлично» без пометки читается как ошибка разбора.
        others = [
            f"Другой звонок — {line}"
            for candidate in candidates
            if candidate is not best
            for line in candidate[4]
        ]
        evidence = [*evidence, *best_lines, *others]
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
            "Звонок соответствует эталону."
            if score == 1
            else "Звонок по эталону, но доклад сделан вариантом ответа: он оценивается ниже "
            "доклада голосом."
            if by_choice
            else "Звонок прерван до доклада."
            if silent
            else "Звонок выполнен с нарушениями.",
            () if score == 1 else tuple(best_remarks),
        )


def _incomplete_report(report: CallReport, phone_ext: str, transcript: Json | None) -> Remark:
    """Полного доклада нет: чего не хватило (по порядку памятки, с. 32) и цитата сказанного."""
    gaps = "; ".join(REPORT_GAPS.get(item, item) for item in dict.fromkeys(report.choices))
    first = report.choices[0] if report.choices else ""
    part = next((part for part, gap in PART_GAPS.items() if gap == first), first)
    said = remarks.excerpt(transcript) if isinstance(transcript, str) else None
    return remarks.call_report_incomplete(
        gaps or "трубка положена до доклада", part, phone_ext, said
    )


register(ReactionTimeCriterion())
register(HandlingTimeCriterion())
register(StatusFlowCriterion())
register(RoutingCriterion())
register(RequiredFieldsCriterion())
register(AddressCriterion())
register(CallCriterion())
