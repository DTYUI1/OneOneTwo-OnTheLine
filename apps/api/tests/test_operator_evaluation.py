import json
from pathlib import Path

from app.operator.caller import CallerState, address_field_match, mentions
from app.operator.evaluation import DEFAULT_WEIGHTS, _eval_order, evaluate
from app.operator.router import CardInput, _card_for_dispatch
from app.operator.scenarios import load_scenarios
from jsonschema import Draft202012Validator

CARD_SCHEMA_PATH = Path(__file__).parents[3] / "contracts" / "card.schema.json"
CARD_SCHEMA = Draft202012Validator(json.loads(CARD_SCHEMA_PATH.read_text(encoding="utf-8")))
# Звонок, проведённый как надо: истерику сняли просьбой с причиной, пауз не было; адрес
# первым и подтверждён повтором, номер для связи и ориентир уточнены (этап 3).
IDEAL_ASKED = ("address", "landmark", "callback", "what_happened", "victims")
IDEAL_CALLER = CallerState(panic=0, calm_reason=2, asked=IDEAL_ASKED, confirmed=True)


def _scenario(scenario_id):
    return {row["id"]: row for row in load_scenarios()}[scenario_id]


def _evaluate_fire(**card):
    """Идеальная карточка пожара, в которой меняются только переданные поля."""
    scenario = _scenario("fire_apartment_smoke")
    ideal = {
        "incident_type_code": scenario["incident_type_code"],
        "tags": scenario["expected_tags"],
        "services": scenario["expected_services"],
        "address": scenario["address"],
        "description": scenario["description_reference"],
        "elapsed_s": 90,
        "caller": IDEAL_CALLER,
    }
    result = evaluate(scenario, **{**ideal, **card})
    return {criterion.key: criterion for criterion in result.criteria}


def test_weights_sum_to_100():
    assert sum(DEFAULT_WEIGHTS.values()) == 100
    # Этап 3: веса одобренного прототипа — «Порядок опроса» 10, тип и службы по 15.
    assert DEFAULT_WEIGHTS["order"] == 10
    assert DEFAULT_WEIGHTS["incident_type"] == DEFAULT_WEIGHTS["services"] == 15


def test_order_criterion_counts_the_call_standard():
    """Этап 3: 0,4·адрес первым + 0,2·повтор адреса + 0,2·номер для связи + 0,2·ориентир."""
    ideal = _evaluate_fire()["order"]
    assert ideal.score == 1.0 and ideal.points == 10
    assert "адрес первым и подтверждён повтором" in ideal.explanation

    nothing = _evaluate_fire(caller=CallerState(panic=0))["order"]
    assert nothing.score == 0.0
    for words in (
        "первым спрошен не адрес",
        "не подтверждён повтором",
        "обратной связи",
        "ориентир",
    ):
        assert words in nothing.explanation

    # Имя (шаг 2) раньше адреса — адрес уже не первым, остальное засчитано.
    name_first = CallerState(
        panic=0, asked=("name", "address", "landmark", "callback"), confirmed=True
    )
    order = _evaluate_fire(caller=name_first)["order"]
    assert order.score == 0.6 and order.explanation == "Порядок опроса: первым спрошен не адрес."
    # Ориентир (шаг 1) раньше адреса — порядок не нарушен.
    landmark_first = CallerState(panic=0, asked=("landmark", "address"))
    order = _evaluate_fire(caller=landmark_first)["order"]
    assert order.score == 0.6
    assert "не подтверждён повтором" in order.explanation
    assert "обратной связи" in order.explanation


def test_order_is_not_scored_without_questionnaire():
    wrong_call = {"id": "wrong_call", "questionnaire_id": None}
    criterion = _eval_order(wrong_call, CallerState(), DEFAULT_WEIGHTS)
    assert criterion.score == 1.0


def test_ideal_attempt_scores_maximum():
    scenario = _scenario("fire_apartment_smoke")
    result = evaluate(
        scenario,
        incident_type_code=scenario["incident_type_code"],
        tags=scenario["expected_tags"],
        services=scenario["expected_services"],
        address=scenario["address"],
        description=scenario["description_reference"],
        elapsed_s=90,
        caller=IDEAL_CALLER,
    )
    assert result.total == result.max_total == 100
    assert all(criterion.score == 1.0 for criterion in result.criteria)


def test_wrong_street_is_critical_even_with_other_fields_correct():
    scenario = _scenario("fire_apartment_smoke")
    address = {**scenario["address"], "street": "Дубининская улица"}
    result = evaluate(
        scenario,
        incident_type_code=scenario["incident_type_code"],
        tags=scenario["expected_tags"],
        services=scenario["expected_services"],
        address=address,
        description=scenario["description_reference"],
        elapsed_s=90,
        caller=IDEAL_CALLER,
    )
    by_key = {c.key: c for c in result.criteria}
    assert by_key["address"].score == 0.0
    assert result.total < result.max_total


def test_empty_description_scores_zero():
    scenario = _scenario("fire_apartment_smoke")
    result = evaluate(
        scenario,
        incident_type_code=scenario["incident_type_code"],
        tags=scenario["expected_tags"],
        services=scenario["expected_services"],
        address=scenario["address"],
        description="   ",
        elapsed_s=90,
        caller=IDEAL_CALLER,
    )
    by_key = {c.key: c for c in result.criteria}
    assert by_key["description"].score == 0.0


def test_dispatch_card_matches_card_schema():
    scenario = _scenario("fire_apartment_smoke")
    card = CardInput(
        incident_type_code=scenario["incident_type_code"],
        tags=scenario["expected_tags"],
        services=scenario["expected_services"],
        address=scenario["address"],
        description=scenario["description_reference"],
        caller_name=scenario["caller"]["name"],
    )
    built = _card_for_dispatch(scenario, card, "0123456789abcdef")
    assert built is not None
    CARD_SCHEMA.validate(built)


def test_card_without_incident_type_has_no_dispatch_card():
    scenario = _scenario("fire_apartment_smoke")
    card = CardInput(incident_type_code=None)
    assert _card_for_dispatch(scenario, card, "0123456789abcdef") is None


def test_description_in_own_words_gets_full_score():
    """Разбор 29.09: верное описание не теряет баллы из-за слов, которых нет в эталоне."""
    by_key = _evaluate_fire(
        description=(
            "Из квартиры соседки на 5 этаже валит дым, огня не видно. Бабушка не открывает, "
            "дверь заперта."
        )
    )
    assert by_key["description"].score == 1.0
    assert by_key["description"].explanation == "Описание отражает все ключевые факты."


def test_incomplete_description_names_missing_facts():
    by_key = _evaluate_fire(description="Дым из квартиры, соседка не открывает.")
    description = by_key["description"]
    # Дым, соседка в квартире, не открывает — учтены; огонь, замок и этаж — нет.
    assert description.score == 3 / 6
    assert "учтено 3 из 6" in description.explanation
    assert "открытого огня нет" in description.explanation
    assert "пятый этаж" in description.explanation


def test_description_other_words_digits_and_typos_count():
    """Разбор капитана 29.09: «несовершенолетний» и «нет электричества» — те же факты, что
    «мальчик» и «погас свет»; «между 4 и 5» — то же, что «между четвёртым и пятым»."""
    scenario = _scenario("elevator_stuck")
    escalated = CallerState(panic=0, escalated=True, escalation_handled=True)

    def description(text):
        result = evaluate(
            scenario,
            incident_type_code=scenario["incident_type_code"],
            tags=[],
            services=scenario["expected_services"],
            address=scenario["address"],
            description=text,
            elapsed_s=90,
            caller=escalated,
        )
        return {criterion.key: criterion for criterion in result.criteria}["description"]

    captain = description(
        "Лифт, школа рядом, бабушка дома на пятом этаже, несовершенолетний застрял в лифте, "
        "нет электричества"
    )
    # Этажа кабины, травм и кнопки вызова в этом тексте действительно нет.
    assert "учтено 4 из 7" in captain.explanation
    for fact in ("между четвёртым и пятым этажом", "не пострадал", "кнопка вызова не отвечает"):
        assert fact in captain.explanation
    full = description(
        "Ребёнка 9 лет заперло в лифте между 4 и 5 этажами, он один, травм нет, связи с "
        "диспетчером нет, погас свет. Дом напротив школы."
    )
    assert full.score == 1.0


def test_negation_belongs_to_its_word():
    """«Не» где-то в тексте не делает факт отрицательным: «огонь из окна, соседка не
    открывает» — не «огня нет»; «без сознания» — не «в сознании»."""
    fire = _evaluate_fire(description="Огонь из окна, соседка не открывает.")["description"]
    assert "открытого огня нет" in fire.explanation
    assert mentions("Огня я не вижу, только дым.", ["огня не видит", "огня не"])

    heart = _scenario("heart_attack_home")
    conscious = next(f for f in heart["description_facts"] if f["title"] == "в сознании, дышит")
    assert not mentions("Без сознания, не дышит.", conscious["synonyms"])
    assert mentions("В сознании, дышит часто.", conscious["synonyms"])
    # Отрицание не перескакивает через запятую: «связи нет, погас свет».
    lift = _scenario("elevator_stuck")["escalation"]["fact"]["synonyms"]
    assert mentions("Связи нет, погас свет.", lift)


def test_optional_tag_is_neither_required_nor_penalized():
    """Решение капитана 29.09: «Нет доступа» у квартиры, запертой изнутри, — по ситуации."""
    with_tag = _evaluate_fire(tags=["victims", "gasification", "no_access"])["tags"]
    assert with_tag.score == 1.0
    assert _evaluate_fire()["tags"].score == 1.0
    # Обязательные теги по-прежнему нужны, лишний не спорный — штраф.
    assert _evaluate_fire(tags=["no_access"])["tags"].score == 0.0
    assert _evaluate_fire(tags=["victims", "gasification", "offense"])["tags"].score < 1.0


def test_street_kind_may_be_omitted_or_abbreviated_but_not_wrong():
    """«Профсоюзная» совпадала с «Профсоюзная улица», а «Кутузовский» и «Кутузовский пр-т» с
    «Кутузовский проспект» — нет: критическая ошибка адреса за верно записанную улицу."""
    for street in ("Кутузовский", "Кутузовский пр-т", "пр. Кутузовский", "кутузовский просп."):
        assert address_field_match("street", "Кутузовский проспект", street), street
    assert not address_field_match("street", "Кутузовский проспект", "Кутузовский переулок")
    assert not address_field_match("street", "Дубнинская улица", "Дубининская ул.")
    assert address_field_match("building", "2", "к2")
    assert address_field_match("apartment", "47", "кв. 47")

    scenario = _scenario("dtp_victims_fuel")
    address = {**scenario["address"], "street": "Кутузовский пр-т"}
    result = evaluate(
        scenario,
        incident_type_code=scenario["incident_type_code"],
        tags=scenario["expected_tags"],
        services=scenario["expected_services"],
        address=address,
        description=scenario["description_reference"],
        elapsed_s=90,
        caller=IDEAL_CALLER,
    )
    assert result.total == 100


def test_duplicate_incident_type_counts_as_correct():
    """Разбор капитана 29.09: «Ребенок застрял в лифте» (группа «Ребенок в опасности») — тот
    же случай, что «Застревание в лифте (ребенок без взрослых)» (ЛИФТ)."""
    scenario = _scenario("elevator_stuck")

    def criteria(code):
        result = evaluate(
            scenario,
            incident_type_code=code,
            tags=[],
            services=scenario["expected_services"],
            address=scenario["address"],
            description=scenario["description_reference"],
            elapsed_s=90,
            caller=IDEAL_CALLER,
        )
        return {criterion.key: criterion for criterion in result.criteria}

    duplicate = criteria("18100000")
    assert duplicate["incident_type"].score == 1.0
    assert "то же, что «Застревание в лифте (ребенок без взрослых)»" in (
        duplicate["incident_type"].explanation
    )
    assert duplicate["timing"].score == 1.0

    # Без признака «ребенок без взрослых» — неточно: половина балла, время не отнимается.
    generic = criteria("14100100")
    assert generic["incident_type"].score == 0.5
    assert "неточно" in generic["incident_type"].explanation
    assert generic["timing"].score == 1.0

    wrong = criteria("22370000")
    assert wrong["incident_type"].score == 0.0 and wrong["timing"].score == 0.0


def test_district_and_okrug_not_named_by_caller_are_optional():
    scenario = _scenario("fire_apartment_smoke")
    # Заявитель называет район (Западное Дегунино), но не округ.
    without_okrug = {**scenario["address"], "okrug": ""}
    assert _evaluate_fire(address=without_okrug)["address"].score == 1.0

    without_district = {**scenario["address"], "district": ""}
    assert _evaluate_fire(address=without_district)["address"].score < 1.0

    wrong_okrug = {**scenario["address"], "okrug": "ЦАО"}
    address = _evaluate_fire(address=wrong_okrug)["address"]
    assert address.score < 1.0 and "округ" in address.explanation


def test_other_scenarios_do_not_require_district_or_okrug():
    for scenario in load_scenarios():
        if scenario.get("named_address_fields"):
            continue
        address = {**scenario["address"], "okrug": "", "district": ""}
        result = evaluate(
            scenario,
            incident_type_code=scenario["incident_type_code"],
            tags=scenario["expected_tags"],
            services=scenario["expected_services"],
            address=address,
            description=scenario["description_reference"],
            elapsed_s=90,
            caller=IDEAL_CALLER,
        )
        assert result.total == 100, scenario["id"]


def test_empty_card_saved_fast_gets_no_time_points():
    """Разбор 29.09: 10 баллов за время доставались и пустой карточке, сохранённой за 2 с."""
    scenario = _scenario("fire_apartment_smoke")
    result = evaluate(
        scenario,
        incident_type_code=None,
        tags=[],
        services=[],
        address={},
        description="",
        elapsed_s=2,
        caller=CallerState(panic=1),
    )
    timing = {criterion.key: criterion for criterion in result.criteria}["timing"]
    assert timing.points == 0
    assert "тип происшествия и адрес указаны неверно" in timing.explanation


def test_time_needs_street_and_house():
    scenario = _scenario("fire_apartment_smoke")
    wrong_house = {**scenario["address"], "house": "21"}
    timing = _evaluate_fire(address=wrong_house)["timing"]
    assert timing.points == 0 and "улица или дом" in timing.explanation

    wrong_type = _evaluate_fire(incident_type_code="2020900")["timing"]
    assert wrong_type.points == 0 and "тип происшествия указан неверно" in wrong_type.explanation

    # Округ — не причина лишать баллов за время.
    no_okrug = {**scenario["address"], "okrug": ""}
    assert _evaluate_fire(address=no_okrug)["timing"].score == 1.0


def test_caller_work_counts_calming_pauses_and_escalation():
    """Этап 2: «Работа с заявителем» — успокоение просьбой с причиной, паузы, ухудшение."""
    ideal = _evaluate_fire()["caller"]
    assert ideal.score == 1.0 and "полностью успокоился" in ideal.explanation

    # Истерику не снимали просьбой с причиной, кричали «Успокойтесь!», две паузы.
    rough = _evaluate_fire(caller=CallerState(panic=2, calm_order=1, pauses=2))["caller"]
    assert rough.score < 0.4
    for words in ("просьбой с причиной", "«Успокойтесь!»", "«Алло?», — 2", "в панике"):
        assert words in rough.explanation

    # Ухудшение без нужного совета — минус, с советом — полный балл.
    missed = _evaluate_fire(caller=CallerState(panic=0, calm_reason=2, escalated=True))["caller"]
    assert missed.score < 1.0 and "не дан нужный совет" in missed.explanation
    handled = CallerState(panic=0, calm_reason=2, escalated=True, escalation_handled=True)
    assert _evaluate_fire(caller=handled)["caller"].score == 1.0


def test_escalation_fact_is_required_only_after_escalation():
    scenario = _scenario("fire_apartment_smoke")
    reference = scenario["description_reference"]
    escalated = CallerState(panic=0, calm_reason=2, escalated=True, escalation_handled=True)
    description = _evaluate_fire(description=reference, caller=escalated)["description"]
    assert "дым дошёл до лестницы" in description.explanation
    with_fact = reference + " Дым дошёл до лестничной площадки."
    assert _evaluate_fire(description=with_fact, caller=escalated)["description"].score == 1.0
    assert _evaluate_fire(description=reference)["description"].score == 1.0
