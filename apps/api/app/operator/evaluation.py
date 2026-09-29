"""Оценка попытки «Оператор 112»: детерминированные критерии, пояснения по-русски.

Настройки модуля (веса, норматив) — константы этого файла, как `OPERATOR_SETTINGS` на
вебе (`apps/web/src/operator/model.ts`); своей таблицы настроек для весов пока нет.
"""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from app.operator.caller import (
    ADDRESS_KEY,
    ADDRESS_STEP,
    CALLBACK_KEY,
    LANDMARK_KEY,
    PANIC_HYSTERIA,
    PANIC_MAX,
    PANIC_START,
    PANIC_THRESHOLD,
    CallerState,
    address_field_match,
    mentions,
    question_steps,
)
from app.operator.scenarios import load_classifier, load_questionnaires

# Норматив времени до сохранения — как OPERATOR_SETTINGS.normativeS на вебе.
NORMATIVE_S = 180

# Этап 2: вместо «Итоговой паники» (5) — «Работа с заявителем» (10): успокоение, паузы,
# совет при ухудшении; время — 5 (баллы за него и так только при верных типе и адресе).
# Этап 3: «Порядок опроса» (10) — веса как в одобренном прототипе: тип и службы по 15.
DEFAULT_WEIGHTS: dict[str, int] = {
    "incident_type": 15,
    "tags": 10,
    "services": 15,
    "address": 20,
    "description": 15,
    "order": 10,
    "caller": 10,
    "timing": 5,
}

TITLES: dict[str, str] = {
    "incident_type": "Тип происшествия",
    "tags": "Теги",
    "services": "Службы",
    "address": "Адрес",
    "description": "Описание",
    "order": "Порядок опроса",
    "caller": "Работа с заявителем",
    "timing": "Время до сохранения",
}

# Как TRIGGER_GROUPS.title на вебе (apps/web/src/operator/model.ts).
TAG_RU: dict[str, str] = {
    "victims": "Пострадавшие",
    "no_access": "Нет доступа",
    "offense": "Правонарушение",
    "gasification": "Газификация",
}

ADDRESS_FIELDS: tuple[str, ...] = (
    "city",
    "okrug",
    "district",
    "street",
    "house",
    "building",
    "apartment",
)
FIELD_RU: dict[str, str] = {
    "city": "населённый пункт",
    "okrug": "округ",
    "district": "район",
    "street": "улица",
    "house": "дом",
    "building": "корпус",
    "apartment": "квартира",
}
# Округ и район заявитель называет не всегда (разбор 29.09): поле, которого он не назвал,
# обязательно только если обучаемый его заполнил — тогда неверное значение остаётся ошибкой.
OPTIONAL_ADDRESS_FIELDS: frozenset[str] = frozenset({"okrug", "district"})
# Без верных улицы и дома служба не найдёт место — быстрота такой карточки не засчитывается.
CRITICAL_ADDRESS_FIELDS: frozenset[str] = frozenset({"street", "house"})


@dataclass(frozen=True)
class Criterion:
    key: str
    title: str
    weight: int
    score: float
    points: int
    explanation: str


@dataclass(frozen=True)
class EvaluationResult:
    criteria: tuple[Criterion, ...]
    total: int
    max_total: int


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def _incident_type_name(code: str | None) -> str | None:
    if code is None:
        return None
    for row in load_classifier()["incident_types"]:
        if row["code"] == code:
            return str(row["name"])
    return code


def _service_name(service_id: str) -> str:
    for row in load_classifier()["services"]:
        if row["id"] == service_id:
            return str(row["name"])
    return service_id


def _criterion(key: str, score: float, explanation: str, weights: Mapping[str, int]) -> Criterion:
    weight = weights[key]
    score = _clamp(score)
    return Criterion(key, TITLES[key], weight, score, round(weight * score), explanation)


# Близкий, но менее точный тип (close_incident_type_codes сценария) — половина балла.
CLOSE_TYPE_SCORE = 0.5


def _type_accepted(scenario: dict[str, Any], code: str | None) -> bool:
    """Тип эталона или равнозначный ему дубль классификатора из другой группы."""
    return code == scenario["incident_type_code"] or code in scenario.get(
        "accepted_incident_type_codes", ()
    )


def _type_close(scenario: dict[str, Any], code: str | None) -> bool:
    return code in scenario.get("close_incident_type_codes", ())


def _eval_incident_type(
    scenario: dict[str, Any], code: str | None, weights: Mapping[str, int]
) -> Criterion:
    expected = scenario["incident_type_code"]
    expected_name = _incident_type_name(expected) or "нет происшествия"
    if code == expected:
        name = _incident_type_name(expected)
        text = (
            f"Тип происшествия определён верно: «{name}»."
            if name
            else "Верно определено, что происшествия нет."
        )
        return _criterion("incident_type", 1.0, text, weights)
    chosen_name = _incident_type_name(code) or "нет происшествия"
    if _type_accepted(scenario, code):
        # В классификаторе один случай бывает в двух группах (разбор капитана 29.09).
        text = f"Тип происшествия определён верно: «{chosen_name}» — то же, что «{expected_name}»."
        return _criterion("incident_type", 1.0, text, weights)
    if _type_close(scenario, code):
        text = (
            f"Тип происшествия указан неточно: выбрано «{chosen_name}», точнее — «{expected_name}»."
        )
        return _criterion("incident_type", CLOSE_TYPE_SCORE, text, weights)
    text = f"Тип происшествия указан неверно: выбрано «{chosen_name}», ожидалось «{expected_name}»."
    return _criterion("incident_type", 0.0, text, weights)


def _eval_tags(
    scenario: dict[str, Any], tags: Iterable[str], weights: Mapping[str, int]
) -> Criterion:
    # Спорные теги сценария (optional_tags) службы не меняют — не требуются и не штрафуются.
    expected = set(scenario["expected_tags"])
    chosen = set(tags) - set(scenario.get("optional_tags", ()))
    if expected == chosen:
        names = ", ".join(TAG_RU.get(tag, tag) for tag in sorted(expected)) or "нет тегов"
        return _criterion("tags", 1.0, f"Теги указаны верно: {names}.", weights)
    missing, extra = expected - chosen, chosen - expected
    union = expected | chosen
    score = len(expected & chosen) / len(union) if union else 1.0
    parts = []
    if missing:
        parts.append(f"не отмечены: {', '.join(TAG_RU.get(t, t) for t in sorted(missing))}")
    if extra:
        parts.append(f"отмечены лишние: {', '.join(TAG_RU.get(t, t) for t in sorted(extra))}")
    return _criterion("tags", score, "Теги: " + "; ".join(parts) + ".", weights)


def _eval_services(
    scenario: dict[str, Any], services: Iterable[str], weights: Mapping[str, int]
) -> Criterion:
    expected, chosen = set(scenario["expected_services"]), set(services)
    if expected == chosen:
        names = ", ".join(_service_name(s) for s in sorted(expected)) or "нет служб"
        return _criterion("services", 1.0, f"Службы подобраны верно: {names}.", weights)
    missing, extra = expected - chosen, chosen - expected
    if expected:
        score = _clamp(len(expected & chosen) / len(expected) - 0.15 * len(extra))
    else:
        score = 1.0 if not chosen else 0.5
    parts = []
    if missing:
        parts.append(f"пропущены: {', '.join(_service_name(s) for s in sorted(missing))}")
    if extra:
        parts.append(f"лишние: {', '.join(_service_name(s) for s in sorted(extra))}")
    return _criterion("services", score, "Службы: " + "; ".join(parts) + ".", weights)


def _checked_address_fields(scenario: dict[str, Any], address: Mapping[str, str]) -> list[str]:
    named = set(scenario.get("named_address_fields", ()))
    return [
        field
        for field in ADDRESS_FIELDS
        if field not in OPTIONAL_ADDRESS_FIELDS or field in named or address.get(field, "").strip()
    ]


def _address_mismatches(scenario: dict[str, Any], address: Mapping[str, str]) -> list[str]:
    expected = scenario["address"]
    return [
        field
        for field in _checked_address_fields(scenario, address)
        if not address_field_match(field, expected[field], address.get(field, ""))
    ]


def _eval_address(
    scenario: dict[str, Any], address: Mapping[str, str], weights: Mapping[str, int]
) -> Criterion:
    expected = scenario["address"]
    mismatched = _address_mismatches(scenario, address)
    if "street" in mismatched:
        text = (
            f"Улица указана неверно: «{address.get('street', '')}» вместо «{expected['street']}» "
            "— критическая ошибка, служба не найдёт место."
        )
        return _criterion("address", 0.0, text, weights)
    if not mismatched:
        return _criterion("address", 1.0, "Адрес указан верно.", weights)
    score = 1 - len(mismatched) / len(_checked_address_fields(scenario, address))
    names = ", ".join(FIELD_RU[field] for field in mismatched)
    return _criterion("address", score, f"В адресе неверно указано: {names}.", weights)


def _eval_description(
    scenario: dict[str, Any], description: str, escalated: bool, weights: Mapping[str, int]
) -> Criterion:
    if not description.strip():
        return _criterion("description", 0.0, "Описание не заполнено.", weights)
    # Факты — явный список сценария, а не слова эталонного текста: верное описание своими
    # словами не должно терять баллы (разбор 29.09, «учтено 9 из 23»). Если ситуация
    # ухудшилась, в описании нужен и новый факт.
    facts = list(scenario["description_facts"])
    if escalated and scenario.get("escalation"):
        facts.append(scenario["escalation"]["fact"])
    missing = [fact["title"] for fact in facts if not mentions(description, fact["synonyms"])]
    if not missing:
        return _criterion("description", 1.0, "Описание отражает все ключевые факты.", weights)
    found = len(facts) - len(missing)
    text = (
        f"Описание неполное: учтено {found} из {len(facts)} ключевых фактов; "
        f"не хватает: {', '.join(missing)}."
    )
    return _criterion("description", found / len(facts), text, weights)


def _timing_blocker(
    scenario: dict[str, Any], code: str | None, address: Mapping[str, str]
) -> str | None:
    """Почему время не засчитывается: неверны тип или улица и дом; иначе None. Близкий тип
    время не отнимает: ситуация понята верно, неточность уже стоит половины балла за тип."""
    type_wrong = not (_type_accepted(scenario, code) or _type_close(scenario, code))
    address_wrong = scenario["incident_type_code"] is not None and bool(
        CRITICAL_ADDRESS_FIELDS & set(_address_mismatches(scenario, address))
    )
    if type_wrong and address_wrong:
        return "тип происшествия и адрес указаны неверно"
    if type_wrong:
        return "тип происшествия указан неверно"
    if address_wrong:
        return "в адресе неверны улица или дом"
    return None


def _eval_timing(elapsed_s: int, blocker: str | None, weights: Mapping[str, int]) -> Criterion:
    if blocker is not None:
        text = (
            f"Время не засчитано: карточка сохранена за {elapsed_s} с, но {blocker} — "
            "быстро сохранённая неверная карточка помощь не ускоряет."
        )
        return _criterion("timing", 0.0, text, weights)
    if elapsed_s <= NORMATIVE_S:
        text = f"Карточка сохранена за {elapsed_s} с — в пределах норматива {NORMATIVE_S} с."
        return _criterion("timing", 1.0, text, weights)
    over = elapsed_s - NORMATIVE_S
    score = 1 - over / NORMATIVE_S
    text = (
        f"Карточка сохранена за {elapsed_s} с — с опозданием на {over} с "
        f"(норматив {NORMATIVE_S} с)."
    )
    return _criterion("timing", score, text, weights)


# Доли критерия «Работа с заявителем»: итоговая паника, успокоение, паузы, ухудшение.
CALLER_SHARES = {"panic": 0.4, "calming": 0.2, "pauses": 0.2, "escalation": 0.2}


def _eval_caller(
    scenario: dict[str, Any], caller: CallerState, weights: Mapping[str, int]
) -> Criterion:
    """Работа с заявителем: чем кончился разговор и какими приёмами (этап 2, IAED).

    score = 0,4·(1 − паника/3) + 0,2·успокоение + 0,2·паузы + 0,2·ухудшение, где
    успокоение — 1, если истерику снимали просьбой с причиной (или истерики не было), минус
    0,5 за «Успокойтесь!» без причины; паузы — 1 без пауз, 0,5 за одну, 0 за две и больше;
    ухудшение — 1, если его не было или на него дан нужный совет.
    """
    issues: list[str] = []
    score = CALLER_SHARES["panic"] * (1 - caller.panic / PANIC_MAX)
    if caller.panic >= PANIC_THRESHOLD:
        issues.append(f"разговор закончился в панике ({caller.panic} из {PANIC_MAX})")

    calming = 1.0
    if scenario.get("start_panic", PANIC_START) >= PANIC_HYSTERIA and not caller.calm_reason:
        calming = 0.0
        issues.append("истерику не снимали просьбой с причиной («Успокоить»)")
    if caller.calm_order:
        calming -= 0.5
        issues.append("«Успокойтесь!» без причины злит заявителя")
    score += CALLER_SHARES["calming"] * max(0.0, calming)

    pauses = 1.0 if caller.pauses == 0 else 0.5 if caller.pauses == 1 else 0.0
    score += CALLER_SHARES["pauses"] * pauses
    if caller.pauses:
        issues.append(f"пауз, после которых заявитель переспрашивал «Алло?», — {caller.pauses}")

    escalation = scenario.get("escalation")
    if escalation is None or not caller.escalated or caller.escalation_handled:
        score += CALLER_SHARES["escalation"]
    else:
        issues.append("на ухудшение ситуации не дан нужный совет")

    if not issues:
        text = (
            "Заявитель полностью успокоился — вопросы и приёмы оператора сняли панику."
            if caller.panic == 0
            else f"Заявитель спокоен ({caller.panic} из {PANIC_MAX}), приёмы применены верно."
        )
        return _criterion("caller", score, text, weights)
    return _criterion("caller", score, "Работа с заявителем: " + "; ".join(issues) + ".", weights)


# Доли критерия «Порядок опроса» (этап 3, APCO/NENA): адрес первым, повтор адреса, номер для
# обратной связи, ориентир. Адрес первым — вдвое важнее: без него помощь не отправить.
ORDER_SHARES = {"address_first": 0.4, "confirmed": 0.2, "callback": 0.2, "landmark": 0.2}
ORDER_ISSUES = {
    "address_first": "первым спрошен не адрес",
    "confirmed": "адрес не подтверждён повтором вслух",
    "callback": "номер для обратной связи не подтверждён",
    "landmark": "ориентир не уточнён",
}


def address_asked_first(steps: Mapping[str, int], asked: Iterable[str]) -> bool:
    """Заявитель услышал вопрос об адресе раньше любого вопроса шагов 2–5.

    `asked` — вопросы карты в том порядке, в каком заявитель их услышал; адрес после
    «Успокоить» с причиной тоже в нём (просьба просила именно адрес).
    """
    heard = list(asked)
    if ADDRESS_KEY not in heard:
        return False
    before = heard[: heard.index(ADDRESS_KEY)]
    return all(steps.get(key, ADDRESS_STEP) == ADDRESS_STEP for key in before)


def _eval_order(
    scenario: dict[str, Any], caller: CallerState, weights: Mapping[str, int]
) -> Criterion:
    """Порядок опроса по стандарту приёма вызова (этап 3).

    score = 0,4·адрес первым + 0,2·адрес подтверждён повтором + 0,2·номер для обратной
    связи + 0,2·ориентир; у сценария без опросной карты порядок не оценивается (1).
    """
    if scenario["questionnaire_id"] is None:
        return _criterion("order", 1.0, "Опроса нет: номер набран ошибочно.", weights)
    steps = question_steps(load_questionnaires()[scenario["questionnaire_id"]])
    parts = {
        "address_first": address_asked_first(steps, caller.asked),
        "confirmed": caller.confirmed,
        "callback": CALLBACK_KEY in caller.asked,
        "landmark": LANDMARK_KEY in caller.asked,
    }
    # Округление — чтобы 0,2 + 0,2 + 0,2 не сохранялось в попытке как 0,6000000000000001.
    score = round(sum(ORDER_SHARES[name] for name, ok in parts.items() if ok), 2)
    missing = [ORDER_ISSUES[name] for name, ok in parts.items() if not ok]
    if not missing:
        text = (
            "Порядок по стандарту: адрес первым и подтверждён повтором, номер для обратной "
            "связи, ориентир."
        )
        return _criterion("order", 1.0, text, weights)
    return _criterion("order", score, "Порядок опроса: " + "; ".join(missing) + ".", weights)


def evaluate(
    scenario: dict[str, Any],
    *,
    incident_type_code: str | None,
    tags: Iterable[str],
    services: Iterable[str],
    address: Mapping[str, str],
    description: str,
    elapsed_s: int,
    caller: CallerState,
    weights: Mapping[str, int] | None = None,
) -> EvaluationResult:
    """Оценить сохранённую попытку по эталону сценария; веса — `DEFAULT_WEIGHTS`."""
    weights = weights or DEFAULT_WEIGHTS
    criteria = (
        _eval_incident_type(scenario, incident_type_code, weights),
        _eval_tags(scenario, tags, weights),
        _eval_services(scenario, services, weights),
        _eval_address(scenario, address, weights),
        _eval_description(scenario, description, caller.escalated, weights),
        _eval_order(scenario, caller, weights),
        _eval_caller(scenario, caller, weights),
        _eval_timing(elapsed_s, _timing_blocker(scenario, incident_type_code, address), weights),
    )
    return EvaluationResult(criteria, sum(c.points for c in criteria), sum(weights.values()))
