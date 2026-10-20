"""Разрешение caller_said проверяется сервером; БД заменена только на границе хранения."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from app.api.training import caller, content
from app.api.training.contacts import CardPhone
from app.core.models import Assignment, Call, Scenario
from fastapi import HTTPException


@pytest.mark.parametrize(
    "phrase_id",
    ["CALLER_CALM.tell_eta.animal_shaft.1", "CALLER_CONFUSED.tell_eta.pipe_access.2"],
)
def test_modern_caller_rejects_wrong_plot_or_character(monkeypatch, phrase_id):
    card = SimpleNamespace(id=uuid4(), assignment_id=uuid4())
    call_id = uuid4()
    call = SimpleNamespace(id=call_id, card_id=card.id, answered_at=True, dialed_ext="74951234567")
    assignment = SimpleNamespace(scenario_id=uuid4())
    scenario = SimpleNamespace()
    rows = {Call: call, Assignment: assignment, Scenario: scenario}
    db = SimpleNamespace(get=AsyncMock(side_effect=lambda model, key: rows.get(model)))
    phone = CardPhone("GKH", ({"number": "74951234567", "role": "caller", "character": "calm"},))
    monkeypatch.setattr(caller, "card_phone", AsyncMock(return_value=phone))
    monkeypatch.setattr(caller, "caller_numbers", AsyncMock(return_value=phone.numbers("caller")))
    plan = {
        "caller": {"plot": "pipe_access", "character": "calm"},
        "events": [{"branches": {"met": {"awaits_call": {"required_facts": ["eta"]}}}}],
    }
    monkeypatch.setattr(
        content, "plan_for_assignment", AsyncMock(return_value=SimpleNamespace(plan=plan))
    )
    with pytest.raises(HTTPException) as caught:
        asyncio.run(
            caller.record_caller_line(db, card, {"call_id": str(call_id), "phrase_id": phrase_id})
        )
    assert caught.value.status_code == 409


@pytest.mark.parametrize("wrong", ("delivery_card", "call_card", "brigade"))
def test_relay_cannot_be_submitted_in_another_card_or_brigade(wrong):
    from app.api.training.scenario_events import record_reply
    from app.core.models import MessageDelivery

    card_id, call_id, delivery_id, brigade_id = (uuid4() for _ in range(4))
    card = SimpleNamespace(id=card_id)
    delivery = SimpleNamespace(
        card_id=uuid4() if wrong == "delivery_card" else card_id, brigade_id=brigade_id
    )
    call = SimpleNamespace(
        card_id=uuid4() if wrong == "call_card" else card_id,
        brigade_id=uuid4() if wrong == "brigade" else brigade_id,
        refusal=None,
        answered_at=True,
        ended_at=None,
    )
    db = SimpleNamespace(
        get=AsyncMock(side_effect=lambda model, key: delivery if model is MessageDelivery else call)
    )
    with pytest.raises(HTTPException) as caught:
        asyncio.run(
            record_reply(
                db,
                card,
                {"call_id": str(call_id), "delivery_id": str(delivery_id), "option_key": "relay"},
            )
        )
    assert caught.value.status_code == (404 if wrong == "delivery_card" else 409)
