"""Модель обучаемого в прогоне связности не говорит поверх бригады (HQ-028).

Ночной прогон 17.10, smoke-apartment-101-1 · alarm:late: «Скорую уже вызвал, едет» уходило на
сервер во время тревоги, а в расшифровке стояло после неё. Сервер не считал фразу ответом на
тревогу и через паузу выдал доклад поверх «Как приняли?», которое окно телефона спросило уже
после «Понял, скорую ждём». Фраза диспетчера уходит, когда звучит: после реплики бригады и
её «Как приняли?».
"""

import asyncio
import json
from datetime import timedelta
from functools import partial
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from app.core.config import ROOT
from app.tools.coherence import phone
from app.tools.coherence.harness import SimClock
from app.tools.coherence.policies import (
    ASKS_VIA_HOLD,
    DEVIATIONS,
    REFERENCE,
    hold_call_target,
    policies_for,
)
from app.tools.coherence.runner import Playing, ScenarioRun, Talk

TOLD = "Скорую уже вызвал, едет."


def run() -> tuple[ScenarioRun, list[tuple[float, str, dict[str, Any]]]]:
    path = ROOT / "data" / "scenarios" / "smoke-apartment-101-1.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    runner = ScenarioRun(None, SimClock(), data, REFERENCE, "trainee")
    runner.brigade_name = "Бригада 201"
    runner.talk = Talk("c1", "brigade", runner.brigade_name, inbound=True, answered_at=0.0)
    sent: list[tuple[float, str, dict[str, Any]]] = []

    async def event(kind: str, payload: dict[str, Any]) -> Any:
        sent.append((runner.t, kind, payload))
        # Звонок в службу дальше не идёт: проверяется только отбой бригаде.
        return SimpleNamespace(status_code=409)

    runner.event = event  # type: ignore[method-assign]
    return runner, sent


def test_open_names_brigade_by_its_target_number():
    runner, sent = run()
    runner.client = SimpleNamespace(
        get=AsyncMock(
            return_value=SimpleNamespace(
                json=lambda: [
                    {"id": "dispatcher", "phone_ext": "101"},
                    {"id": runner.target_id, "phone_ext": "201"},
                ]
            )
        )
    )
    runner.brigade_name = "Бригада"
    asyncio.run(runner._open())
    assert runner.brigade_name == "Бригада 201"
    assert sent[-1][1:] == ("field_change", {"field": "service_number", "value": "201"})


async def due(runner: ScenarioRun) -> None:
    for item in [item for item in runner.plan if item.at <= runner.t]:
        runner.plan.remove(item)
        await item.action()


def test_dispatcher_waits_for_brigade_line_and_confirm_request():
    async def scenario() -> None:
        runner, sent = run()
        # Скорую уже вызвали (GP-28: весть — только после набора номера службы).
        runner.training["service_calls"] = [
            {"service_id": "103", "started_at": runner.clock.start.isoformat()}
        ]
        # Идёт тревога, после неё окно телефона спросит «Как приняли?».
        runner.playing = Playing({}, 6.0, "c1")
        runner.speaking_until = 6.0
        runner.clock.advance(1.0)
        await runner._say_to_brigade(TOLD)
        assert sent == []
        assert [line.text for line in runner.tr.lines] == []

        runner.clock.advance(5.5)
        runner.playing = None
        runner.queue.append(("Бригада 1", "Как приняли?", "client", "confirm_request"))
        await due(runner)
        assert sent == []

        runner.queue.clear()
        runner.speaking_until = 8.0
        runner.clock.advance(2.0)
        await due(runner)
        assert [(kind, payload["text"]) for _, kind, payload in sent] == [("brigade_said", TOLD)]
        said = next(line for line in runner.tr.lines if line.who == "Вы")
        # Фраза ушла на сервер, когда прозвучала, а не раньше реплики бригады.
        assert said.at == sent[0][0] == runner.t
        assert runner.queue[-1][3] == "service_coming"

    asyncio.run(scenario())


def test_dispatcher_speaks_at_once_on_a_free_line():
    async def scenario() -> None:
        runner, sent = run()
        runner.clock.advance(3.0)
        await runner._say_to_brigade(TOLD)
        assert [(at, kind) for at, kind, _ in sent] == [(3.0, "brigade_said")]

    asyncio.run(scenario())


def test_dial_hangs_up_after_the_phrase_and_cuts_the_next_one():
    """Решил звонить в службу — дослушивает фразу бригады и кладёт трубку. Мир он не
    останавливает: следующую реплику окно телефона начинает сразу (useBrigade, `present`), и
    отбой её обрывает — она не предъявлена и прозвучит в следующем разговоре."""

    async def scenario() -> None:
        runner, sent = run()
        assert runner.talk is not None
        runner.talk.heard = True  # бригада уже сказала, зачем звонит
        runner.playing = Playing({}, 5.0, "c1")
        runner.speaking_until = 5.0
        await runner._dial_service("103")
        assert sent == []

        # Фраза кончилась, следующая уже звучит — трубку кладут через полсекунды.
        runner.clock.advance(5.0)
        runner.playing = Playing({}, 9.0, "c1")
        runner.speaking_until = 9.0
        await due(runner)
        assert sent == []
        runner.clock.advance(0.5)
        await due(runner)
        assert [(at, kind) for at, kind, _ in sent] == [(5.5, "call_hangup"), (5.5, "call_dial")]
        assert runner.playing is None  # оборванная реплика не предъявлена

    asyncio.run(scenario())


def test_dial_hears_why_the_brigade_called():
    """Позвонившую бригаду диспетчер сперва выслушивает: «Старший на связи» — ещё не повод."""

    async def scenario() -> None:
        runner, sent = run()
        assert runner.talk is not None
        runner.talk.brigade_id = "b1"
        runner.speaking_until = 2.0
        runner.training["messages"] = [
            {
                "state": "delivered",
                "delivery": {
                    "delivery_id": "d1",
                    "brigade_id": "b1",
                    "delivered_at": "2026-10-17T12:00:00+00:00",
                },
            }
        ]
        await runner._dial_service("103")
        runner.clock.advance(3.0)
        await due(runner)
        assert sent == []

        runner.talk.heard = True
        runner.clock.advance(0.5)
        await due(runner)
        assert [kind for _, kind, _ in sent] == ["call_hangup", "call_dial"]

    asyncio.run(scenario())


# --- HQ-055: «отправил» с удержания, ответ бригады — по окну вести сервера ------------------


def held_run(
    called_s: float | None, news_by_s: float | None, policy_name: str = "сообщает_с_удержания"
) -> tuple[ScenarioRun, list[tuple[float, str, dict[str, Any]]]]:
    """Бригада попросила скорую (выдача с `needs_service`); политика с удержанием."""
    path = ROOT / "data" / "scenarios" / "smoke-apartment-101-1.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    policy = next(item for item in DEVIATIONS if item.name == policy_name)
    runner = ScenarioRun(None, SimClock(), data, policy, "trainee")
    runner.brigade_name = "Бригада 201"
    runner.talk = Talk("c1", "brigade", runner.brigade_name, inbound=True, answered_at=0.0)
    runner.talk.brigade_id = "b1"
    runner.talk.heard = True

    def iso(seconds: float) -> str:
        return (runner.clock.start + timedelta(seconds=seconds)).isoformat()

    delivery: dict[str, Any] = {
        "delivery_id": "d1",
        "call_id": "c1",
        "brigade_id": "b1",
        "needs_service": "103",
        "delivered_at": iso(0),
    }
    if called_s is not None:
        delivery["service_called_at"] = iso(called_s)
    if news_by_s is not None:
        delivery["news_by"] = iso(news_by_s)
    runner.training["messages"] = [{"state": "presented", "delivery": delivery}]
    sent: list[tuple[float, str, dict[str, Any]]] = []

    async def event(kind: str, payload: dict[str, Any]) -> Any:
        sent.append((runner.t, kind, payload))
        return SimpleNamespace(status_code=200)

    runner.event = event  # type: ignore[method-assign]
    return runner, sent


def test_hold_call_service_resume_and_tell_without_naming_it():
    """Удержание → звонок в службу → возврат на линию бригады → «Отправил, ждите»: бригада
    отвечает «Понял, ждём скорую», разговор с ней сервер не прерывал."""

    async def scenario() -> None:
        runner, sent = held_run(called_s=1.0, news_by_s=40.0)
        await runner._dial_service("103", "Отправил, ждите.")
        # Без отбоя бригаде: её линия на удержании (отметка call_hold, HQ-033).
        assert [kind for _, kind, _ in sent] == ["call_hold", "call_dial"]
        assert sent[0][2] == {"call_id": "c1"}
        assert runner.held is not None and runner.held.id == "c1"
        service = runner.talk
        assert service is not None and service.kind == "service"

        runner.clock.advance(10.0)
        await runner._service_done(service)
        assert [kind for _, kind, _ in sent] == [
            "call_hold",
            "call_dial",
            "call_hangup",
            "call_resume",
        ]
        assert sent[2][2]["call_id"] == service.id and sent[3][2] == {"call_id": "c1"}
        assert runner.talk is not None and runner.talk.id == "c1" and runner.held is None
        assert "на связи" in runner.queue[-1][1]

        runner.queue.clear()
        runner.clock.advance(5.0)
        await due(runner)
        said = [(kind, payload) for _, kind, payload in sent if kind == "brigade_said"]
        assert said == [("brigade_said", {"call_id": "c1", "text": "Отправил, ждите."})]
        assert runner.queue[-1][3] == "service_coming"
        assert "скор" in runner.queue[-1][1].lower()

    asyncio.run(scenario())


def test_news_outside_server_window_gets_plain_answer():
    """«Отправил» после приезда службы или «скорая будет» до звонка в 103 — сервер весть не
    засчитает, и окно телефона отвечает обычно, а не «Понял, ждём»."""

    async def scenario() -> None:
        late, _ = held_run(called_s=1.0, news_by_s=5.0)
        late.clock.advance(10.0)
        await late._say_to_brigade("Отправил, ждите.")
        assert late.queue[-1][3] == "ack"

        early, _ = held_run(called_s=None, news_by_s=None)
        await early._say_to_brigade("Скорая будет.")
        assert early.queue[-1][3] == "ack"

    asyncio.run(scenario())


@pytest.mark.parametrize("polled", [True, False])
def test_resume_brigade_while_service_call_goes_on(polled):
    """С удержания — к бригаде, пока звонок в службу идёт (служба ответила, срока вести нет):
    «Отправил, ждите» — «Понял, ждём скорую»; потом снова служба и доклад. Выдача могла ещё
    не принести звонок (`polled=False`, опрос раз в 2 с) — окно верит своему набору."""

    async def scenario() -> None:
        runner, sent = held_run(
            called_s=0.0 if polled else None,
            news_by_s=None,
            policy_name="сообщает_во_время_звонка_в_службу",
        )
        runner.card = {"source": {"address": {"street": "Тверская", "house": "1"}, "number": "1"}}
        await runner._dial_service("103", "Отправил, ждите.")
        service = runner.talk
        assert service is not None and service.kind == "service"
        runner.clock.advance(2.0)
        await due(runner)  # служба отвечает — и на удержание, бригада снова на линии
        assert [kind for _, kind, _ in sent] == [
            "call_hold",
            "call_dial",
            "call_answer",
            "call_hold",
            "call_resume",
        ]
        assert runner.talk is not None and runner.talk.id == "c1" and runner.held is None

        runner.queue.clear()
        for _ in range(20):
            runner.clock.advance(0.5)
            await due(runner)
            if any(kind == "brigade_said" for _, kind, _ in sent):
                break
        said = [payload for _, kind, payload in sent if kind == "brigade_said"]
        assert said == [{"call_id": "c1", "text": "Отправил, ждите."}]
        assert runner.queue[-1][3] == "service_coming"
        assert "скор" in runner.queue[-1][1].lower()

        runner.queue.clear()
        runner.speaking_until = runner.t
        for _ in range(20):
            runner.clock.advance(0.5)
            await due(runner)
            if runner.talk is service:
                break
        # Бригаде — отбой, служба снова на связи; звонок в неё не кончался.
        hangups = [payload["call_id"] for _, kind, payload in sent if kind == "call_hangup"]
        assert hangups == ["c1"] and runner.talk is service
        # Служба снята с удержания (HQ-033): отметка в журнал её звонка.
        assert ("call_resume", {"call_id": service.id}) in [
            (kind, payload) for _, kind, payload in sent
        ]
        for _ in range(60):
            runner.clock.advance(0.5)
            await due(runner)
        hangups = [payload["call_id"] for _, kind, payload in sent if kind == "call_hangup"]
        assert hangups == ["c1", service.id]
        # Сказанного второй раз нет.
        assert [kind for _, kind, _ in sent].count("brigade_said") == 1

    asyncio.run(scenario())


# --- HQ-039: «Как приняли?» до удержания — после снятия бригада переспрашивает -------------


def test_resumed_phrase_without_waiting_says_on_the_line():
    service = run()[0].service
    assert "на связи" in phone.resumed_phrase(service, waiting_confirm=False).lower()
    asked = phone.resumed_phrase(service, waiting_confirm=True)
    assert asked == phone.confirm_request_phrase(service)


@pytest.mark.parametrize("answers_late", [False, True])
def test_hold_after_confirm_request_resume_asks_again_and_gets_confirm(answers_late):
    """Бригада спросила «Как приняли?», диспетчер сразу поставил её на удержание и звонит в
    службу. Снятая с удержания бригада переспрашивает (ключ `confirm_request`), эталон
    отвечает «Принял» — и `report_confirmed` уходит на сервер. `answers_late`: служба отвечает
    позже, чем назначен «Принял» (heard + 2,7 с), — пока бригада на удержании, ответ ждёт."""

    async def scenario() -> None:
        runner, sent = held_run(
            called_s=0.0, news_by_s=None, policy_name="сообщает_во_время_звонка_в_службу"
        )
        runner.card = {"source": {"address": {"street": "Тверская", "house": "1"}, "number": "1"}}
        runner.asked["c1"] = 0.0  # «Как приняли?» прозвучало
        runner.later(2.7, "«Принял»", partial(runner._confirm, {"delivery_id": "d1"}))
        if answers_late:
            runner.clock.advance(1.0)  # служба ответит на 3,0 с — позже «Принял»
        await runner._dial_service("103", "Отправил, ждите.")
        assert runner.held is not None and runner.held.id == "c1"

        resumed = None
        for _ in range(80):
            runner.clock.advance(0.5)
            await due(runner)
            await runner._phone()
            if resumed is None:
                resumed = next(
                    (line for line in runner.tr.lines if line.key == "confirm_request"), None
                )
            if any(kind == "report_confirmed" for _, kind, _ in sent):
                break
        assert resumed is not None and resumed.who == "Бригада 201"
        assert resumed.text == phone.confirm_request_phrase(runner.service)
        confirmed = [payload for _, kind, payload in sent if kind == "report_confirmed"]
        assert confirmed == [{"call_id": "c1", "delivery_id": "d1", "text": "Принял."}]
        kinds = [kind for _, kind, _ in sent]
        # «Принял» — бригаде на линии, после снятия с удержания и до отбоя ей.
        assert kinds.index("call_resume") < kinds.index("report_confirmed")
        assert "call_hangup" not in kinds
        assert "c1" not in runner.asked
        answer = next(line for line in runner.tr.lines if line.key == "confirm")
        assert answer.call == "c1" and answer.at >= (resumed.end or 0.0)

    asyncio.run(scenario())


# --- HQ-058: вопрос с вариантами до удержания — после снятия бригада повторяет его ----------

QUESTION = "Хозяева дома будут?"


def test_resumed_phrase_repeats_open_question():
    service = run()[0].service
    assert phone.resumed_phrase(service, waiting_confirm=False, question=QUESTION) == QUESTION
    assert phone.resumed_phrase(service, waiting_confirm=False, question=None) == (
        phone.resumed_phrase(service, waiting_confirm=False)
    )


@pytest.mark.parametrize("answers_late", [False, True])
def test_hold_after_question_resume_repeats_it_and_gets_reply(answers_late):
    """Бригада задала вопрос с вариантами ответа, диспетчер поставил её на удержание и звонит в
    службу. Снятая с удержания бригада повторяет свой вопрос (ключ `question_repeat`, а не
    «на связи»), эталон отвечает вариантом после повтора — `brigade_reply` уходит на сервер.
    `answers_late`: ответ назначен на время удержания — он ждёт снятия и повтора."""

    async def scenario() -> None:
        runner, sent = held_run(
            called_s=0.0, news_by_s=None, policy_name="сообщает_во_время_звонка_в_службу"
        )
        runner.card = {"source": {"address": {"street": "Тверская", "house": "1"}, "number": "1"}}
        question: dict[str, Any] = {
            "delivery_id": "q1",
            "call_id": "c1",
            "brigade_id": "b1",
            "delivered_at": runner.clock.start.isoformat(),
            "message": {"id": "m-q1", "version": 1, "text": QUESTION, "audio": None},
            "reply_options": [
                {"key": "yes", "label": "Да, будут"},
                {"key": "no", "label": "Нет"},
            ],
        }
        runner.training["messages"].append({"state": "presented", "delivery": question})
        runner.presented.add("q1")
        runner.later(
            2.5 if answers_late else 0.5,
            "ответ бригаде",
            partial(runner._reply, question, "yes"),
        )
        await runner._dial_service("103", "Отправил, ждите.")
        assert runner.held is not None and runner.held.id == "c1"

        repeated = None
        for _ in range(80):
            runner.clock.advance(0.5)
            await due(runner)
            await runner._phone()
            if repeated is None:
                repeated = next(
                    (line for line in runner.tr.lines if line.key == "question_repeat"), None
                )
            if any(kind == "brigade_reply" for _, kind, _ in sent):
                break
        assert repeated is not None and repeated.who == "Бригада 201"
        assert repeated.text == QUESTION and repeated.meta["options"] == ["yes", "no"]
        # «На связи» поверх вопроса не звучит.
        assert not any("на связи" in line.text.lower() for line in runner.tr.lines)
        replies = [payload for _, kind, payload in sent if kind == "brigade_reply"]
        assert replies == [
            {"call_id": "c1", "delivery_id": "q1", "option_key": "yes", "mode": "option"}
        ]
        kinds = [kind for _, kind, _ in sent]
        assert kinds.index("call_resume") < kinds.index("brigade_reply")
        answer = next(line for line in runner.tr.lines if line.key == "reply:yes")
        assert answer.call == "c1" and answer.at >= (repeated.end or 0.0)
        assert not runner.tr.errors

    asyncio.run(scenario())


def test_caller_call_waits_for_confirm():
    """Ответив бригаде, диспетчер звонит заявителю — но не поверх её «Как приняли?»: сначала
    «Принял» (прогон связности 18.10, animal-shaft-gkh-1 · эталон, `confirm_unanswered`)."""

    async def scenario() -> None:
        runner, sent = run()
        runner.asked["c1"] = 0.0  # бригада спросила «Как приняли?»
        await runner._call_caller()
        assert sent == []
        runner.asked.pop("c1")  # «Принял» прозвучал
        runner.clock.advance(0.5)
        await due(runner)
        assert [kind for _, kind, _ in sent] == ["call_hangup", "call_dial"]

    asyncio.run(scenario())


# --- HQ-058, круг 2: политика «уточняет с удержания» -----------------------------------------


def scenario_data(code: str) -> dict[str, Any]:
    path = ROOT / "data" / "scenarios" / f"{code}.json"
    return json.loads(path.read_text(encoding="utf-8"))


def test_asks_via_hold_policy_where_there_is_whom_to_call():
    """Политика есть у сценария с вопросом бригады и тем, кому позвонить: живой заявитель или
    служба из просьбы бригады; нет ни того ни другого — её нет."""
    assert hold_call_target(scenario_data("animal-shaft-gkh-1")) == "caller"
    assert hold_call_target(scenario_data("smoke-apartment-101-1")) == "103"
    assert hold_call_target(scenario_data("unwell-street-103-2")) is None
    names = [policy.name for policy in policies_for(scenario_data("smoke-apartment-101-1"))]
    assert ASKS_VIA_HOLD.name in names
    names = [policy.name for policy in policies_for(scenario_data("unwell-street-103-2"))]
    assert ASKS_VIA_HOLD.name not in names


def asked_question(runner: ScenarioRun) -> dict[str, Any]:
    question: dict[str, Any] = {
        "delivery_id": "q1",
        "call_id": "c1",
        "brigade_id": "b1",
        "delivered_at": runner.clock.start.isoformat(),
        "message": {"id": "m-q1", "version": 1, "text": QUESTION, "audio": None},
        "reply_options": [{"key": "yes", "label": "Да, будут"}, {"key": "no", "label": "Нет"}],
    }
    runner.training["messages"] = [{"state": "presented", "delivery": question}]
    runner.presented.add("q1")
    return question


def test_asks_via_hold_calls_service_then_answers_repeated_question():
    """Вопрос с вариантами — удержание, звонок в службу сценария, снятие: бригада повторяет
    вопрос, диспетчер отвечает на повтор (ответ отложен до снятия, а не перепланируется)."""

    async def scenario() -> None:
        data = scenario_data("smoke-apartment-101-1")
        runner = ScenarioRun(None, SimClock(), data, ASKS_VIA_HOLD, "trainee")
        runner.talk = Talk("c1", "brigade", "Бригада 1", inbound=True, answered_at=0.0)
        runner.talk.brigade_id = "b1"
        runner.card = {"source": {"address": {"street": "Тверская", "house": "1"}, "number": "1"}}
        sent: list[tuple[float, str, dict[str, Any]]] = []

        async def event(kind: str, payload: dict[str, Any]) -> Any:
            sent.append((runner.t, kind, payload))
            return SimpleNamespace(status_code=200)

        runner.event = event  # type: ignore[method-assign]
        question = asked_question(runner)
        await runner._ask_via_hold(question, "yes")
        assert [kind for _, kind, _ in sent] == ["call_hold", "call_dial"]
        assert sent[1][2]["phone_ext"] == "103"
        assert [what for what, *_ in runner.on_resume] == ["ответ бригаде"]
        for _ in range(80):
            runner.clock.advance(0.5)
            await due(runner)
            await runner._phone()
            if any(kind == "brigade_reply" for _, kind, _ in sent):
                break
        repeated = next(line for line in runner.tr.lines if line.key == "question_repeat")
        assert repeated.text == QUESTION
        kinds = [kind for _, kind, _ in sent]
        assert kinds.index("call_resume") < kinds.index("brigade_reply")
        answer = next(line for line in runner.tr.lines if line.key == "reply:yes")
        assert answer.at >= (repeated.end or 0.0)
        assert not runner.on_resume and not runner.tr.errors

    asyncio.run(scenario())


def news_after_question(runner: ScenarioRun, reply_by_s: float) -> dict[str, Any]:
    """Вопрос со сроком ответа `reply_by_s` и новость, выданная сервером через 8 с после него
    (`ANSWER_PAUSE`), пока бригада на удержании."""
    question = asked_question(runner)
    question["reply_by"] = (runner.clock.start + timedelta(seconds=reply_by_s)).isoformat()
    news: dict[str, Any] = {
        "delivery_id": "w1",
        "call_id": "c1",
        "brigade_id": "b1",
        "delivered_at": (runner.clock.start + timedelta(seconds=8)).isoformat(),
        "message": {"id": "m-w1", "version": 1, "text": "Вскрываем.", "audio": None},
    }
    runner.training["messages"].append({"state": "delivered", "delivery": news})
    return question


def test_resume_in_deadline_repeats_question_and_holds_news():
    """Срок вопроса не прошёл, а сервер уже выдал новость (он ждёт ответа только 8 с): снятая
    с удержания бригада повторяет вопрос и придерживает новость до ответа (HQ-058, решение
    капитана 18.10): ответ диспетчера, затем новость."""

    async def scenario() -> None:
        runner, sent = held_run(called_s=None, news_by_s=None)
        assert runner.talk is not None
        question = news_after_question(runner, reply_by_s=30.0)
        await runner._hold(runner.talk)
        runner.clock.advance(12.0)  # удержание 12 с: вопрос ещё в сроке
        await runner._resume()
        assert [key for *_, key in runner.queue] == ["question_repeat"]
        # Диспетчер думает над ответом 6 с — новость ждёт его, а не звучит после повтора.
        runner.later(6.0, "ответ бригаде", partial(runner._reply, question, "yes"))
        for _ in range(60):
            runner.clock.advance(0.5)
            await due(runner)
            await runner._phone()
            if any(line.text == "Вскрываем." for line in runner.tr.lines):
                break
        texts = [line.text for line in runner.tr.lines if line.who != ""]
        repeat = texts.index(QUESTION)
        reply = next(i for i, line in enumerate(runner.tr.lines) if line.key == "reply:yes")
        news = next(i for i, line in enumerate(runner.tr.lines) if line.text == "Вскрываем.")
        assert repeat >= 0 and reply < news
        assert [kind for _, kind, _ in sent].count("brigade_reply") == 1
        assert not any("на связи" in text.lower() for text in texts)

    asyncio.run(scenario())


def test_held_news_waits_for_deadline_without_answer():
    """Повторив вопрос, бригада ждёт ответа не дольше срока: без ответа новость звучит, как
    только срок прошёл (`_holds_news`)."""

    async def scenario() -> None:
        runner, _ = held_run(called_s=None, news_by_s=None)
        assert runner.talk is not None
        news_after_question(runner, reply_by_s=20.0)
        await runner._hold(runner.talk)
        runner.clock.advance(12.0)
        await runner._resume()
        heard_at = None
        for _ in range(60):
            runner.clock.advance(0.5)
            await due(runner)
            await runner._phone()
            line = next((item for item in runner.tr.lines if item.text == "Вскрываем."), None)
            if line is not None:
                heard_at = line.at
                break
        assert heard_at is not None and heard_at >= 20.0

    asyncio.run(scenario())


def test_resume_after_deadline_says_news_and_drops_reply():
    """Срок вопроса истёк на удержании (событие пропущено): бригада вопрос не повторяет —
    «на связи» и новость; отложенный ответ на непрозвучавший вопрос не отправляется, вопроса
    больше нет (incoming.ts `resumedSay`, `dropped`). «Принял» на «Как приняли?» остаётся."""

    async def scenario() -> None:
        runner, sent = held_run(called_s=None, news_by_s=None)
        assert runner.talk is not None
        question = news_after_question(runner, reply_by_s=10.0)
        await runner._hold(runner.talk)
        confirm = SimpleNamespace(called=False)

        async def confirmed() -> None:
            confirm.called = True

        runner.on_resume += [
            ("ответ бригаде", partial(runner._reply, question, "yes"), "q1"),
            ("«Принял»", confirmed, None),
        ]
        runner.clock.advance(12.0)
        await runner._resume()
        assert [key for *_, key in runner.queue] == ["answer"]
        assert "на связи" in runner.queue[0][1].lower()
        assert runner._open_question() is None
        for _ in range(30):
            runner.clock.advance(0.5)
            await due(runner)
            await runner._phone()
        assert confirm.called
        assert "brigade_reply" not in [kind for _, kind, _ in sent]
        assert any(line.text == "Вскрываем." for line in runner.tr.lines)

    asyncio.run(scenario())


def test_failed_caller_dial_resumes_held_brigade():
    """Набор заявителя не прошёл (сервер отказал), а бригада на удержании: диспетчер снова к
    ней — снимает с удержания, она повторяет вопрос, отложенный ответ уходит."""

    async def scenario() -> None:
        runner, sent = held_run(called_s=None, news_by_s=None)
        assert runner.talk is not None
        question = asked_question(runner)
        runner.card = {"source": {"address": {"street": "Тверская", "house": "1"}, "number": "1"}}
        await runner._hold(runner.talk)
        runner.on_resume.append(("ответ бригаде", partial(runner._reply, question, "yes"), "q1"))

        async def event(kind: str, payload: dict[str, Any]) -> Any:
            sent.append((runner.t, kind, payload))
            return SimpleNamespace(status_code=409 if kind == "call_dial" else 200)

        runner.event = event  # type: ignore[method-assign]
        await runner._dial_caller()
        assert runner.held is None and runner.talk is not None and runner.talk.id == "c1"
        assert [key for *_, key in runner.queue] == ["question_repeat"]
        for _ in range(30):
            runner.clock.advance(0.5)
            await due(runner)
            await runner._phone()
        assert "brigade_reply" in [kind for _, kind, _ in sent]

    asyncio.run(scenario())
