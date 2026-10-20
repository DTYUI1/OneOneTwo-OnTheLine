"""Переиспользование записей заявителя: книги → реальный exporter в памяти → разговор.

Ни экспорт в checkout, ни БД, ни провайдеры здесь не вызываются.
"""

import hashlib
import importlib.util
import json
from types import ModuleType
from typing import Any

import pytest
from app.core.config import ROOT
from app.tools.coherence import caller

BANK = ROOT / "scripts/voices/bank"
PLOTS = ("pipe_access", "lift_location")
NEUTRAL = {
    "answer",
    "answer_again",
    "ask_who",
    "unknown",
    "repeat",
    "not_understood",
    "agree",
    "no_reply",
    "hangup",
    "end_call",
}
HISTORICAL = {
    "CALLER_CALM": "8d17df299ac84a14dbf70fe42198f0abcaa1124b7215feeea10007541f0234c7",
    "CALLER_CONFUSED": "47081668a419a06dfb15645462da2a2c41fe5eda5cd1ee678cef6da8054e4a4b",
}
FACTS_HASH = "1dc480e7753f0d499a18dcf82cbb400b0c63a34b4fc3405e2d2d09de69acb8b6"


def digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()


def load_book(service: str) -> dict[str, Any]:
    return dict(json.loads((BANK / "callers" / f"{service}.json").read_text()))


def exporter() -> ModuleType:
    spec = importlib.util.spec_from_file_location("caller_reuse_web", BANK / "web.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def neutral_recordings(book: dict[str, Any]) -> list[dict[str, Any]]:
    # Эти две исторические реплики говорят о животном и не нейтральны.
    excluded = {
        "CALLER_CALM.unknown.animal_shaft.2",
        "CALLER_CONFUSED.ask_who.animal_shaft.2",
    }
    return [
        phrase
        for phrase in book["phrases"]
        if ".animal_shaft." in phrase["id"]
        and phrase["slot"] in NEUTRAL
        and phrase["id"] not in excluded
    ]


@pytest.mark.parametrize("service", HISTORICAL)
@pytest.mark.parametrize("plot", PLOTS)
def test_new_plots_reuse_only_historical_neutral_recordings(service: str, plot: str) -> None:
    book = load_book(service)
    neutral = neutral_recordings(book)
    assert len(neutral) == 16
    for phrase in neutral:
        assert plot in phrase["incidents"], phrase["id"]
        assert not phrase["tells"]
    selected = [p for p in book["phrases"] if plot in p["incidents"] and p["slot"] in NEUTRAL]
    assert {p["id"] for p in selected} == {p["id"] for p in neutral}


@pytest.mark.parametrize("service", HISTORICAL)
def test_historical_phrases_and_all_plot_facts_remain_exact(service: str) -> None:
    book = load_book(service)
    old = [
        {key: value for key, value in phrase.items() if key != "incidents"}
        for phrase in book["phrases"]
        if ".animal_shaft." in phrase["id"]
    ]
    assert digest(old) == HISTORICAL[service]
    assert digest({key: book[key] for key in ("plot_facts", "plot_facts_by_plot")}) == FACTS_HASH
    for phrase in book["phrases"]:
        if ".animal_shaft." in phrase["id"] and phrase not in neutral_recordings(book):
            assert phrase["incidents"] == ["animal_shaft"]


def test_reused_recordings_reach_real_exporter_without_writing() -> None:
    web = exporter()
    before = web.TARGET.read_bytes()
    data = json.loads(web.build())
    audio = web.audio()
    recorded = {
        item["id"]: item
        for path in (ROOT / "data/voices").glob("bank-v*/manifest.json")
        for item in json.loads(path.read_text())["messages"]
        if "id" in item
    }
    for service in HISTORICAL:
        old = [p for p in load_book(service)["phrases"] if ".animal_shaft." in p["id"]]
        for phrase in old:
            item = recorded[phrase["id"]]
            assert item["text"] == phrase["text"]
            assert (
                hashlib.sha256((ROOT / "data/voices" / item["path"]).read_bytes()).hexdigest()
                == item["sha256"]
            )
        rows = [p for slot in data["books"][service]["slots"].values() for p in slot]
        for phrase in neutral_recordings(load_book(service)):
            row = next(p for p in rows if p["id"] == phrase["id"])
            assert set(PLOTS) <= set(row["only"].split(","))
            assert (
                hashlib.sha256(audio[f"{phrase['id']}.ogg"]).hexdigest()
                == recorded[phrase["id"]]["sha256"]
            )
    assert web.TARGET.read_bytes() == before


@pytest.mark.parametrize("character", ("calm", "confused"))
@pytest.mark.parametrize(
    "plot,house", (("animal_shaft", "22"), ("pipe_access", "17"), ("lift_location", "98"))
)
def test_candidate_books_converse_with_reused_greeting_and_complete_facts(
    monkeypatch: pytest.MonkeyPatch, character: str, plot: str, house: str
) -> None:
    # Настоящий generator и parser; подменяется только чтение ещё не экспортированного файла.
    data = json.loads(exporter().build())
    monkeypatch.setattr(caller.phone, "bank", lambda: data)
    book = caller.book(character, plot)
    turn = caller.pick_up(book, caller.Memory())
    assert turn.lines and all(".answer.animal_shaft." in p["id"] for p in turn.lines)
    assert turn.memory.facts == {}
    memory = caller.reply(
        book, turn.memory, caller.hear("Диспетчер, по вашей заявке.", plot), (house, "")
    ).memory
    for key, item in caller.plots()[plot]["facts"].items():
        heard = caller.hear(item["ask"], plot)
        turn = caller.reply(book, memory, heard, (house, ""))
        if turn.memory.facts.get(key) == "first":
            assert not any(caller.facts_of(p) for p in turn.lines)
            turn = caller.reply(book, turn.memory, heard, (house, ""))
        assert key in {fact for p in turn.lines for fact in caller.facts_of(p)}
        assert turn.memory.facts[key] == "full"
        assert all(plot in p["only"].split(",") for p in turn.lines)
        memory = turn.memory
    for slot in NEUTRAL:
        assert book.slot(slot)
        assert all(".animal_shaft." in p["id"] for p in book.slot(slot))
