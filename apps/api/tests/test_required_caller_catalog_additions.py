"""Two distinct caller additions through the real catalog/parser; no database or TTS."""

import asyncio
import json
from datetime import UTC, datetime, timedelta

import pytest
from app.api.training.caller import caller_phrases, caller_plots, tells_fact
from app.core.config import ROOT
from app.seed.scenarios import SCENARIOS_DIR, read_file, training_plan
from app.tools.coherence import caller
from app.worker.generators import gameplay
from evalcore.brigade import answered_call, awaited_call, otherwise_of, targets_of

CASES = [
    ("pipe-access-gkh-2", "pipe_access", "GKH", "17", ("where", "eta", "box")),
    ("lift-location-moslift-2", "lift_location", "MOSLIFT", "98", ("where", "box")),
]


@pytest.mark.parametrize("code,plot,service,house,keys", CASES)
def test_required_caller_addition_loads_and_converses(code, plot, service, house, keys):
    path = SCENARIOS_DIR / f"{code}.json"
    assert path.is_file(), f"Missing distinct mandatory caller scenario: {code}"
    data = read_file(path, set(gameplay.SERVICES))
    assert data["caller"]["plot"] == plot
    assert data["service_id"] == service
    assert plot in caller_plots()
    assert data["reference"]["expected_call"]["required"] is True
    assert data["reference"]["expected_call"]["contact_role"] == "caller"
    assert data["card"]["address"] == data["reference"]["expected_address"]
    assert code in {item["code"] for item in gameplay.templates()}

    async def no_audio(path, text):
        return None

    parsed = asyncio.run(training_plan(data, no_audio))
    assert parsed["caller"]["plot"] == plot
    assert parsed["outcome"] == data["outcome"]
    gated = [event for event in parsed["events"] if awaited_call(event, "met")]
    assert len(gated) == 1
    awaits = awaited_call(gated[0], "met")
    assert awaits["contact_role"] == "caller"
    assert otherwise_of(awaits)
    assert targets_of(gated[0])
    since = datetime(2026, 10, 19, tzinfo=UTC)
    dial = {"phone_ext": "74951234567", "dialed_at": since.isoformat()}
    assert answered_call([dial], {"74951234567"}, since) is None
    assert (
        answered_call(
            [{**dial, "answered_at": (since + timedelta(seconds=1)).isoformat()}],
            {"74951234567"},
            since,
        )
        is not None
    )

    table = caller.plots()[plot]
    assert set(keys) == {key for key, item in table["facts"].items() if item.get("key")}
    for character in ("calm", "confused"):
        book = caller.book(character, plot)
        picked = caller.pick_up(book, caller.Memory())
        assert picked.lines
        assert not any(tells_fact(phrase) for phrase in picked.lines)
        # Answering alone gives no plot facts. This is deliberately separate from
        # awaits_call: its existing contract gates answered_at, not conversation.
        assert picked.memory.facts == {}
        memory = picked.memory
        intro = caller.reply(
            book, memory, caller.hear("Диспетчер, по вашей заявке.", plot), (house, "")
        )
        memory = intro.memory
        for fact, item in table["facts"].items():
            heard = caller.hear(item["ask"], plot)
            assert heard.asks == (fact,), item["ask"]
            turn = caller.reply(book, memory, heard, (house, ""))
            if turn.memory.facts.get(fact) == "first":
                assert not any(caller.facts_of(phrase) for phrase in turn.lines)
                turn = caller.reply(book, turn.memory, heard, (house, ""))
            assert turn.lines, (character, plot, fact)
            assert fact in {value for phrase in turn.lines for value in caller.facts_of(phrase)}
            assert turn.memory.facts[fact] == "full"
            assert all(plot in phrase.get("only", "").split(",") for phrase in turn.lines)
            assert all(
                "котён" not in phrase["text"].lower() and "Кировоград" not in phrase["text"]
                for phrase in turn.lines
            )
            memory = turn.memory
        assert set(keys) <= {fact for fact, state in memory.facts.items() if state == "full"}
        assert caller.hear(table["come"], plot).asks == ("come",)
        for phrase in caller_phrases().values():
            if phrase["id"].startswith(book.id + ".") and plot in phrase["incidents"]:
                assert "audio" not in phrase


def test_original_caller_plot_and_flat_metadata_are_preserved():
    old = read_file(SCENARIOS_DIR / "animal-shaft-gkh-1.json", set(gameplay.SERVICES))
    assert old["caller"]["plot"] == "animal_shaft"
    assert (
        "Кировоградская" in old["card"]["description"]
        or old["card"]["address"]["street"] == "Кировоградская улица"
    )
    for name in ("CALLER_CALM", "CALLER_CONFUSED"):
        book = json.loads((ROOT / "scripts/voices/bank/callers" / f"{name}.json").read_text())
        assert book["plot_facts"]["eta"] == "будет минут через пять"
        assert "Кировоградская" in book["plot_facts"]["address"]
        assert book["plot_facts_by_plot"]["pipe_access"]["address"].startswith("улица Пришвина, 17")
        assert book["plot_facts_by_plot"]["lift_location"]["address"].startswith(
            "Профсоюзная улица, 98"
        )


@pytest.mark.parametrize("character", ["calm", "confused"])
def test_full_lift_address_readback_confirms(character):
    book = caller.book(character, "lift_location")
    facts = json.loads((ROOT / "scripts/voices/bank/callers" / f"{book.id}.json").read_text())[
        "plot_facts_by_plot"
    ]["lift_location"]
    memory = caller.reply(
        book,
        caller.Memory(),
        caller.hear("Диспетчер, по вашей заявке.", "lift_location"),
        ("98", ""),
    ).memory
    turn = caller.reply(
        book,
        memory,
        caller.hear(
            f"{facts['address'].split('.')[0]}, верно?", "lift_location", "Профсоюзная улица"
        ),
        ("98", ""),
    )
    assert len(turn.lines) == 1
    assert ".confirm_address." in turn.lines[0]["id"]
    assert "Номер квартиры здесь не нужен" not in turn.lines[0]["text"]


def test_pipe_late_reply_matches_missing_basement_access_in_real_world():
    from dataclasses import replace
    from uuid import UUID

    from app.api.training.scenario_events import apply_world, world

    from .test_live_brigade import at, call, journal, report

    data = read_file(SCENARIOS_DIR / "pipe-access-gkh-2.json", set(gameplay.SERVICES))

    async def no_audio(path, text):
        return None

    parsed = asyncio.run(training_plan(data, no_audio))
    event = parsed["events"][0]
    event_id, line_id, crew = (
        UUID(event["id"]),
        UUID(event["line"]["id"]),
        UUID(event["brigade_id"]),
    )
    work_id = UUID(event["branches"]["late"]["effects"][0]["replace"])
    state = journal(
        presented={line_id: 10},
        firings={event_id: 9},
        replies={line_id: [(100, "ask_caller")]},
        calls=[
            call(0, brigade=crew, answered=1),
            call(40, ext="458", brigade=None, answered=50, ended=51),
        ],
    )
    state = replace(
        state, delivered={line_id: crew}, heard_from={crew: [at(10)]}, briefed={crew: at(1)}
    )
    work = replace(
        report(work_id, 20),
        brigade_id=crew,
        target_id=UUID(event["call_target_id"]),
        planned={
            **report(work_id, 20).planned,
            "brigade_id": str(crew),
            "call_target_id": event["call_target_id"],
        },
    )
    result = world({event_id: event}, state, at(101), contact_exts={"caller": {"458"}})
    scheduled = apply_world([work], result, set())
    texts = [item.planned["message"]["text"] for item in scheduled]
    assert texts == [
        "Подвал так и не открыли. Качаем через продух, шланг в окошко кинули.",
        "Диспетчер, ключи от подвала у кого? Там замок висит.",
    ]
    assert event["branches"]["late"]["line"] is None
    assert "Уже нашли сами." not in texts
    assert "Подвал так и не открыли. Качаем через продух, шланг в окошко кинули." in texts
    assert event["branches"]["late"]["effects"][1]["by_s"] == 40
    assert scheduled[0].ready_at >= at(100)
