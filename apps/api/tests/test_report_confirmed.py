"""TC-01 с БД: «Принял» на «Как приняли?» — подтверждение приёма доклада в журнале карточки
(report_confirmed). Подтвердить можно только прозвучавший доклад бригады на линии."""

from uuid import uuid4

import pytest

from . import test_brigade_briefing as base
from .briefing_helpers import briefing_payload
from .test_brigade_briefing import GAS, accept, dial
from .test_live_brigade_flow import present, training
from .test_practice_gating import send

# Фикстура занятия с принятой карточкой — та же, что у вводной (GP-05).
briefing_card = base.briefing_card


def confirmed(client, card_id):
    events = client.get(f"/api/cards/{card_id}/events").json()
    return [item["payload"] for item in events if item["type"] == "report_confirmed"]


@pytest.mark.parametrize("briefing_card", [GAS], indirect=True)
def test_confirm_goes_to_card_journal(briefing_card):
    client, headers, card, target = briefing_card
    accept(client, headers, card)
    call_id = dial(client, headers, card, target)
    # Вводная — бригада выезжает и в том же разговоре докладывает о выезде.
    send(client, headers, card["id"], "brigade_briefing", briefing_payload(card, call_id))
    (departure,) = training(client, card["id"])["messages"]
    delivery_id = departure["delivery"]["delivery_id"]
    payload = {"call_id": call_id, "delivery_id": delivery_id, "text": "Принял."}
    # Доклад ещё не прозвучал — подтверждать нечего.
    send(client, headers, card["id"], "report_confirmed", payload, 409)
    present(client, headers, card["id"], departure)
    send(client, headers, card["id"], "report_confirmed", payload)
    assert confirmed(client, card["id"]) == [payload]


@pytest.mark.parametrize("briefing_card", [GAS], indirect=True)
def test_confirm_needs_live_call_and_known_report(briefing_card):
    client, headers, card, target = briefing_card
    accept(client, headers, card)
    call_id = dial(client, headers, card, target)
    send(client, headers, card["id"], "brigade_briefing", briefing_payload(card, call_id))
    (departure,) = training(client, card["id"])["messages"]
    present(client, headers, card["id"], departure)
    delivery_id = departure["delivery"]["delivery_id"]
    # Чужая выдача и чужой звонок — 404; пустой ответ — формат не проходит.
    for payload, status in (
        ({"call_id": call_id, "delivery_id": str(uuid4()), "text": "Принял."}, 404),
        ({"call_id": str(uuid4()), "delivery_id": delivery_id, "text": "Принял."}, 404),
        ({"call_id": call_id, "delivery_id": delivery_id, "text": ""}, 422),
    ):
        send(client, headers, card["id"], "report_confirmed", payload, status)
    send(client, headers, card["id"], "call_hangup", {"call_id": call_id})
    # После отбоя «Принял» некому сказать.
    send(
        client,
        headers,
        card["id"],
        "report_confirmed",
        {"call_id": call_id, "delivery_id": delivery_id, "text": "Принял."},
        409,
    )
    assert confirmed(client, card["id"]) == []
