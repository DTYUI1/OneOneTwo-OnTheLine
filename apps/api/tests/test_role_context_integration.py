"""Интеграция номера произвольной роли dev с общим телефонным контекстом fixes."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from app.api.training import caller
from app.api.training.contacts import CardPhone


@pytest.mark.parametrize(
    "role, expected", [("head", {"450"}), ("caller", {"460"}), ("missing", set())]
)
def test_role_uses_shared_phone_context(monkeypatch, role, expected):
    phone = CardPhone(
        "101",
        (
            {"role": "caller", "name": "Заявитель", "number": "460"},
            {"role": "caller", "name": "Повтор", "number": "460"},
            {"role": "head", "name": "Руководитель", "number": "450"},
        ),
    )
    shared = AsyncMock(return_value=phone)
    monkeypatch.setattr(caller, "card_phone", shared)
    db = SimpleNamespace(execute=AsyncMock(side_effect=AssertionError("Обход общего контекста")))
    card = SimpleNamespace(assignment_id="assignment")
    assert asyncio.run(caller.role_numbers(db, card, role)) == expected
    shared.assert_awaited_once_with(db, card)
    db.execute.assert_not_awaited()


def test_caller_delegates_to_role_numbers(monkeypatch):
    role = AsyncMock(return_value={"460"})
    monkeypatch.setattr(caller, "role_numbers", role)
    db, card = object(), object()
    assert asyncio.run(caller.caller_numbers(db, card)) == {"460"}
    role.assert_awaited_once_with(db, card, "caller")


def test_empty_shared_context_has_no_numbers(monkeypatch):
    monkeypatch.setattr(caller, "card_phone", AsyncMock(return_value=CardPhone(None, ())))
    db, card = object(), object()
    assert asyncio.run(caller.role_numbers(db, card, "head")) == set()
    assert asyncio.run(caller.caller_numbers(db, card)) == set()
