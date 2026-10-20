"""Входящий worker соблюдает ту же занятость бригады, что и ручной набор."""

from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import UUID

import pytest
from app.core.models import Call, Card
from app.worker import training
from sqlalchemy import select

from . import test_call_line_busy as busy_lines
from .test_call_line_busy import dial_body
from .test_lifecycle import event, login, run_db

lesson = busy_lines.lesson
lines = busy_lines.lines


@pytest.mark.parametrize("state", ["ringing", "talking", "held", "inbound"])
def test_callback_waits_for_same_brigade_on_another_card(lines, monkeypatch, state):
    client, headers, cards, target, url, _ = lines
    path = f"/api/cards/{cards[0]['id']}/events"
    first = dial_body(target)
    response = client.post(path, json=first, headers=headers)
    assert response.status_code == 200, response.text
    call_id = first["payload"]["call_id"]
    if state in {"talking", "held"}:
        response = client.post(
            path, json=event("call_answer", {"call_id": call_id}), headers=headers
        )
        assert response.status_code == 200, response.text
    if state == "held":
        response = client.post(path, json=event("call_hold", {"call_id": call_id}), headers=headers)
        assert response.status_code == 200, response.text
    if state == "inbound":

        async def incoming(db):
            call = await db.get(Call, UUID(call_id))
            call.direction = "inbound"

        run_db(url, incoming)
    now = datetime.now(UTC)

    # Управляем только готовностью доклада: Calls и занятость читаются из настоящей БД.
    async def ready(db, card, at):
        return [
            SimpleNamespace(
                brigade_id=UUID(target["brigade_id"]),
                target_id=UUID(target["id"]),
                issued=False,
                ready_at=now,
            )
        ]

    monkeypatch.setattr(training, "report_schedule", ready)

    async def ring(db):
        card = await db.get(Card, UUID(cards[1]["id"]))
        count = await training.ring_brigades(db, card, now)
        incoming = list(
            await db.scalars(
                select(Call).where(
                    Call.card_id == card.id,
                    Call.direction == "inbound",
                    Call.ended_at.is_(None),
                )
            )
        )
        return count, incoming

    count, incoming = run_db(url, ring)
    assert count == 0, "Одна бригада не может звонить по второй карточке, пока её линия занята"
    assert incoming == []
    response = client.post(path, json=event("call_hangup", {"call_id": call_id}), headers=headers)
    assert response.status_code == 200, response.text
    count, incoming = run_db(url, ring)
    assert count == 1
    assert len(incoming) == 1 and str(incoming[0].brigade_id) == target["brigade_id"]


def test_callback_busy_line_is_scoped_to_participant(lines, lesson, monkeypatch):
    client, headers, cards, target, url, _ = lines
    first = dial_body(target)
    response = client.post(f"/api/cards/{cards[0]['id']}/events", json=first, headers=headers)
    assert response.status_code == 200, response.text
    login(client, "trainee02")
    other = next(c for c in client.get("/api/cards").json() if c["session_id"] == lesson.id)
    now = datetime.now(UTC)

    async def ready(db, card, at):
        return [
            SimpleNamespace(
                brigade_id=UUID(target["brigade_id"]),
                target_id=UUID(target["id"]),
                issued=False,
                ready_at=now,
            )
        ]

    monkeypatch.setattr(training, "report_schedule", ready)

    async def ring(db):
        card = await db.get(Card, UUID(other["id"]))
        return await training.ring_brigades(db, card, now)

    assert run_db(url, ring) == 1, "Другой обучаемый распоряжается своей копией бригады"
