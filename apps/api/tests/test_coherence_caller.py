"""HQ-019: правила живого заявителя в прогоне связности — те же, что в окне телефона.

Таблицы примеров `apps/web/src/arm/softphone/caller/conversation.cases.json` (разговор) и
`hearing.cases.json` (распознавание фразы диспетчера) проверяются и vitest (`cases.test.ts`), и
здесь: зеркало правил `app.tools.coherence.caller` отвечает теми же фразами книги, что
`conversation.ts`, и понимает фразу так же, как `hearing.ts`.
"""

import json
from typing import Any

import pytest
from app.core.config import ROOT
from app.tools.coherence import caller

CALLER = ROOT / "apps/web/src/arm/softphone/caller"
CASES = json.loads((CALLER / "conversation.cases.json").read_text("utf-8"))
HEARING = json.loads((CALLER / "hearing.cases.json").read_text("utf-8"))


def run(character: str, steps: list[dict[str, Any]]) -> list[list[str]]:
    book = caller.book(character, CASES["plot"])
    address = (CASES["address"]["house"], CASES["address"]["flat"])
    memory = caller.Memory()
    out: list[list[str]] = []
    for step in steps:
        turn = None
        if step.get("pickup"):
            turn = caller.pick_up(book, memory)
        elif step.get("silence"):
            turn = caller.silence(book, memory)
        elif "hungup" in step:
            memory = caller.hung_up(memory, step["hungup"])
        elif "say" in step:
            say = step["say"]
            heard = caller.Heard(tuple(say["asks"]), say["service"], say["reason"], say["yes"])
            turn = caller.reply(book, memory, heard, address)
        if turn is None:
            out.append([])
            continue
        memory = turn.memory
        said = [".".join(p["id"].split(".")[1::2]) for p in turn.lines]
        out.append([*said, "HANGUP"] if turn.hangup else said)
    return out


@pytest.mark.parametrize("case", CASES["cases"], ids=lambda case: case["name"])
def test_caller_rules_match_phone_window(case):
    assert run(case["character"], case["steps"]) == case["expect"]


@pytest.mark.parametrize("case", HEARING["cases"], ids=lambda case: case["text"] or "(пусто)")
def test_caller_hears_like_phone_window(case):
    heard = caller.hear(case["text"], HEARING["plot"], HEARING["street"])
    assert heard == caller.Heard(tuple(case["asks"]), case["service"], case["reason"], case["yes"])
    if "numbers" in case:
        assert [value for value, _ in caller.numbers_in(case["text"])] == case["numbers"]


@pytest.mark.parametrize("plot", sorted(caller.plots()))
def test_caller_plot_questions_heard_as_meant(plot):
    """Вопросы таблицы сюжета (кнопки окна и реплики политики прогона) узнаются как задуманы."""
    table = caller.plots()[plot]
    for fact, item in table["facts"].items():
        assert caller.hear(item["ask"], plot).asks == (fact,), item["ask"]
    assert caller.hear(table["come"], plot).asks == ("come",)


@pytest.mark.parametrize(
    "plot,required", [("pipe_access", ("where", "eta", "box")), ("lift_location", ("where", "box"))]
)
@pytest.mark.parametrize("character", ["calm", "confused"])
def test_come_requires_full_facts(plot, required, character):
    book = caller.book(character, plot)
    memory = caller.Memory(service=True, reason=True)

    def say(text):
        nonlocal memory
        turn = caller.reply(book, memory, caller.hear(text, plot), ("22", "58"))
        memory = turn.memory
        return turn

    assert say(caller.plots()[plot]["come"]).lines == ()
    for fact in required:
        question = caller.plots()[plot]["facts"][fact]["ask"]
        say(question)
        if memory.facts[fact] != "full":
            assert say(caller.plots()[plot]["come"]).lines == ()
            say(question)
    assert ".agree." in say(caller.plots()[plot]["come"]).lines[0]["id"]
    assert memory.came
    assert ".end_call." in say("До свидания").lines[0]["id"]
    memory = caller.Memory(service=True, reason=True)
    early = say("До свидания")
    assert early.hangup and not early.lines
    assert not memory.came
    memory = caller.pick_up(book, caller.hung_up(memory, True)).memory
    assert say(caller.plots()[plot]["come"]).lines == ()
    assert not any(".agree." in p["id"] for p in say("Повторите").lines)


@pytest.mark.parametrize("plot", ["pipe_access", "lift_location"])
def test_last_fact_then_come_is_sequential(plot):
    book = caller.book("calm", plot)
    memory = caller.Memory(service=True, reason=True, facts={"where": "full", "eta": "full"})
    box = caller.plots()[plot]["facts"]["box"]["ask"]
    come = caller.plots()[plot]["come"]
    before = caller.reply(book, memory, caller.hear(f"{come} {box}", plot), ("22", "58"))
    assert not before.memory.came
    assert not any(".agree." in phrase["id"] for phrase in before.lines)
    after = caller.reply(book, memory, caller.hear(f"{box} {come}", plot), ("22", "58"))
    assert after.memory.came
    assert ".agree." in after.lines[-1]["id"]
