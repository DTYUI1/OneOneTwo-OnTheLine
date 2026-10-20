"""HQ-033 с БД: удержание звонка (call_hold / call_resume) пишется в журнал карточки.

Удержать можно только идущий разговор своей карточки и только не удержанный; снять — только
удержанный. Звонок на сервере не кончается: после снятия разговор идёт, отбой — обычный.
"""

from uuid import uuid4

import pytest

from . import test_brigade_briefing as base
from .test_brigade_briefing import GAS, accept, dial
from .test_practice_gating import send

briefing_card = base.briefing_card


def marks(client, card_id):
    events = client.get(f"/api/cards/{card_id}/events").json()
    return [item["type"] for item in events if item["type"] in {"call_hold", "call_resume"}]


@pytest.mark.parametrize("briefing_card", [GAS], indirect=True)
def test_hold_and_resume_go_to_card_journal(briefing_card):
    client, headers, card, target = briefing_card
    accept(client, headers, card)
    call_id = dial(client, headers, card, target)
    for kind in ("call_hold", "call_resume", "call_hold"):
        send(client, headers, card["id"], kind, {"call_id": call_id})
    assert marks(client, card["id"]) == ["call_hold", "call_resume", "call_hold"]
    # Звонок на сервере идёт: собеседник не дождался — обычный отбой с удержания.
    call = client.get(f"/api/calls/{call_id}").json()
    assert call["state"] == "talking"
    send(client, headers, card["id"], "call_hangup", {"call_id": call_id})


@pytest.mark.parametrize("briefing_card", [GAS], indirect=True)
def test_hold_needs_a_live_call_in_right_state(briefing_card):
    client, headers, card, target = briefing_card
    accept(client, headers, card)
    call_id = dial(client, headers, card, target)
    send(client, headers, card["id"], "call_hold", {"call_id": str(uuid4())}, 404)
    # Снять не удержанный и удержать дважды нельзя.
    send(client, headers, card["id"], "call_resume", {"call_id": call_id}, 409)
    send(client, headers, card["id"], "call_hold", {"call_id": call_id})
    send(client, headers, card["id"], "call_hold", {"call_id": call_id}, 409)
    send(client, headers, card["id"], "call_hangup", {"call_id": call_id})
    # После отбоя удерживать нечего.
    send(client, headers, card["id"], "call_resume", {"call_id": call_id}, 409)
    assert marks(client, card["id"]) == ["call_hold"]
