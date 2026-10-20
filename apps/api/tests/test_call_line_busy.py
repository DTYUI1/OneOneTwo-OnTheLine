"""Занятая линия бригады: набор сериализуется на всех карточках участника."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.core.models import Call
from fastapi.testclient import TestClient

from . import test_c03_sessions as c03
from .test_c04_training import event
from .test_lifecycle import login, run_db

lesson = c03.lesson


@pytest.fixture
def lines(lesson, database_config, database_url):
    c03.batch(
        lesson,
        [c03.item(lesson), c03.item(lesson, order=2), c03.item(lesson, participant=1)],
    )
    c03.start(lesson)
    c03.tick(database_url)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, "trainee01")
        cards = [c for c in client.get("/api/cards").json() if c["session_id"] == lesson.id]
        assert len(cards) == 2
        targets = client.get(
            f"/api/services/{lesson.scenarios[0]['target_service_id']}/call-targets"
        ).json()
        target = next(t for t in targets if t["brigade_id"] and t["is_active"])
        for card in cards:
            response = client.post(
                f"/api/cards/{card['id']}/events", json=event("deliver", {}), headers=headers
            )
            assert response.status_code == 200, response.text
        yield client, headers, cards, target, database_url, database_config


def dial_body(target):
    return event(
        "call_dial_target",
        {
            "call_id": str(uuid4()),
            "call_target_id": target["id"],
            "brigade_id": target["brigade_id"],
        },
    )


@pytest.mark.parametrize("state", ["ringing", "talking", "held", "inbound"])
@pytest.mark.parametrize("other_card", [False, True])
def test_busy_until_hangup(lines, state, other_card):
    client, headers, cards, target, url, _ = lines
    first_url = f"/api/cards/{cards[0]['id']}/events"
    second_url = f"/api/cards/{cards[int(other_card)]['id']}/events"
    first = dial_body(target)
    response = client.post(first_url, json=first, headers=headers)
    assert response.status_code == 200, response.text
    call_id = first["payload"]["call_id"]
    if state in {"talking", "held"}:
        response = client.post(
            first_url, json=event("call_answer", {"call_id": call_id}), headers=headers
        )
        assert response.status_code == 200, response.text
    if state == "held":
        response = client.post(
            first_url, json=event("call_hold", {"call_id": call_id}), headers=headers
        )
        assert response.status_code == 200, response.text
    if state == "inbound":

        async def incoming(db):
            call = await db.get(Call, UUID(call_id))
            call.direction = "inbound"

        run_db(url, incoming)
    second = dial_body(target)
    response = client.post(second_url, json=second, headers=headers)
    assert response.status_code == 409, response.text
    assert response.json() == {"code": "line_busy", "message": "Линия занята.", "details": {}}
    # Прежний client_event_id остаётся идемпотентным даже при занятой линии.
    response = client.post(first_url, json=first, headers=headers)
    assert response.status_code == 200 and response.json()["duplicate"] is True

    async def rejected_call(db):
        assert await db.get(Call, UUID(second["payload"]["call_id"])) is None

    run_db(url, rejected_call)
    response = client.post(
        first_url, json=event("call_hangup", {"call_id": call_id}), headers=headers
    )
    assert response.status_code == 200, response.text
    response = client.post(second_url, json=second, headers=headers)
    assert response.status_code == 200, response.text


def test_simultaneous_dials_on_two_cards_create_one_call(lines):
    _, _, cards, target, url, config = lines
    bodies = [dial_body(target), dial_body(target)]
    barrier = Barrier(2)

    def dial(index):
        with TestClient(create_database_app(config)) as client:
            headers = login(client, "trainee01")
            barrier.wait(timeout=10)
            return client.post(
                f"/api/cards/{cards[index]['id']}/events", json=bodies[index], headers=headers
            )

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(dial, range(2)))
    assert sorted(response.status_code for response in responses) == [200, 409]
    assert next(r for r in responses if r.status_code == 409).json() == {
        "code": "line_busy",
        "message": "Линия занята.",
        "details": {},
    }

    async def saved_calls(db):
        calls = [await db.get(Call, UUID(body["payload"]["call_id"])) for body in bodies]
        assert sum(call is not None for call in calls) == 1

    run_db(url, saved_calls)


def test_same_brigade_is_independent_for_another_participant(lines, lesson):
    client, headers, cards, target, _, config = lines
    response = client.post(
        f"/api/cards/{cards[0]['id']}/events", json=dial_body(target), headers=headers
    )
    assert response.status_code == 200, response.text
    with TestClient(create_database_app(config)) as other:
        other_headers = login(other, "trainee02")
        card = next(c for c in other.get("/api/cards").json() if c["session_id"] == lesson.id)
        response = other.post(
            f"/api/cards/{card['id']}/events", json=event("deliver", {}), headers=other_headers
        )
        assert response.status_code == 200, response.text
        response = other.post(
            f"/api/cards/{card['id']}/events", json=dial_body(target), headers=other_headers
        )
        assert response.status_code == 200, response.text
