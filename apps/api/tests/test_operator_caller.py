import importlib.util
import json
from pathlib import Path

import pytest
from app.core.config import ROOT
from app.operator.caller import (
    CONFIRM_KEY,
    PANIC_HYSTERIA,
    PANIC_MAX,
    CallerState,
    act,
    address_mismatch,
    ask,
    match_question,
    start_state,
    step_progress,
    voice_lines,
)
from app.operator.scenarios import load_questionnaires, load_scenarios

VOICE_REPORT = Path(__file__).parents[3] / "data" / "voices" / "operator" / "operator-report.json"


def _scenario(scenario_id):
    return {row["id"]: row for row in load_scenarios()}[scenario_id]


def _card_keys(scenario):
    """Вопросы карты по порядку, кроме повтора адреса — на него отвечают по карточке."""
    card = load_questionnaires()[scenario["questionnaire_id"]]
    return [q["key"] for q in card["questions"] if q["key"] != CONFIRM_KEY]


def _calm_down(scenario, state):
    """Просьба с причиной подряд, пока заявитель не ниже порога паники (IAED)."""
    while state.panic >= 2:
        state, _ = act(scenario, state, "calm", kind="reason")
    return state


def test_calm_path_all_card_questions_in_order():
    for scenario in load_scenarios():
        state = CallerState(panic=1)
        for key in _card_keys(scenario):
            state, reply = ask(scenario, state, key=key)
            assert reply.outcome == "correct", (scenario["id"], key)
            assert reply.variant == "calm"
            assert reply.text == scenario["answers"][key]["calm"]
            assert reply.line == f"{key}.calm"
        assert state.panic == 0, scenario["id"]
        assert set(state.facts) == set(scenario["answers"]), scenario["id"]


def test_every_persona_calms_down_and_answers_calmly():
    """Этап 2: с паники персонажа — «Успокоить» подряд, затем вся карта спокойно."""
    for scenario in load_scenarios():
        state = _calm_down(scenario, start_state(scenario))
        for key in _card_keys(scenario):
            if key in state.facts:
                continue
            state, reply = ask(scenario, state, key=key)
            assert reply.variant == "calm", (scenario["id"], key, reply)
        assert set(state.facts) == set(scenario["answers"]), scenario["id"]
        assert state.panic <= 1, scenario["id"]


def test_hysteria_ignores_questions_until_reason_request():
    scenario = _scenario("fire_apartment_smoke")
    state = start_state(scenario)
    assert state.panic == PANIC_HYSTERIA
    for index, key in enumerate(["address", "what_happened", "victims", "address"]):
        state, reply = ask(scenario, state, key=key)
        assert reply.outcome == "unheard"
        hysteria = scenario["reactions"]["hysteria"]
        assert reply.text == hysteria[index % len(hysteria)]
    # Не услышанные вопросы не считаются заданными: после успокоения — без «уже сказала».
    assert state.asked == () and state.unheard == 4
    # Мягкая поддержка и «Успокойтесь!» истерику не снимают.
    state, reply = act(scenario, state, "calm", kind="soft")
    assert reply.outcome == "unheard" and state.panic == PANIC_HYSTERIA
    state, reply = act(scenario, state, "calm", kind="order")
    assert reply.outcome == "order" and state.calm_order == 1

    state, reply = act(scenario, state, "calm", kind="reason")
    assert (reply.outcome, state.panic) == ("calming", 2)
    state, reply = act(scenario, state, "calm", kind="reason")
    # Повтор той же просьбы: ниже порога заявительница называет адрес — спокойно.
    assert (reply.outcome, reply.question_key, reply.variant) == ("calmed", "address", "calm")
    assert state.facts == ("address",) and state.panic == 1


def test_panic_answer_then_calm_reask_is_not_a_repeat():
    """Замечание капитана 29.09: после панического ответа переспрос — уточнение, не повтор."""
    scenario = _scenario("fire_apartment_smoke")
    state, _ = act(scenario, start_state(scenario), "calm", kind="reason")
    state, reply = ask(scenario, state, key="address")
    assert reply.variant == "panic" and "Дубининская" in reply.text
    assert state.facts == () and state.asked == ("address",)
    state, reply = ask(scenario, state, key="address")
    assert (reply.outcome, reply.variant) == ("correct", "calm")
    assert "Дубнинская" in reply.text
    # Третий раз — уже «Я же уже сказала!».
    state, reply = ask(scenario, state, key="address")
    assert reply.outcome == "repeated"
    assert reply.text == scenario["reactions"]["repeat"]


def test_irrelevant_questions_lead_to_hysteria():
    scenario = _scenario("dtp_victims_fuel")
    state = CallerState(panic=1)
    for text in ["На каком этаже?", "Газовая колонка есть?"]:
        state, reply = ask(scenario, state, text=text)
        assert reply.outcome == "irrelevant"
        assert reply.text == scenario["reactions"]["irrelevant"]
    assert state.panic == PANIC_MAX
    # В истерике вопросы карты не слышны, фактов нет.
    for key in _card_keys(scenario):
        state, reply = ask(scenario, state, key=key)
        assert reply.outcome == "unheard"
    assert state.facts == ()


def test_repeated_questions_raise_panic():
    scenario = _scenario("dtp_victims_fuel")
    state, _ = ask(scenario, CallerState(), key="address")
    state, _ = ask(scenario, state, key="victims")
    assert state.panic == 0
    state, reply = ask(scenario, state, key="victims")
    assert reply.outcome == "repeated" and state.panic == 1


def test_questions_before_address_are_early():
    """Этап 3: без адреса помощь не отправить — вопрос шагов 2–5 раньше адреса злит заявителя,
    но ответ звучит (в том состоянии, в каком спросили)."""
    scenario = _scenario("dtp_victims_fuel")
    state, reply = ask(scenario, CallerState(), key="victims")
    assert (reply.outcome, reply.variant, state.panic) == ("early", "calm", 2)
    assert state.asked == ("victims",) and state.facts == ("victims",)
    state, reply = ask(scenario, state, key="callback")
    assert (reply.outcome, reply.variant, state.panic) == ("early", "panic", 3)

    # Вопросы шага 1 — в любое время; после адреса остальные шаги — по порядку.
    state, reply = ask(scenario, CallerState(), key="landmark")
    assert reply.outcome == "correct" and state.panic == 0
    state, _ = ask(scenario, state, key="address")
    state, reply = ask(scenario, state, key="fuel")
    assert reply.outcome == "correct"


def test_address_after_calming_counts_as_asked():
    """Адрес, названный после «Успокоить» с причиной, — тоже адрес: дальше вопросы не ранние."""
    scenario = _scenario("fire_apartment_smoke")
    state = _calm_down(scenario, start_state(scenario))
    assert state.asked == ("address",)
    state, reply = ask(scenario, state, key="what_happened")
    assert reply.outcome == "correct"


CARD_ADDRESS = {"street": "Дубнинская улица", "house": "12", "building": "", "apartment": "47"}


def test_confirm_address_answers_by_card_address():
    """Этап 3: повтор адреса вслух — заявитель сверяет адрес карточки с тем, что знает."""
    scenario = _scenario("fire_apartment_smoke")
    lines = scenario["address_confirmation"]
    calm = CallerState(panic=1, asked=("address",))

    state, reply = ask(scenario, calm, key=CONFIRM_KEY)
    assert (reply.outcome, reply.text, reply.line) == (
        "unconfirmed",
        lines["empty"],
        "confirm.empty",
    )
    assert state == calm

    trap = {**CARD_ADDRESS, "street": "Дубининская улица"}
    state, reply = ask(scenario, calm, key=CONFIRM_KEY, address=trap)
    assert (reply.outcome, reply.line, state.panic) == ("corrected", "confirm.wrong_street", 1)
    assert not state.confirmed

    no_flat = {**CARD_ADDRESS, "apartment": ""}
    _, reply = ask(scenario, calm, key=CONFIRM_KEY, address=no_flat)
    assert (reply.outcome, reply.line) == ("corrected", "confirm.wrong_details")

    # «ул. Дубнинская» — та же улица: сравнение как в оценке адреса.
    same = {**CARD_ADDRESS, "street": "ул. Дубнинская"}
    state, reply = ask(scenario, calm, key=CONFIRM_KEY, address=same)
    assert (reply.outcome, reply.text, state.panic) == ("confirmed", lines["ok"], 0)
    assert state.confirmed and state.asked == ("address",)
    assert reply.question_key == CONFIRM_KEY

    # В панике «да» ненадёжно, в истерике повтор не слышен.
    state, reply = ask(scenario, CallerState(panic=2), key=CONFIRM_KEY, address=CARD_ADDRESS)
    assert (reply.outcome, reply.line, state.confirmed) == ("unconfirmed", "confirm.panic", False)
    _, reply = ask(scenario, CallerState(panic=3), key=CONFIRM_KEY, address=CARD_ADDRESS)
    assert reply.outcome == "unheard"


def test_confirm_checks_only_details_the_caller_knows():
    # На проспекте квартиры нет: улица и дом — достаточно.
    dtp = _scenario("dtp_victims_fuel")
    assert address_mismatch(dtp, {"street": "Кутузовский проспект", "house": "34"}) is None
    assert address_mismatch(dtp, {"street": "Кутузовский проспект", "house": ""}) == "details"
    # Ребёнок знает дом и корпус по табличке: корпус не записан — поправит.
    child = _scenario("elevator_stuck")
    address = {"street": "Новочерёмушкинская улица", "house": "8", "building": ""}
    assert address_mismatch(child, address) == "details"
    assert address_mismatch(child, {**address, "building": "2"}) is None
    assert address_mismatch(child, {"street": "  "}) == "empty"


@pytest.mark.parametrize("panic", [0, 1, 2, 3])
def test_empty_address_is_repeated_even_in_panic(panic):
    scenario = _scenario("fire_apartment_smoke")
    state, reply = ask(
        scenario, CallerState(panic=panic), key=CONFIRM_KEY, address={"street": "  "}
    )
    assert reply.outcome == ("unheard" if panic == 3 else "unconfirmed")
    if panic < 3:
        assert reply.line == "confirm.empty"
        assert reply.text == scenario["address_confirmation"]["empty"]
    assert not state.confirmed and state.panic == panic


def test_free_text_confirm_uses_card_address():
    """«Сложно»: свой повтор адреса узнаётся по синонимам и сверяется с карточкой."""
    scenario = _scenario("fire_apartment_smoke")
    calm = CallerState(panic=1, asked=("address",))
    text = "Проверю адрес: Дубнинская, дом 12, квартира 47. Верно?"
    state, reply = ask(scenario, calm, text=text, address=CARD_ADDRESS)
    assert reply.outcome == "confirmed" and state.confirmed


def test_distractor_gets_own_reply_and_raises_panic():
    scenario = _scenario("fire_apartment_smoke")
    item = next(d for d in scenario["distractors"] if d["key"] == "home_phone")
    state, reply = act(scenario, CallerState(panic=1), "question", distractor="home_phone")
    assert (reply.outcome, reply.text, reply.line) == (
        "irrelevant",
        item["reply"],
        "distractor.home_phone",
    )
    assert state.panic == 2 and state.asked == () and reply.question_key == "home_phone"
    _, reply = act(scenario, CallerState(panic=3), "question", distractor="home_phone")
    assert reply.outcome == "unheard"
    with pytest.raises(ValueError):
        act(scenario, CallerState(), "question", distractor="nope")


def test_step_progress_follows_heard_questions():
    """Шаг пройден, когда заявитель услышал все вопросы карты шага; повтор адреса — когда
    адрес подтверждён; лишние вопросы шаг не проходят."""
    scenario = _scenario("fire_apartment_smoke")
    state = CallerState(panic=1)
    assert step_progress(scenario, state) == step_progress(scenario, state)
    progress = step_progress(scenario, state)
    assert (progress.step, progress.done) == (1, ())
    for key in ("address", "landmark"):
        state, _ = ask(scenario, state, key=key)
    assert step_progress(scenario, state).done == ()
    state, _ = ask(scenario, state, key=CONFIRM_KEY, address=CARD_ADDRESS)
    progress = step_progress(scenario, state)
    assert (progress.step, progress.done) == (2, (1,))
    state, _ = act(scenario, state, "question", distractor="home_phone")
    assert step_progress(scenario, state).done == (1,)
    # Шаг 4 пройден раньше 2 и 3 — текущим остаётся первый не пройденный.
    for key in ("victims", "self_safety"):
        state, _ = ask(scenario, state, key=key)
    progress = step_progress(scenario, state)
    assert (progress.step, progress.done) == (2, (1, 4))
    for key in ("callback", "name", "what_happened", "since", "floor", "access", "gas"):
        state, _ = ask(scenario, state, key=key)
    progress = step_progress(scenario, state)
    assert (progress.step, progress.done) == (5, (1, 2, 3, 4, 5))


# «Сложно»: свой вопрос словами узнаётся как новый вопрос карты этапа 3.
FREE_TEXT = {
    "fire_apartment": {
        "Это ваш номер телефона?": "callback",
        "Если связь прервётся, я перезвоню": "callback",
        "Как вас зовут?": "name",
        "Что рядом с домом?": "landmark",
        "Какой ориентир?": "landmark",
        "Повторите адрес, пожалуйста": CONFIRM_KEY,
        "Давно идёт дым?": "since",
        "Вы сами в безопасности?": "self_safety",
        "Какой подъезд и этаж?": "floor",
        "Рядом есть газ?": "gas",
    },
    "dtp_victims": {
        "Когда это случилось?": "when",
        "Сможете встретить скорую?": "meet",
        "Что рядом, какой ориентир?": "landmark",
        "Где произошла авария?": "address",
    },
    "medical": {
        "Подъезд, этаж, код домофона?": "access",
        "Лифт работает?": "lift",
        "Вы одна дома?": "alone",
        "Назовите адрес": "address",
    },
    "elevator": {
        "Какой подъезд?": "entrance",
        "Как тебя зовут?": "name",
        "Кто встретит мастера?": "adults",
        "Что написано на табличке?": "landmark",
    },
}


def test_free_text_new_questions_are_recognized():
    for card_id, phrases in FREE_TEXT.items():
        card = load_questionnaires()[card_id]
        for text, key in phrases.items():
            assert match_question(text, card) == key, (card_id, text)


def test_voice_layout_matches_server_lines():
    """Раскладка озвучки (scripts/voices/operator_texts.py) — те же ключи и тексты, что у
    заявителя на сервере: иначе новая реплика этапа 3 останется без голоса."""
    source = importlib.util.spec_from_file_location(
        "operator_texts", ROOT / "scripts" / "voices" / "operator_texts.py"
    )
    assert source is not None and source.loader is not None
    module = importlib.util.module_from_spec(source)
    source.loader.exec_module(module)
    for scenario in load_scenarios():
        layout = {row["line"]: row["text"] for row in module.lines_for(scenario)}
        assert layout == voice_lines(scenario), scenario["id"]
        assert {"confirm.ok", "confirm.wrong_street", "confirm.panic"} <= set(layout)
        assert f"distractor.{scenario['distractors'][0]['key']}" in layout


def test_free_text_synonyms_and_normalization():
    scenario = _scenario("dtp_victims_fuel")
    questionnaire = load_questionnaires()["dtp_victims"]
    assert match_question("Скажите, где случилась АВАРИЯ?", questionnaire) == "address"
    assert match_question("Кто-нибудь ранен?", questionnaire) == "victims"
    assert match_question("Чувствуете запах бензина?", questionnaire) == "fuel"
    assert match_question("Все живы? Всё ли в порядке?", questionnaire) == "victims"
    elevator = load_questionnaires()["elevator"]
    assert match_question("Сколько людей в кабине?", elevator) == "how_many"
    assert match_question("Между какими этажами застряли?", elevator) == "floor"
    assert match_question("Что рядом с домом?", elevator) == "landmark"

    state, reply = ask(scenario, CallerState(), text="Где произошла авария?")
    assert reply.outcome == "correct" and reply.question_key == "address"
    assert state.panic == 0 and state.facts == ("address",)


def test_not_understood_asks_again_and_raises_panic():
    scenario = _scenario("dtp_victims_fuel")
    state, reply = ask(scenario, CallerState(), text="Какая сегодня погода?")
    assert reply.outcome == "not_understood"
    assert reply.text == scenario["reactions"]["not_understood"]
    assert state.panic == 2 and state.facts == ()


def test_pause_hold_escalation_and_advice():
    scenario = _scenario("elevator_stuck")
    state = CallerState(panic=1)
    state, reply = act(scenario, state, "hold")
    assert (reply.outcome, reply.text, state.panic) == ("hold", scenario["reactions"]["hold"], 1)
    state, reply = act(scenario, state, "silence")
    assert (reply.outcome, reply.line, state.pauses, state.panic) == ("silence", "pause.0", 1, 1)
    assert state.silence_streak == 1
    state, reply = act(scenario, state, "silence")
    assert (reply.line, state.pauses, state.panic) == ("pause.1", 2, 2)
    state, reply = act(scenario, state, "silence")
    assert (state.pauses, state.silence_streak, state.panic) == (3, 3, 3)

    state = CallerState(panic=0)
    state, reply = act(scenario, state, "escalate")
    assert reply.outcome == "escalation" and state.escalated and state.panic == 2
    state, again = act(scenario, state, "escalate")
    assert again.outcome == "noop" and again.line is None
    # Совет не на ухудшение не закрывает его; нужный — закрывает.
    state, reply = act(scenario, state, "advice", kind="light")
    assert reply.outcome == "advice" and not state.escalation_handled
    state, reply = act(scenario, state, "advice", kind="stay")
    assert state.escalation_handled and state.advice == ("light", "stay")


@pytest.mark.parametrize("panic", [1, 3])
@pytest.mark.parametrize(
    "action,kwargs",
    [
        ("question", {"key": "address"}),
        ("calm", {"kind": "reason"}),
        ("hold", {}),
        ("advice", {"kind": "stay"}),
    ],
)
def test_operator_action_resets_silence_streak_even_if_unheard(panic, action, kwargs):
    scenario = _scenario("elevator_stuck")
    state, _ = act(scenario, CallerState(panic=panic), "silence")
    assert state.silence_streak == 1
    state, _ = act(scenario, state, action, **kwargs)
    assert state.silence_streak == 0 and state.pauses == 1
    before = state.panic
    state, _ = act(scenario, state, "silence")
    assert (state.panic, state.pauses, state.silence_streak) == (before, 2, 1)


def test_escalation_does_not_reset_silence_streak():
    scenario = _scenario("elevator_stuck")
    state, _ = act(scenario, CallerState(panic=0), "silence")
    state, _ = act(scenario, state, "escalate")
    assert state.silence_streak == 1
    state, _ = act(scenario, state, "silence")
    assert state.panic == 3 and state.silence_streak == 2


def test_same_actions_same_result():
    scenario = _scenario("fire_apartment_smoke")
    actions = [
        ("question", "Где горит?", None),
        ("calm", None, "reason"),
        ("question", "Что-то непонятное", None),
        ("calm", None, "reason"),
        ("silence", None, None),
        ("question", "Какой этаж?", None),
        ("advice", None, "leave"),
    ]

    def run():
        state, replies = start_state(scenario), []
        for action, text, kind in actions:
            state, reply = act(scenario, state, action, text=text, kind=kind)
            replies.append(reply)
        return state, replies

    assert run() == run()


def test_wrong_call_has_no_incident():
    # Ошибочный звонок сейчас вне ротации (data/operator/archive/), но схема его допускает:
    # без опросной карты заявителю не о чем рассказывать.
    scenario = {"id": "wrong_call", "questionnaire_id": None}
    state, reply = ask(scenario, CallerState(), text="Что у вас случилось?")
    assert reply.outcome == "no_incident" and state == CallerState()


def test_voice_lines_are_voiced_with_current_texts():
    """Каждая реплика, которую может вернуть заявитель, озвучена — и текстом, который сейчас в
    сценарии (scripts/voices/operator_generate.sh пересобирает файлы после правок)."""
    report = json.loads(VOICE_REPORT.read_text(encoding="utf-8"))
    for scenario in load_scenarios():
        voiced = report["lines"][scenario["id"]]
        for line, text in voice_lines(scenario).items():
            assert line in voiced, (scenario["id"], line)
            assert voiced[line]["text"] == text, (scenario["id"], line)
