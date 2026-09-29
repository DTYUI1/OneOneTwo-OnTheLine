"""Этап 3: пометки разбора звонка — помогло, навредило, внимание (app/operator/review.py)."""

from app.operator.caller import CONFIRM_KEY, CallerState, act, ask, start_state
from app.operator.review import mark_for
from app.operator.scenarios import load_scenarios

CARD_ADDRESS = {"street": "Дубнинская улица", "house": "12", "building": "", "apartment": "47"}


def _scenario(scenario_id):
    return {row["id"]: row for row in load_scenarios()}[scenario_id]


def _mark(scenario, state, action="question", **kwargs):
    after, reply = act(scenario, state, action, **kwargs)
    return after, mark_for(action, state, after, reply)


def test_girl_call_marks_follow_the_prototype():
    """Звонок девушки как в прототипе: истерика, просьба с причиной, адрес в панике, повтор
    адреса ловит «Дубининскую», подтверждение."""
    girl = _scenario("fire_apartment_smoke")
    state = start_state(girl)
    state, mark = _mark(girl, state, key="address")
    assert mark is not None and mark.kind == "bad" and "в истерике" in mark.text
    state, mark = _mark(girl, state, "calm", kind="reason")
    assert mark is not None and mark.kind == "good" and "Повторите её подряд" in mark.text
    state, mark = _mark(girl, state, key="address")
    assert mark is not None and mark.kind == "warn" and "в панике" in mark.text
    trap = {**CARD_ADDRESS, "street": "Дубининская улица"}
    state, mark = _mark(girl, state, key=CONFIRM_KEY, address=trap)
    assert mark is not None and mark.kind == "good" and "поймал ошибку" in mark.text
    state, mark = _mark(girl, state, key=CONFIRM_KEY, address=CARD_ADDRESS)
    assert mark is not None and mark.kind == "good" and "подтверждён повтором" in mark.text
    state, mark = _mark(girl, state, distractor="door_color")
    assert mark is not None and mark.kind == "bad" and "не по делу" in mark.text


def test_calming_marks():
    girl = _scenario("fire_apartment_smoke")
    state, _ = act(girl, start_state(girl), "calm", kind="reason")
    # Повтор той же просьбы — ниже порога, заявительница называет адрес.
    _, mark = _mark(girl, state, "calm", kind="reason")
    assert mark is not None and "назвал адрес" in mark.text
    # Уже спокоен — событие, а не заслуга.
    _, mark = _mark(girl, CallerState(panic=0), "calm", kind="soft")
    assert mark is not None and mark.kind == "info"
    _, mark = _mark(girl, CallerState(panic=2, facts=("address",)), "calm", kind="soft")
    assert mark is not None and mark.kind == "good"
    _, mark = _mark(girl, CallerState(panic=1), "calm", kind="order")
    assert mark is not None and mark.kind == "bad" and "«Успокойтесь!»" in mark.text


def test_hysteria_explains_what_was_not_heard():
    girl = _scenario("fire_apartment_smoke")
    hysteria = start_state(girl)
    texts = {}
    for action, kwargs in (
        ("question", {"key": "victims"}),
        ("hold", {}),
        ("advice", {"kind": "leave"}),
        ("calm", {"kind": "soft"}),
    ):
        _, mark = _mark(girl, hysteria, action, **kwargs)
        assert mark is not None and mark.kind == "bad", action
        texts[action] = mark.text
    assert len(set(texts.values())) == 4


def test_order_pause_escalation_and_advice_marks():
    dtp = _scenario("dtp_victims_fuel")
    _, mark = _mark(dtp, CallerState(), key="victims")
    assert mark is not None and mark.kind == "bad" and "Адреса ещё нет" in mark.text
    state, _ = ask(dtp, CallerState(), key="address")
    _, mark = _mark(dtp, state, key="victims")
    assert mark is not None and mark.kind == "good"
    _, mark = _mark(dtp, state, "silence")
    assert mark is not None and mark.kind == "bad" and "Слышу, записываю" in mark.text
    _, mark = _mark(dtp, state, "hold")
    assert mark is not None and mark.kind == "good"
    escalated, mark = _mark(dtp, state, "escalate")
    assert mark is not None and mark.kind == "warn"
    _, mark = _mark(dtp, escalated, "advice", kind="away")
    assert mark is not None and "на ухудшение" in mark.text
    _, mark = _mark(dtp, state, "advice", kind="keep_still")
    assert mark is not None and mark.text == "Совет безопасности дан."
    _, mark = _mark(dtp, escalated, "escalate")
    assert mark is None


def test_unconfirmed_marks_say_what_to_do():
    girl = _scenario("fire_apartment_smoke")
    _, mark = _mark(girl, CallerState(panic=1), key=CONFIRM_KEY)
    assert mark is not None and mark.kind == "warn" and "внесите адрес" in mark.text
    _, mark = _mark(girl, CallerState(panic=2), key=CONFIRM_KEY, address=CARD_ADDRESS)
    assert mark is not None and mark.kind == "warn" and "«да» ненадёжно" in mark.text


def test_every_outcome_of_a_call_has_a_mark():
    """В разборе у каждого ответа заявителя есть пометка, кроме пустого noop."""
    for scenario in load_scenarios():
        state = CallerState(panic=1)
        for action, kwargs in (
            ("question", {"text": "Какая сегодня погода?"}),
            ("question", {"key": "address"}),
            ("question", {"key": "address"}),
            ("question", {"distractor": scenario["distractors"][0]["key"]}),
            ("hold", {}),
            ("silence", {}),
            ("escalate", {}),
            ("advice", {"kind": scenario["escalation"]["advice"]}),
        ):
            state, mark = _mark(scenario, state, action, **kwargs)
            assert mark is not None and mark.text, (scenario["id"], action, kwargs)
