import asyncio

from app.core.db import Database
from app.core.models import Setting
from app.operator.caller import CONFIRM_KEY, CallerState, act, mentions
from app.operator.scenarios import expected_services, load_questionnaires, load_scenarios
from app.operator.seed import (
    QUESTIONNAIRE_KEY_PREFIX,
    SCENARIO_KEY_PREFIX,
    seed_operator_scenarios,
)
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

ARCHIVED_KEY = f"{SCENARIO_KEY_PREFIX}gas_smell_entrance"


def test_four_scenarios_load_and_validate():
    """Решение капитана 29.09: по сценарию на персонажа, остальные — data/operator/archive/."""
    scenarios = load_scenarios()
    assert {row["id"] for row in scenarios} == {
        "fire_apartment_smoke",
        "dtp_victims_fuel",
        "elevator_stuck",
        "heart_attack_home",
    }
    assert set(load_questionnaires()) == {"fire_apartment", "dtp_victims", "elevator", "medical"}


def test_description_reference_covers_every_fact():
    """Эталон описания — полный звонок: оценка v2 даёт ему все факты сценария."""
    for scenario in load_scenarios():
        assert 1 <= len(scenario["description_facts"]) <= 8, scenario["id"]
        for fact in scenario["description_facts"]:
            assert mentions(scenario["description_reference"], fact["synonyms"]), (
                scenario["id"],
                fact["title"],
            )


def test_named_address_fields_are_really_named_by_caller():
    for scenario in load_scenarios():
        calm = " ".join(answer["calm"] for answer in scenario["answers"].values())
        for field in scenario.get("named_address_fields", []):
            value = scenario["address"][field]
            assert value and mentions(calm, [value]), (scenario["id"], field)


def test_address_trap_dubninskaya_is_present():
    by_id = {row["id"]: row for row in load_scenarios()}
    assert by_id["fire_apartment_smoke"]["address"]["street"] == "Дубнинская улица"
    panic_address = by_id["fire_apartment_smoke"]["answers"]["address"]["panic"]
    assert "Дубининская" in panic_address


def test_expected_services_match_routing_rules():
    for scenario in load_scenarios():
        computed = expected_services(scenario["incident_type_code"], set(scenario["expected_tags"]))
        assert computed == set(scenario["expected_services"]), scenario["id"]


def test_accepted_incident_types_route_the_same_services():
    """Равнозначный дубль классификатора засчитывается полностью, только если по нему
    подставляются те же службы, — иначе обучаемый получит полный балл за другой вызов."""
    for scenario in load_scenarios():
        tags = set(scenario["expected_tags"])
        for code in scenario.get("accepted_incident_type_codes", []):
            assert expected_services(code, tags) == set(scenario["expected_services"]), (
                scenario["id"],
                code,
            )
    by_id = {row["id"]: row for row in load_scenarios()}
    assert "18100000" in by_id["elevator_stuck"]["accepted_incident_type_codes"]


def test_optional_tags_do_not_change_services():
    """Спорный тег не штрафуется, только если службы с ним те же, — иначе обучаемый без штрафа
    отправит лишнюю службу."""
    for scenario in load_scenarios():
        tags = set(scenario["expected_tags"])
        for tag in scenario.get("optional_tags", []):
            with_tag = expected_services(scenario["incident_type_code"], tags | {tag})
            assert with_tag == set(scenario["expected_services"]), (scenario["id"], tag)
    by_id = {row["id"]: row for row in load_scenarios()}
    assert by_id["fire_apartment_smoke"]["optional_tags"] == ["no_access"]
    assert by_id["heart_attack_home"]["optional_tags"] == ["victims"]


def test_answers_cover_every_questionnaire_question():
    questionnaires = load_questionnaires()
    for scenario in load_scenarios():
        questionnaire_id = scenario["questionnaire_id"]
        if questionnaire_id is None:
            assert scenario["answers"] == {}
            continue
        # На повтор адреса отвечают по карточке — address_confirmation, а не answers.
        keys = {q["key"] for q in questionnaires[questionnaire_id]["questions"]} - {CONFIRM_KEY}
        assert set(scenario["answers"]) == keys, scenario["id"]
        for answer in scenario["answers"].values():
            assert answer["calm"] and answer["panic"]
        assert scenario["address_confirmation"]["ok"], scenario["id"]


def test_every_card_follows_the_call_standard():
    """Этап 3 (APCO/NENA): у каждой карты все пять шагов; адрес, его повтор и ориентир — на
    шаге 1, номер для обратной связи и имя — на шаге 2."""
    for card in load_questionnaires().values():
        steps = {q["key"]: q["step"] for q in card["questions"]}
        assert set(steps.values()) == {1, 2, 3, 4, 5}, card["id"]
        for key, step in {
            "address": 1,
            CONFIRM_KEY: 1,
            "landmark": 1,
            "callback": 2,
            "name": 2,
        }.items():
            assert steps.get(key) == step, (card["id"], key)
        # Порядок в карте — по шагам: так же идут вкладки на экране.
        order = [q["step"] for q in card["questions"]]
        assert order == sorted(order), card["id"]
        confirm = next(q for q in card["questions"] if q["key"] == CONFIRM_KEY)
        assert "{address}" in confirm["text"], card["id"]


def test_each_step_offers_three_or_four_plausible_options():
    """Этап 3: на экране — вопросы текущего шага: вопросы карты и лишние вопросы того же шага,
    всего 3–4, и хотя бы один лишний — иначе не из чего выбирать."""
    for scenario in load_scenarios():
        card = load_questionnaires()[scenario["questionnaire_id"]]
        for step in (1, 2, 3, 4, 5):
            own = [q for q in card["questions"] if q["step"] == step]
            extra = [d for d in scenario["distractors"] if d["step"] == step]
            assert 3 <= len(own) + len(extra) <= 4, (scenario["id"], step)
            assert extra, (scenario["id"], step)


def test_distractors_are_not_questions_of_other_incidents():
    """Лишние вопросы — правдоподобные для своего шага, а не вопросы чужих карт («Сколько
    человек в кабине?» при пожаре — разбор 29.09, п. 6); ответ — в манере персонажа."""
    every_question = {
        q["text"] for card in load_questionnaires().values() for q in card["questions"]
    }
    for scenario in load_scenarios():
        for item in scenario["distractors"]:
            assert item["text"] not in every_question, (scenario["id"], item["key"])
            assert item["reply"] and item["reply"] != scenario["reactions"]["irrelevant"]


def test_full_address_can_be_collected():
    """Замечание капитана 29.09: вопросов хватает, чтобы собрать полный адрес — квартира,
    подъезд, этаж, код домофона и ориентир; у ДТП на проспекте — дом и ориентир."""
    needs = {
        "fire_apartment_smoke": ("квартир", "подъезд", "этаж", "домофон"),
        "heart_attack_home": ("квартир", "подъезд", "этаж", "домофон"),
        "elevator_stuck": ("подъезд", "этаж", "табличке"),
        "dtp_victims_fuel": ("тридцать четыре", "остановка"),
    }
    for scenario in load_scenarios():
        calm = " ".join(answer["calm"] for answer in scenario["answers"].values()).lower()
        for word in needs[scenario["id"]]:
            assert word in calm, (scenario["id"], word)
        assert "landmark" in scenario["answers"], scenario["id"]


def test_reference_order_starts_with_address():
    """Эталонный порядок для разбора — по шагам: адрес (или успокоение ради адреса) первым."""
    for scenario in load_scenarios():
        first = scenario["reference_order"][0].lower()
        assert "адрес" in first, scenario["id"]
        assert any("повтор" in line.lower() for line in scenario["reference_order"])


def test_seed_operator_scenarios_is_idempotent(database_url):
    async def run():
        database = Database(database_url)
        try:
            async with database.sessions.begin() as db:
                # Сценарий, загруженный до того, как его убрали из ротации.
                await db.execute(
                    insert(Setting)
                    .values(key=ARCHIVED_KEY, value={"id": "gas_smell_entrance"}, updated_by=None)
                    .on_conflict_do_nothing()
                )
            async with database.sessions.begin() as db:
                first = await seed_operator_scenarios(db)
            async with database.sessions.begin() as db:
                second = await seed_operator_scenarios(db)
            async with database.sessions.begin() as db:
                rows = list(
                    await db.scalars(
                        select(Setting).where(
                            Setting.key.like(f"{SCENARIO_KEY_PREFIX}%")
                            | Setting.key.like(f"{QUESTIONNAIRE_KEY_PREFIX}%")
                        )
                    )
                )
            return first, second, rows
        finally:
            await database.close()

    first, second, rows = asyncio.run(run())
    assert sorted(first) == sorted(second)
    assert len(rows) == len(load_scenarios()) + len(load_questionnaires())
    by_key = {row.key: row.value for row in rows}
    assert ARCHIVED_KEY not in by_key
    for scenario in load_scenarios():
        assert by_key[f"{SCENARIO_KEY_PREFIX}{scenario['id']}"] == scenario


def test_distractors_anger_the_caller():
    """Лишний вопрос шага — не по делу: заявитель отвечает своей репликой и паникует сильнее."""
    for scenario in load_scenarios():
        for item in scenario["distractors"]:
            state, reply = act(scenario, CallerState(), "question", distractor=item["key"])
            assert (reply.outcome, reply.text) == ("irrelevant", item["reply"]), item["key"]
            assert state.panic == 2


def test_four_personas_with_live_call():
    """Этап 2: по сценарию на персонажа; у каждого — ухудшение и советы."""
    kinds = {row["persona"]["kind"]: row["id"] for row in load_scenarios()}
    assert kinds == {
        "young_woman": "fire_apartment_smoke",
        "adult": "dtp_victims_fuel",
        "elderly": "heart_attack_home",
        "child": "elevator_stuck",
    }
    for scenario in load_scenarios():
        escalation = scenario["escalation"]
        # Ухудшение приносит новый факт — его нет в эталоне до ухудшения.
        assert not mentions(scenario["description_reference"], escalation["fact"]["synonyms"]), (
            scenario["id"]
        )
        assert escalation["advice"] in {item["key"] for item in scenario["advice"]}


def test_girl_starts_in_hysteria_child_names_a_landmark():
    by_id = {row["id"]: row for row in load_scenarios()}
    assert by_id["fire_apartment_smoke"]["start_panic"] == 3
    child = by_id["elevator_stuck"]
    # Ребёнок не знает номера дома — его даёт ориентир с табличкой.
    assert "не помню" in child["answers"]["address"]["calm"]
    assert "восемь, корпус два" in child["answers"]["landmark"]["calm"]
