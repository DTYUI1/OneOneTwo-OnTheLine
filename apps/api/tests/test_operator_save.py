from .test_lifecycle import login

SCENARIO = "fire_apartment_smoke"

# Истерику сняли просьбой с причиной (девушка стартует в истерике — этап 2), пауз не было;
# адрес первым и подтверждён повтором, номер для связи и ориентир уточнены (этап 3).
IDEAL_STATE = {
    "panic": 0,
    "asked": ["address", "landmark", "callback", "what_happened", "victims"],
    "facts": [],
    "calm_reason": 2,
    "confirmed": True,
}
JOURNAL = {
    "events": [
        {
            "t": 0,
            "action": "opening",
            "reply": "Алло! Алло, это пожарные?!",
            "panic_before": 3,
            "panic_after": 3,
            "mark": {"kind": "info", "text": "Звонок начался: заявитель в истерике."},
        },
        {
            "t": 6,
            "action": "calm",
            "key": "reason",
            "said": "Я вам помогу. Мне нужен адрес, чтобы отправить помощь.",
            "reply": "Я... хорошо... я пытаюсь.",
            "outcome": "calming",
            "panic_before": 3,
            "panic_after": 2,
            "mark": {"kind": "good", "text": "Просьба с причиной сработала."},
        },
        {"t": 90, "action": "end", "note": "Карточка сохранена, разговор окончен."},
    ],
    "steps": [{"step": 1, "t": 31}, {"step": 2, "t": 44}],
}
IDEAL_CARD = {
    "incident_type_code": "1050102",
    # В доме газовые плиты — газификация и Мосгаз (этап 3, как в прототипе).
    "tags": ["victims", "gasification"],
    "services": ["101", "102", "103", "104", "MOSLIFT"],
    "address": {
        "city": "Москва",
        "okrug": "САО",
        "district": "Западное Дегунино",
        "street": "Дубнинская улица",
        "house": "12",
        "building": "",
        "apartment": "47",
    },
    "description": (
        "Задымление в квартире 47 на пятом этаже дома 12 по Дубнинской улице: из-под двери "
        "идёт густой дым, открытого огня заявитель не видит; в квартире пожилая соседка, не "
        "выходит на стук, квартира заперта изнутри, подъезд открыт."
    ),
    "caller_name": "Соснина Ольга Викторовна",
}


def _save(client, headers, **overrides):
    body = {"scenario_id": SCENARIO, "state": IDEAL_STATE, "elapsed_s": 90, "card": IDEAL_CARD}
    body.update(overrides)
    response = client.post("/api/operator/save", json=body, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_save_requires_login(database_client):
    response = database_client.post(
        "/api/operator/save",
        json={"scenario_id": SCENARIO, "elapsed_s": 90, "card": IDEAL_CARD},
    )
    assert response.status_code == 401


def test_ideal_attempt_scores_maximum(database_client):
    headers = login(database_client, "trainee01")
    result = _save(database_client, headers)
    assert result["total"] == result["max_total"] == 100
    for criterion in result["criteria"]:
        assert criterion["score"] == 1.0, criterion


def test_wrong_address_and_missing_service_score_lower_with_explanations(database_client):
    headers = login(database_client, "trainee01")
    bad_card = {
        **IDEAL_CARD,
        "services": ["101", "102"],  # пропущены 103 и MOSLIFT
        "address": {**IDEAL_CARD["address"], "street": "Дубининская улица"},
    }
    result = _save(database_client, headers, card=bad_card)
    assert result["total"] < 100

    by_key = {criterion["key"]: criterion for criterion in result["criteria"]}
    assert by_key["address"]["score"] == 0.0
    assert "Дубининская" in by_key["address"]["explanation"]
    assert "Дубнинская" in by_key["address"]["explanation"]

    assert by_key["services"]["score"] < 1.0
    assert "пропущены" in by_key["services"]["explanation"]
    assert "Мослифт" in by_key["services"]["explanation"]


def test_attempt_appears_in_list_and_can_be_read_back(database_client):
    headers = login(database_client, "trainee01")
    saved = _save(database_client, headers)

    listing = database_client.get("/api/operator/attempts", headers=headers)
    assert listing.status_code == 200, listing.text
    ids = [item["id"] for item in listing.json()]
    assert saved["id"] in ids

    detail = database_client.get(f"/api/operator/attempts/{saved['id']}", headers=headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["total"] == saved["total"]


def test_journal_is_stored_in_attempt_and_read_back(database_client):
    """Этап 3: журнал звонка — в попытке (audit_log), разбор открывается и из списка попыток."""
    headers = login(database_client, "trainee01")
    saved = _save(database_client, headers, journal=JOURNAL)
    assert saved["journal"]["steps"] == JOURNAL["steps"]
    assert [event["action"] for event in saved["journal"]["events"]] == ["opening", "calm", "end"]

    detail = database_client.get(f"/api/operator/attempts/{saved['id']}", headers=headers)
    assert detail.status_code == 200, detail.text
    journal = detail.json()["journal"]
    assert journal["steps"] == JOURNAL["steps"]
    calm = journal["events"][1]
    assert (calm["outcome"], calm["panic_before"], calm["panic_after"]) == ("calming", 3, 2)
    assert calm["mark"] == {"kind": "good", "text": "Просьба с причиной сработала."}

    # Без журнала (клиент до этапа 3) попытка сохраняется, разбор пустой.
    plain = _save(database_client, headers)
    assert plain["journal"] == {"events": [], "steps": []}


def test_bad_journal_is_rejected(database_client):
    headers = login(database_client, "trainee01")
    bad = [
        # время идёт назад
        {"events": [{"t": 9, "action": "hold"}, {"t": 3, "action": "hold"}], "steps": []},
        # шаг повторяется
        {"events": [], "steps": [{"step": 1, "t": 5}, {"step": 1, "t": 9}]},
        # неизвестное действие и пометка
        {"events": [{"t": 1, "action": "dance"}], "steps": []},
        {"events": [{"t": 1, "action": "hold", "mark": {"kind": "great", "text": "x"}}]},
        # паника вне 0…3
        {"events": [{"t": 1, "action": "hold", "panic_after": 7}]},
    ]
    for journal in bad:
        response = database_client.post(
            "/api/operator/save",
            json={"scenario_id": SCENARIO, "elapsed_s": 5, "card": IDEAL_CARD, "journal": journal},
            headers=headers,
        )
        assert response.status_code == 422, journal


def test_other_trainee_cannot_read_attempt(database_client):
    headers = login(database_client, "trainee01")
    saved = _save(database_client, headers)
    other_headers = login(database_client, "trainee02")
    response = database_client.get(f"/api/operator/attempts/{saved['id']}", headers=other_headers)
    assert response.status_code == 404


def test_empty_card_saved_fast_is_accepted_without_time_points(database_client):
    headers = login(database_client, "trainee01")
    result = _save(
        database_client,
        headers,
        state={"panic": 1, "asked": [], "facts": []},
        elapsed_s=2,
        card={
            "incident_type_code": None,
            "tags": [],
            "services": [],
            "address": {},
            "description": "",
            "caller_name": "",
        },
    )
    by_key = {criterion["key"]: criterion for criterion in result["criteria"]}
    assert by_key["timing"]["points"] == 0
    assert "Время не засчитано" in by_key["timing"]["explanation"]
    assert result["total"] < 10
