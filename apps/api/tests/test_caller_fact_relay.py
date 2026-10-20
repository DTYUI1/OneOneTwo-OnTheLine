"""Содержательный звонок: настоящий loader → журнал → мир, без БД и синтеза."""

import asyncio
from dataclasses import replace
from uuid import UUID

import pytest
from app.api.training.scenario_events import _load_journal, apply_world, due_events, world
from app.seed.scenarios import SCENARIOS_DIR, read_file, training_plan
from app.worker.generators import gameplay

from .test_live_brigade import at, call, journal, report

CODES = ("pipe-access-gkh-2", "lift-location-moslift-2")


def test_original_animal_await_still_releases_on_answer_without_new_requirements():
    plan = parsed_scenario("animal-shaft-gkh-1")
    event = next(e for e in plan["events"] if e["branches"].get("met", {}).get("awaits_call"))
    assert "required_facts" not in event["branches"]["met"]["awaits_call"]
    line, eid = UUID(event["line"]["id"]), UUID(event["id"])
    key = next(expect["option_key"] for expect in event["expect"] if expect["action"] == "reply")
    state = journal(
        presented={line: 10},
        firings={eid: 9},
        replies={line: [(12, key)]},
        calls=[call(20, ext="458", brigade=None, answered=21)],
    )
    result = world(
        {UUID(e["id"]): e for e in plan["events"]}, state, at(30), contact_exts={"caller": {"458"}}
    )
    assert not any(moment > at(30) for moment in result.holds.values())


@pytest.mark.parametrize("code", CODES)
def test_relay_question_is_not_available_before_full_facts(code):
    plan, state, _ = pending_world(code)
    assert due_events(plan["events"], state, set(), at(50)) == []


def parsed_scenario(code):
    async def no_audio(path, text):
        return None

    source = read_file(SCENARIOS_DIR / f"{code}.json", set(gameplay.SERVICES))
    return asyncio.run(training_plan(source, no_audio))


def pending_world(code, calls=()):
    plan = parsed_scenario(code)
    event = plan["events"][0]
    event_id, line, crew = (UUID(event["id"]), UUID(event["line"]["id"]), UUID(event["brigade_id"]))
    state = journal(
        presented={line: 10},
        firings={event_id: 9},
        replies={line: [(12, "ask_caller")]},
        calls=[call(0, brigade=crew, answered=1), *calls],
    )
    state = replace(
        state, delivered={line: crew}, heard_from={crew: [at(10)]}, briefed={crew: at(1)}
    )
    work = plan["messages"][2]
    scheduled = replace(
        report(UUID(work["message"]["id"]), 20),
        brigade_id=crew,
        target_id=UUID(work["call_target_id"]),
        planned=work,
    )
    return plan, state, scheduled


@pytest.mark.parametrize("code", CODES)
def test_answering_caller_without_facts_does_not_release_work(code):
    plan, state, work = pending_world(
        code, [call(20, ext="74951234567", brigade=None, answered=21, ended=22)]
    )
    result = world(
        {UUID(event["id"]): event for event in plan["events"]},
        state,
        at(50),
        contact_exts={"caller": {"74951234567"}},
    )
    assert apply_world([work], result, set())[0].ready_at >= at(132)


@pytest.mark.parametrize("code", CODES)
def test_full_facts_without_relay_does_not_release_work(code):
    plan, state, work = pending_world(
        code, [call(20, ext="74951234567", brigade=None, answered=21, ended=35)]
    )
    required = plan["events"][0]["branches"]["met"]["awaits_call"]["required_facts"]
    state = replace(
        state, caller_facts=[{"key": key, "at": at(30), "answered_at": at(21)} for key in required]
    )
    result = world(
        {UUID(event["id"]): event for event in plan["events"]},
        state,
        at(50),
        contact_exts={"caller": {"74951234567"}},
    )
    assert apply_world([work], result, set())[0].ready_at >= at(132)


@pytest.mark.parametrize("code", CODES)
def test_content_deadline_retains_failure_delay(code):
    plan, state, work = pending_world(code)
    result = world(
        {UUID(e["id"]): e for e in plan["events"]},
        state,
        at(132),
        contact_exts={"caller": {"74951234567"}},
    )
    adjusted = apply_world([work], result, set())[0]
    # delay сохраняет исходную семантику от waiting_started_at, не новый штраф после срока.
    assert adjusted.ready_at == at(40)
    assert result.delays[work.identity[0]] == 40


@pytest.mark.parametrize("code", CODES)
@pytest.mark.parametrize("stage", ("no_call", "dial", "partial", "stale_call"))
def test_incomplete_or_stale_contact_keeps_work_and_relay_closed(code, stage):
    calls = (
        []
        if stage == "no_call"
        else [
            call(
                5 if stage == "stale_call" else 20,
                ext="74951234567",
                brigade=None,
                answered=None if stage == "dial" else 6 if stage == "stale_call" else 21,
            )
        ]
    )
    plan, state, work = pending_world(code, calls)
    required = plan["events"][0]["branches"]["met"]["awaits_call"]["required_facts"]
    keys = required[:-1] if stage == "partial" else required if stage == "stale_call" else []
    state = replace(
        state,
        caller_facts=[
            {"key": key, "at": at(30), "answered_at": at(6 if stage == "stale_call" else 21)}
            for key in keys
        ],
    )
    assert due_events(plan["events"], state, set(), at(50)) == []
    result = world(
        {UUID(e["id"]): e for e in plan["events"]},
        state,
        at(50),
        contact_exts={"caller": {"74951234567"}},
    )
    assert apply_world([work], result, set())[0].ready_at == at(132)


@pytest.mark.parametrize("code", CODES)
@pytest.mark.parametrize("failure", ("wrong_first", "wrong_last", "deadline", "late"))
def test_relay_choice_and_inclusive_content_deadline(code, failure):
    from app.api.training.scenario_events import Firing

    plan, state, work = pending_world(
        code, [call(20, ext="74951234567", brigade=None, answered=21, ended=35)]
    )
    required = plan["events"][0]["branches"]["met"]["awaits_call"]["required_facts"]
    state = replace(
        state, caller_facts=[{"key": key, "at": at(30), "answered_at": at(21)} for key in required]
    )
    for index in (1, 2):
        due = due_events(plan["events"], state, set(), at(40 + index * 5))
        if not due:
            assert failure == "wrong_first" and index == 2
            break
        event, moment = due[0]
        eid, lid = UUID(event["id"]), UUID(event["line"]["id"])
        answer_at = (132.001 if failure == "late" else 132) if index == 2 else 46
        option = "guess" if failure == ("wrong_first" if index == 1 else "wrong_last") else "relay"
        state = replace(
            state,
            firings={**state.firings, eid: Firing(eid, moment, "plan")},
            presented={**state.presented, lid: at(129 if index == 2 else 45)},
            replies={
                **state.replies,
                lid: [{"at": at(answer_at).isoformat(), "option_key": option}],
            },
        )
    now = at(132.001 if failure == "late" else 132)
    result = world(
        {UUID(e["id"]): e for e in plan["events"]},
        state,
        now,
        contact_exts={"caller": {"74951234567"}},
    )
    assert (work.identity[0] not in result.delays) is (failure == "deadline")
    if failure == "deadline":
        assert apply_world([work], result, set())[0].ready_at == at(132)


@pytest.mark.parametrize("code", CODES)
@pytest.mark.parametrize("character", ("calm", "confused"))
def test_authorized_conversation_enters_real_journal(monkeypatch, code, character):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from uuid import uuid4

    from app.api.training import briefing, caller, scenario_events
    from app.api.training.contacts import CardPhone
    from app.core.models import Call, CardEvent
    from app.tools.coherence import caller as dialogue

    plan = parsed_scenario(code)
    plot = plan["caller"]["plot"]
    required = plan["events"][0]["branches"]["met"]["awaits_call"]["required_facts"]
    card = SimpleNamespace(id=uuid4(), assignment_id=uuid4())
    call_id = uuid4()
    active = Call(
        id=call_id,
        card_id=card.id,
        service_id=plan["messages"][0].get("service_id", "GKH"),
        dialed_ext="74951234567",
        direction="outbound",
        answered_at=at(21),
        started_at=at(20),
    )
    phone = CardPhone("GKH", ({"number": "74951234567", "role": "caller", "character": character},))
    monkeypatch.setattr(caller, "caller_plan", AsyncMock(return_value=plan))
    monkeypatch.setattr(caller, "card_phone", AsyncMock(return_value=phone))
    monkeypatch.setattr(briefing, "card_briefings", AsyncMock(return_value=[]))
    monkeypatch.setattr(briefing, "dispatched", AsyncMock(return_value={}))
    monkeypatch.setattr(scenario_events, "said_to_brigades", AsyncMock(return_value={}))
    recorded = []

    async def scalars(query):
        entity = query.column_descriptions[0]["entity"]
        return recorded if entity is CardEvent else []

    db = SimpleNamespace(
        get=AsyncMock(return_value=active),
        scalars=scalars,
        execute=AsyncMock(
            return_value=SimpleNamespace(tuples=lambda: SimpleNamespace(all=lambda: []))
        ),
        info={},
        new=[object()],
        dirty=[],
        deleted=[],
    )
    book = dialogue.book(character, plot)
    memory = dialogue.reply(
        book,
        dialogue.Memory(),
        dialogue.hear("Диспетчер, по вашей заявке.", plot),
        ("17" if plot == "pipe_access" else "98", ""),
    ).memory
    for index, key in enumerate(required):
        heard = dialogue.hear(dialogue.plots()[plot]["facts"][key]["ask"], plot)
        turn = dialogue.reply(book, memory, heard, ("17" if plot == "pipe_access" else "98", ""))
        if turn.memory.facts.get(key) == "first":
            turn = dialogue.reply(
                book, turn.memory, heard, ("17" if plot == "pipe_access" else "98", "")
            )
        for phrase in turn.lines:
            payload = {"call_id": str(call_id), "phrase_id": phrase["id"]}
            asyncio.run(caller.record_caller_line(db, card, payload))
            recorded.append(
                SimpleNamespace(
                    type="caller_said", payload=payload, server_ts=at(30 + index), id=uuid4()
                )
            )
        memory = turn.memory
    snapshot = asyncio.run(
        _load_journal(db, card, statuses=[], calls=[active], events=plan["events"])
    )
    assert set(required) <= {item["key"] for item in snapshot.caller_facts}
    assert all(item["answered_at"] == at(21) for item in snapshot.caller_facts)
    from app.api.training.scenario_events import Firing
    from evalcore.brigade import fired_events

    _, state, work = pending_world(
        code, [call(20, ext="74951234567", brigade=None, answered=21, ended=35)]
    )
    state = replace(state, caller_facts=snapshot.caller_facts)
    for index in (1, 2):
        due = due_events(plan["events"], state, set(), at(40 + index * 5))
        assert [event["id"] for event, _ in due] == [plan["events"][index]["id"]]
        event, moment = due[0]
        eid, lid, crew = UUID(event["id"]), UUID(event["line"]["id"]), UUID(event["brigade_id"])
        state = replace(
            state,
            firings={**state.firings, eid: Firing(eid, moment, "plan")},
            presented={**state.presented, lid: at(40 + index * 5)},
            delivered={**state.delivered, lid: crew},
            replies={
                **state.replies,
                lid: [{"at": at(41 + index * 5).isoformat(), "option_key": "relay"}],
            },
        )
        result = world(
            {UUID(e["id"]): e for e in plan["events"]},
            state,
            at(42 + index * 5),
            contact_exts={"caller": {"74951234567"}},
        )
        ready = apply_world([work], result, set())[0].ready_at
        assert ready == (at(132) if index == 1 else at(51))
    ctx = SimpleNamespace(
        scenario_events=[
            {
                "event": event,
                "fired_at": state.firings[UUID(event["id"])].fired_at.isoformat(),
                "source": "plan",
                "presented_at": state.presented[UUID(event["line"]["id"])].isoformat(),
                "replies": state.replies[UUID(event["line"]["id"])],
            }
            for event in plan["events"]
        ],
        calls=state.calls,
    )
    assert len(fired_events(ctx)) == 3
    assert all(event.outcome.branch == "met" for event in fired_events(ctx))
