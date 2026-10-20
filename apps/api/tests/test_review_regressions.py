"""Регрессии серверных замечаний ревью DDS: совместимость и жизненный цикл звонков."""

from uuid import NAMESPACE_URL, uuid5

import pytest
from app.api.progress.service import is_tutorial
from app.core.models import Scenario

from . import test_brigade_briefing as briefing_base

briefing_card = briefing_base.briefing_card


def test_dispatch_decision_states_have_one_source():
    from app.api.training import briefing, brigades

    assert briefing.DECIDED is brigades.DECIDED_STATES


@pytest.mark.parametrize("briefing_card", ["gas-apartment-101-1"], indirect=True)
def test_phone_policy_is_shared_by_dialing_and_caller(briefing_card, database_url, monkeypatch):
    from types import SimpleNamespace
    from uuid import UUID

    from app.api.cards.service import contact_numbers, contact_service
    from app.api.training.caller import caller_numbers
    from app.core.models import Card
    from evalcore import defaults

    from .test_lifecycle import run_db

    _, _, card, _ = briefing_card
    monkeypatch.setattr(
        defaults,
        "phone_contacts",
        lambda settings, service: [
            {"role": "caller", "name": "Заявитель", "number": "460"},
            {"role": "head", "name": "Руководитель", "number": "450"},
        ],
    )

    async def read(db):
        row = await db.get(Card, UUID(card["id"]))
        request = SimpleNamespace(state=SimpleNamespace(db=db))
        return (
            await caller_numbers(db, row),
            await contact_numbers(request, row),
            await contact_service(request, row),
        )

    assert run_db(database_url, read) == ({"460"}, {"450", "460"}, "101")


@pytest.mark.parametrize("unplayable", ["retired", "caller", "missing_final_report", "link112"])
def test_again_checks_catalog_before_replacing_running_practice(
    database_client, database_url, unplayable, monkeypatch
):
    import copy
    from uuid import UUID

    from app.core.models import Scenario

    from . import test_c03_sessions as c03
    from .test_c04_completion import seed_training
    from .test_lifecycle import login, run_db
    from .test_practice_catalog import catalog

    seed_training(database_url)
    client = database_client
    headers = login(client, "trainee03")
    chosen = next(item for item in catalog(client) if item["level"] == 1)
    first = client.post(f"/api/practice?scenario={chosen['id']}", headers=headers)
    assert first.status_code == 200, first.text
    session_id = first.json()["id"]
    c03.tick(database_url)
    card = next(
        item for item in client.get("/api/cards").json() if item["session_id"] == session_id
    )

    async def break_scenario(db):
        row = await db.get(Scenario, UUID(chosen["id"]))
        original = row.status, copy.deepcopy(row.reference)
        if unplayable == "link112":
            from app.seed import link112

            monkeypatch.setattr(link112, "link_scenario_ids", lambda: frozenset({row.id}))
        elif unplayable == "retired":
            row.status = "retired"
        elif unplayable == "caller":
            from .test_review_final_practice import configure_contacts, exhausted_contacts

            row.reference = {
                **row.reference,
                "expected_call": {"required": True, "contact_role": "caller"},
            }
            # При свободном 405 заявитель добавляется автоматически; недоступность —
            # только при занятых резервных номерах в валидном справочнике ДДС.
            configure_contacts(monkeypatch, row.target_service_id, exhausted_contacts())
        else:
            row.reference = {**row.reference, "expected_flow": ["accepted", "refused"]}
        return original

    original = run_db(database_url, break_scenario)
    try:
        response = client.post(f"/api/practice?again={card['id']}", headers=headers)
        assert response.status_code == 409, response.text
        assert response.json()["code"] == (
            "practice_unavailable" if unplayable == "caller" else "scenario_not_in_catalog"
        )
        assert client.get(f"/api/sessions/{session_id}").json()["status"] == "running"
    finally:

        async def restore(db):
            row = await db.get(Scenario, UUID(chosen["id"]))
            row.status, row.reference = original

        run_db(database_url, restore)
        for lesson in client.get("/api/sessions").json():
            if lesson["status"] == "running" and lesson["kind"] == "practice":
                client.post(f"/api/sessions/{lesson['id']}/finish", headers=headers)


@pytest.mark.parametrize("briefing_card", ["gas-apartment-101-1"], indirect=True)
def test_worker_delivers_alarm_even_after_question_in_same_tick(
    briefing_card, database_url, monkeypatch
):
    from datetime import UTC, datetime, timedelta
    from uuid import UUID, uuid4

    from app.api.training.gating import ScheduledReport
    from app.core.models import Card, MessageDelivery
    from app.worker import training as worker
    from sqlalchemy import select

    from .test_brigade_briefing import accept, dial
    from .test_lifecycle import run_db

    client, headers, card, target = briefing_card
    accept(client, headers, card)
    dial(client, headers, card, target)
    now = datetime.now(UTC)
    messages = [uuid4(), uuid4(), uuid4()]
    reports = [
        ScheduledReport(
            planned={
                "message": {"id": str(message), "version": 1, "text": "Реплика", "audio": None},
                **extra,
            },
            identity=(message, 1),
            brigade_id=UUID(target["brigade_id"]),
            target_id=UUID(target["id"]),
            issued=False,
            waiting_started_at=now,
            ready_at=now + timedelta(microseconds=index),
        )
        for index, (message, extra) in enumerate(
            zip(
                messages,
                [
                    {"question": True},
                    {"priority": "alarm"},
                    {},
                ],
                strict=True,
            )
        )
    ]

    async def schedule(db, row, at):
        return reports

    monkeypatch.setattr(worker, "report_schedule", schedule)

    async def issue(db):
        row = await db.get(Card, UUID(card["id"]))
        await worker.deliver_messages(db, row, now + timedelta(seconds=1))
        await db.flush()
        return set(
            await db.scalars(
                select(MessageDelivery.message_id).where(MessageDelivery.card_id == row.id)
            )
        )

    assert run_db(database_url, issue) == set(messages[:2])


def test_alarm_line_bypasses_unanswered_turn_gate():
    from dataclasses import replace

    from app.api.training.scenario_events import apply_world, world
    from app.api.training.turns import Turn

    from .test_live_brigade import ALARM, ALARM_EVENT, CREW, at, journal

    state = replace(journal(firings={ALARM: 30}), turns=[Turn(CREW, None, None)])
    [alarm] = apply_world([], world({ALARM: ALARM_EVENT}, state, at(31)), set())
    assert alarm.ready_at == at(30)
    assert alarm.planned.get("priority") == "alarm"


@pytest.mark.parametrize("briefing_card", ["smoke-apartment-101-1"], indirect=True)
@pytest.mark.parametrize("mode", ["option", "voice"])
def test_unheard_question_can_be_answered_after_brigade_rerings(briefing_card, database_url, mode):
    from datetime import UTC, datetime, timedelta
    from uuid import UUID

    from app.core.models import Call
    from sqlalchemy import select

    from .briefing_helpers import briefing_payload
    from .test_brigade_briefing import accept, dial
    from .test_lifecycle import run_db
    from .test_live_brigade_flow import present, training, voice_reply
    from .test_practice_gating import send, worker_tick
    from .test_voice_report import FakeSTT

    client, headers, card, target = briefing_card
    accept(client, headers, card)
    original = dial(client, headers, card, target)
    send(client, headers, card["id"], "brigade_briefing", briefing_payload(card, original))
    question = next(
        m for m in training(client, card["id"])["messages"] if "reply_options" in m["delivery"]
    )
    assert question["state"] != "presented"
    send(client, headers, card["id"], "call_hangup", {"call_id": original})
    worker_tick(database_url, datetime.now(UTC) + timedelta(seconds=6))

    async def ringing(db):
        rows = list(await db.scalars(select(Call).where(Call.card_id == UUID(card["id"]))))
        replacement = next(
            (row.id for row in rows if row.direction == "inbound" and row.ended_at is None), None
        )
        assert replacement is not None, [
            (str(row.id), row.direction, row.ended_at, row.end_reason) for row in rows
        ]
        return replacement

    replacement = str(run_db(database_url, ringing))
    assert replacement != original
    send(client, headers, card["id"], "call_answer", {"call_id": replacement})
    present(client, headers, card["id"], question)
    delivery_id = question["delivery"]["delivery_id"]
    other_target = next(
        item
        for item in client.get("/api/services/101/call-targets").json()
        if item["brigade_id"] != target["brigade_id"]
        and item["brigade_id"] in training(client, card["id"])["available_brigade_ids"]
    )
    other_call = dial(client, headers, card, other_target)
    for wrong_call in (original, other_call):
        send(
            client,
            headers,
            card["id"],
            "brigade_reply",
            {
                "call_id": wrong_call,
                "delivery_id": delivery_id,
                "option_key": "fix",
                "mode": "option",
            },
            409,
        )
    if mode == "voice":
        client.app.state.voice_report_stt = FakeSTT(
            "Нет, Бескудниковский бульвар, двадцать четыре", 0.8
        )
        assert voice_reply(client, headers, original, delivery_id).status_code == 409
        assert voice_reply(client, headers, other_call, delivery_id).status_code == 404
        heard = voice_reply(client, headers, replacement, delivery_id)
        assert heard.status_code == 200, heard.text
        assert heard.json()["option_key"] == "fix"
    payload = {
        "call_id": replacement,
        "delivery_id": delivery_id,
        "option_key": "fix",
        "mode": mode,
    }
    if mode == "voice":
        payload["text"] = heard.json()["text"]
    send(client, headers, card["id"], "brigade_reply", payload)
    send(client, headers, card["id"], "brigade_reply", payload, 409)


@pytest.mark.parametrize("briefing_card", ["gas-apartment-101-1"], indirect=True)
@pytest.mark.parametrize("closed", [False, True])
@pytest.mark.parametrize("line", ["brigade", "brigade_inbound", "service"])
def test_worker_expires_hold_without_browser_and_keeps_resumed_calls(
    briefing_card, database_url, closed, line
):
    from datetime import UTC, datetime, timedelta
    from uuid import UUID, uuid4

    from app.core.models import Call, Card, CardEvent
    from sqlalchemy import select

    from .test_brigade_briefing import accept, dial
    from .test_lifecycle import run_db
    from .test_live_brigade_flow import training
    from .test_practice_gating import send, worker_tick

    client, headers, card, target = briefing_card
    accept(client, headers, card)
    if line.startswith("brigade"):
        held = dial(client, headers, card, target)
        if line == "brigade_inbound":

            async def incoming(db):
                (await db.get(Call, UUID(held))).direction = "inbound"

            run_db(database_url, incoming)
    else:
        held = str(uuid4())
        send(client, headers, card["id"], "call_dial", {"call_id": held, "phone_ext": "104"})
        send(client, headers, card["id"], "call_answer", {"call_id": held})
    live = str(uuid4())
    send(client, headers, card["id"], "call_dial", {"call_id": live, "phone_ext": "103"})
    send(client, headers, card["id"], "call_answer", {"call_id": live})
    send(client, headers, card["id"], "call_hold", {"call_id": live})
    send(client, headers, card["id"], "call_resume", {"call_id": live})
    first = send(client, headers, card["id"], "call_hold", {"call_id": held}).json()
    send(client, headers, card["id"], "call_resume", {"call_id": held})
    send(client, headers, card["id"], "call_hold", {"call_id": held})

    async def snapshot(db):
        mark = await db.scalar(
            select(CardEvent)
            .where(
                CardEvent.card_id == UUID(card["id"]),
                CardEvent.type == "call_hold",
                CardEvent.payload["call_id"].astext == held,
            )
            .order_by(CardEvent.server_ts.desc(), CardEvent.id)
            .limit(1)
        )
        if closed:
            row = await db.get(Card, UUID(card["id"]))
            row.state, row.closed_at = "completed", datetime.now(UTC)
        return mark.server_ts

    started = run_db(database_url, snapshot)
    first_at = datetime.fromisoformat(first["server_ts"].replace("Z", "+00:00"))
    assert first_at < started
    worker_tick(database_url, first_at + timedelta(seconds=180))
    assert client.get(f"/api/calls/{held}").json()["state"] == "talking"
    worker_tick(database_url, started + timedelta(seconds=179))
    assert client.get(f"/api/calls/{held}").json()["state"] == "talking"
    worker_tick(database_url, started + timedelta(seconds=180))
    assert client.get(f"/api/calls/{held}").json()["state"] == "ended"
    assert client.get(f"/api/calls/{live}").json()["state"] == "talking"
    worker_tick(database_url, started + timedelta(seconds=300))

    async def ended(db):
        row = await db.get(Call, UUID(held))
        return row.ended_at, row.end_reason

    assert run_db(database_url, ended) == (started + timedelta(seconds=180), "hold_timeout")
    view = training(client, card["id"])
    if line == "brigade_inbound":
        callback = next(item for item in view["callbacks"] if item["call_id"] == held)
        assert callback["ended_at"] is not None
        assert callback["end_reason"] is None
    late = send(client, headers, card["id"], "call_hangup", {"call_id": held}, 409)
    assert late.json()["code"] == "call_ended"


@pytest.mark.parametrize("service", ["101", "102", "103", "104", "GKH", "MOSLIFT"])
@pytest.mark.parametrize("generation", ["", "bank:"])
def test_tutorial_history_survives_voice_generation(service, generation):
    scenario = Scenario(
        id=uuid5(NAMESPACE_URL, f"arm112:c04:tutorial:{generation}{service}"),
        target_service_id=service,
    )
    assert is_tutorial(scenario)
    scenario.id = uuid5(NAMESPACE_URL, f"arm112:c04:parallel:{generation}{service}")
    assert not is_tutorial(scenario)


@pytest.mark.parametrize("briefing_card", ["gas-apartment-101-1"], indirect=True)
@pytest.mark.parametrize("line", ["brigade", "service"])
def test_closed_card_allows_hangup_but_not_new_call(briefing_card, database_url, line):
    from datetime import UTC, datetime
    from uuid import UUID, uuid4

    from app.core.models import Card

    from .test_brigade_briefing import accept, dial
    from .test_lifecycle import run_db
    from .test_practice_gating import send

    client, headers, card, target = briefing_card
    accept(client, headers, card)
    if line == "brigade":
        call_id = dial(client, headers, card, target)
    else:
        call_id = str(uuid4())
        send(client, headers, card["id"], "call_dial", {"call_id": call_id, "phone_ext": "103"})
        send(client, headers, card["id"], "call_answer", {"call_id": call_id})
    send(client, headers, card["id"], "call_hold", {"call_id": call_id})

    async def close(db):
        row = await db.get(Card, UUID(card["id"]))
        row.state, row.closed_at = "completed", datetime.now(UTC)

    run_db(database_url, close)
    ended = send(client, headers, card["id"], "call_hangup", {"call_id": call_id})
    assert ended.status_code == 200
    assert client.get(f"/api/calls/{call_id}").json()["state"] == "ended"
    duplicate = send(client, headers, card["id"], "call_hangup", {"call_id": call_id}, 409)
    assert duplicate.json()["code"] == "call_ended"
    send(
        client, headers, card["id"], "call_dial", {"call_id": str(uuid4()), "phone_ext": "103"}, 409
    )
    send(client, headers, card["id"], "call_hangup", {"call_id": str(uuid4())}, 404)
