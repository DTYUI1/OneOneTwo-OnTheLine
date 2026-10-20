"""GP-11 с БД: сказанное бригаде попадает в журнал карточки (brigade_said). Фраза вне вопроса
и неполная вводная пишутся строкой card_events; в закрытом или чужом разговоре — отказ."""

from uuid import uuid4

import pytest

from . import test_brigade_briefing as base
from .test_brigade_briefing import GAS, accept, dial
from .test_practice_gating import send

# Фикстура занятия с принятой карточкой — та же, что у вводной (GP-05).
briefing_card = base.briefing_card


def said(client, card_id, kind="brigade_said"):
    events = client.get(f"/api/cards/{card_id}/events").json()
    return [item["payload"] for item in events if item["type"] == kind]


@pytest.mark.parametrize("briefing_card", [GAS], indirect=True)
def test_said_goes_to_card_journal(briefing_card):
    client, headers, card, target = briefing_card
    accept(client, headers, card)
    call_id = dial(client, headers, card, target)
    for text in ("Доложите обстановку", "В квартире ребёнок, пожилая женщина"):
        send(client, headers, card["id"], "brigade_said", {"call_id": call_id, "text": text})
    assert said(client, card["id"]) == [
        {"call_id": call_id, "text": "Доложите обстановку"},
        {"call_id": call_id, "text": "В квартире ребёнок, пожилая женщина"},
    ]


@pytest.mark.parametrize("briefing_card", [GAS], indirect=True)
def test_said_needs_a_live_brigade_call(briefing_card):
    client, headers, card, target = briefing_card
    accept(client, headers, card)
    call_id = dial(client, headers, card, target)
    # Звонка нет — 404; текст пустой — формат не проходит.
    send(
        client, headers, card["id"], "brigade_said", {"call_id": str(uuid4()), "text": "Алло"}, 404
    )
    send(client, headers, card["id"], "brigade_said", {"call_id": call_id, "text": ""}, 422)
    send(client, headers, card["id"], "call_hangup", {"call_id": call_id})
    # После отбоя говорить некому.
    send(client, headers, card["id"], "brigade_said", {"call_id": call_id, "text": "Алло"}, 409)
    assert said(client, card["id"]) == []
