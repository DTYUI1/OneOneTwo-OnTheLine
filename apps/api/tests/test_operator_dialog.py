from .test_lifecycle import login

SCENARIO = "fire_apartment_smoke"
CARD = "fire_apartment"
CALM = {"panic": 1, "asked": [], "facts": []}


def _ask(client, headers, state, **action):
    body = _ask_full(client, headers, state, **action)
    return body["state"], body["reply"]


def _ask_full(client, headers, state, **action):
    body = {"scenario_id": SCENARIO, **action}
    if state is not None:
        body["state"] = state
    response = client.post("/api/operator/ask", json=body, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_ask_requires_login(database_client):
    response = database_client.post(
        "/api/operator/ask", json={"scenario_id": SCENARIO, "text": "Где горит?"}
    )
    assert response.status_code == 401


def test_call_starts_in_hysteria_and_calming_twice_gives_address(database_client):
    headers = login(database_client, "trainee01")
    # Без состояния — начало звонка: девушка в истерике и вопроса не слышит.
    state, reply = _ask(database_client, headers, None, questionnaire_id=CARD, key="address")
    assert reply["outcome"] == "unheard"
    assert reply["voice"] == f"{SCENARIO}/hysteria.0"
    assert state["panic"] == 3 and state["asked"] == [] and state["unheard"] == 1

    state, reply = _ask(database_client, headers, state, action="calm", kind="reason")
    assert (reply["outcome"], state["panic"]) == ("calming", 2)
    assert reply["voice"] == f"{SCENARIO}/calming"
    state, reply = _ask(database_client, headers, state, action="calm", kind="reason")
    assert (reply["outcome"], reply["variant"], state["panic"]) == ("calmed", "calm", 1)
    assert "Дубнинская" in reply["text"]
    assert state["facts"] == ["address"] and state["calm_reason"] == 2


def test_right_questions_calm_irrelevant_panic(database_client):
    headers = login(database_client, "trainee01")
    state = CALM
    for key in ("address", "what_happened", "victims"):
        state, reply = _ask(database_client, headers, state, questionnaire_id=CARD, key=key)
        assert (reply["outcome"], reply["variant"]) == ("correct", "calm")
        assert reply["voice"] == f"{SCENARIO}/{key}.calm"
    assert state["facts"] == ["address", "what_happened", "victims"]

    # Лишний вопрос поднимает панику до порога: адрес звучит в панике — «Дубининская».
    state, reply = _ask(database_client, headers, CALM, text="Сколько человек в кабине?")
    assert reply["outcome"] == "irrelevant"
    state, reply = _ask(database_client, headers, state, questionnaire_id=CARD, key="address")
    assert (reply["outcome"], reply["variant"]) == ("correct", "panic")
    assert "Дубининская" in reply["text"]
    assert state["facts"] == [] and state["asked"] == ["address"]


def test_pause_escalation_and_advice(database_client):
    headers = login(database_client, "trainee01")
    state, reply = _ask(database_client, headers, CALM, action="silence")
    assert (reply["outcome"], state["pauses"], state["panic"]) == ("silence", 1, 1)
    assert state["silence_streak"] == 1
    assert reply["voice"] == f"{SCENARIO}/pause.0"
    assert reply["mark"]["kind"] == "bad"
    state, _ = _ask(database_client, headers, state, action="silence")
    assert (state["panic"], state["silence_streak"]) == (2, 2)
    state, _ = _ask(database_client, headers, state, action="hold")
    assert state["silence_streak"] == 0
    state, _ = _ask(database_client, headers, state, action="silence")
    assert (state["panic"], state["pauses"], state["silence_streak"]) == (2, 3, 1)

    state, reply = _ask(database_client, headers, CALM, action="escalate")
    assert reply["outcome"] == "escalation" and state["escalated"] is True
    assert state["panic"] == 2
    _, again = _ask(database_client, headers, state, action="escalate")
    assert again["outcome"] == "noop" and again["voice"] is None

    state, reply = _ask(database_client, headers, state, action="advice", kind="smoke")
    assert reply["outcome"] == "advice" and state["escalation_handled"] is True
    assert reply["voice"] == f"{SCENARIO}/advice.smoke"


def test_steps_marks_and_address_readback(database_client):
    """Этап 3: ответ несёт пометку для разбора и ход шагов; повтор адреса сверяется с
    адресом карточки, который присылает экран."""
    headers = login(database_client, "trainee01")
    body = _ask_full(database_client, headers, None, questionnaire_id=CARD, key="address")
    assert body["progress"] == {"step": 1, "done": []}
    assert body["reply"]["mark"]["kind"] == "bad"
    assert body["state"]["confirmed"] is False

    state = {**CALM, "asked": ["address", "landmark"]}
    trap = {"street": "Дубининская улица", "house": "12", "apartment": "47"}
    body = _ask_full(
        database_client, headers, state, questionnaire_id=CARD, key="confirm_address", address=trap
    )
    assert body["reply"]["outcome"] == "corrected"
    assert body["reply"]["voice"] == f"{SCENARIO}/confirm.wrong_street"
    assert body["progress"]["done"] == []

    right = {**trap, "street": "Дубнинская улица"}
    body = _ask_full(
        database_client, headers, state, questionnaire_id=CARD, key="confirm_address", address=right
    )
    assert body["reply"]["outcome"] == "confirmed" and body["state"]["confirmed"] is True
    assert body["reply"]["mark"]["kind"] == "good"
    assert body["progress"] == {"step": 2, "done": [1]}


def test_distractor_is_asked_by_key(database_client):
    headers = login(database_client, "trainee01")
    state, reply = _ask(database_client, headers, CALM, distractor="door_color")
    assert (reply["outcome"], reply["question_key"]) == ("irrelevant", "door_color")
    assert reply["voice"] == f"{SCENARIO}/distractor.door_color"
    assert state["panic"] == 2


def test_bad_actions_are_rejected(database_client):
    headers = login(database_client, "trainee01")
    for body in (
        {"action": "calm"},
        {"action": "calm", "kind": "shout"},
        {"action": "advice"},
        {"action": "advice", "kind": "nope"},
        {"distractor": "nope"},
        {"text": "Где горит?", "distractor": "door_color"},
        {"questionnaire_id": CARD, "key": "address", "distractor": "door_color"},
        {"text": "Где горит?", "address": {"street": "x" * 201}},
    ):
        response = database_client.post(
            "/api/operator/ask",
            json={"scenario_id": SCENARIO, "state": CALM, **body},
            headers=headers,
        )
        assert response.status_code == 422, body


def test_hint_from_other_card_is_asked_as_text(database_client):
    headers = login(database_client, "trainee01")
    _, reply = _ask(database_client, headers, CALM, questionnaire_id="elevator", key="floor")
    # «Этаж» есть и в карте пожара — вопрос по смыслу уместен.
    assert reply["question_key"] == "floor"
    response = database_client.post(
        "/api/operator/ask",
        json={"scenario_id": SCENARIO, "questionnaire_id": CARD, "key": "nope"},
        headers=headers,
    )
    assert response.status_code == 422
