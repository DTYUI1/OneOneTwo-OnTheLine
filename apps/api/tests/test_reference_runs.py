"""Эталонное прохождение каждого сценария каталога — без ложных замечаний (TC-10).

Для каждого файла `data/scenarios/*.json` собирается попытка, какой её сделал бы опытный
диспетчер по памятке ДДС: карточку прочитал (10 с) и принял с комментарием, бригаде
передал вводную, на каждый доклад ответил и поставил его статус, на события бригады
отреагировал верно и в срок (поправил адрес, ответил на вопрос, вызвал скорую, позвонил
молчащей бригаде), в конце — итог в комментарии и номер наряда. Оценщик видит сценарий
так же, как worker (`handle_evaluate`): карточка, эталон, план докладов, события бригады,
звонки, проверка текста по словарю со улицами сценария.

Ожидание: ни одного замечания и ни одной потери балла — «ложное замечание дороже
пропуска» (docs/competitors/touches.md, «Обратная связь и разбор»). Время — по журналу
событий (без I-TIME): методика времени проверяется своими тестами. ИИ-судья комментария
(comment_completeness, comment_clarity) — модель в worker, здесь не вызывается.
"""

import asyncio
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from app.core.config import ROOT
from app.core.spelling import for_scenario
from app.seed.scenarios import SCENARIOS_DIR, load_catalog, scenario_row, training_plan
from evalcore.defaults import (  # type: ignore[import-untyped]
    BRIGADE_WEIGHTS,
    COMMENT_WEIGHTS,
    CRITERIA,
)
from evalcore.models import EvalContext  # type: ignore[import-untyped]
from evalcore.remarks import STATE_LABELS  # type: ignore[import-untyped]
from evalcore.scoring import evaluate  # type: ignore[import-untyped]

SERVICES = {item["id"] for item in json.loads((ROOT / "data/phonebook.json").read_text("utf-8"))}
START = datetime(2026, 10, 16, 9, 0, tzinfo=UTC)
SETTINGS: dict[str, Any] = {
    "reaction_normative_s": 30,
    "handling_normative_s": 180,
    "critical_cap": 0.5,
    "weights": {**dict.fromkeys(CRITERIA, 1.0), **COMMENT_WEIGHTS, **BRIGADE_WEIGHTS},
    "parallel_cards": 1,
    "hints_level": 0,
    "report_choice_factor": 0.5,
}
# Сколько опытный диспетчер тратит на шаг: прочитать карточку, ответить на вызов бригады,
# дослушать доклад и поставить статус, отреагировать на реплику события.
READ_S = 10
ANSWER_S = 2
STATUS_S = 6
REACT_S = 4


async def _no_audio(path: str, text: str) -> None:
    return None


class Attempt:
    """Журнал попытки: события карточки, звонки, предъявления докладов и события бригады."""

    def __init__(self, data: dict[str, Any], plan: dict[str, Any]) -> None:
        self.data = data
        self.plan = plan
        self.events: list[dict[str, Any]] = []
        self.calls: list[dict[str, Any]] = []
        self.presented: dict[str, str] = {}
        self.fired: list[dict[str, Any]] = []
        self.comment: list[str] = []

    @staticmethod
    def at(second: float) -> str:
        return (START + timedelta(seconds=second)).isoformat()

    def event(self, second: float, kind: str, payload: dict[str, Any] | None = None) -> None:
        stamp = self.at(second)
        self.events.append(
            {
                "client_event_id": str(uuid4()),
                "client_ts": stamp,
                "server_ts": stamp,
                "clock_offset_ms": 0,
                "type": kind,
                "payload": payload or {},
            }
        )

    def call(
        self,
        second: float,
        *,
        service_id: str,
        phone_ext: str,
        brigade_id: str | None = None,
        direction: str = "outbound",
        talk_s: float = 8,
    ) -> float:
        """Звонок: набор (или вызов бригады) в `second`, ответ через ANSWER_S; конец разговора."""
        answered = second + ANSWER_S
        self.calls.append(
            {
                "id": str(uuid4()),
                "service_id": service_id,
                "phone_ext": phone_ext,
                "brigade_id": brigade_id,
                "direction": direction,
                "refusal": None,
                "started_at": self.at(second),
                "answered_at": self.at(answered),
                "ended_at": self.at(answered + talk_s),
                "transcript": None,
            }
        )
        return answered

    def status(self, second: float, state: str) -> None:
        self.event(second, "status_change", {"state": state, "comment": " ".join(self.comment)})


def _text(line: Any) -> str:
    return line if isinstance(line, str) else str(line["text"])


def reference_attempt(data: dict[str, Any]) -> EvalContext:
    """Эталонная попытка по файлу сценария: как оценщик увидит её после закрытия карточки."""
    plan = asyncio.run(training_plan(data, _no_audio))
    row = scenario_row(data)
    service = data["service_id"]
    attempt = Attempt(data, plan)
    attempt.event(0, "deliver")
    attempt.event(2, "open")
    # Комментарий при «Принята»: что случилось и решение — направлена бригада.
    attempt.comment = [data["card"]["description"], "Направлена бригада."]
    now = 2 + READ_S
    accepted = "accepted" in row["reference"]["expected_flow"]
    if accepted:
        attempt.status(now, "accepted")
    else:
        # Не своя карточка перенаправляется: бригада по её плану не выезжает.
        attempt.comment = [row["reference"]["expected_comment"]]
        attempt.status(now, "rejected")
        now += STATUS_S
        attempt.event(
            now,
            "redirect",
            {
                "service_id": row["reference"]["expected_service_ids"][0],
                "comment": " ".join(attempt.comment),
            },
        )
    expected_call = row["reference"]["expected_call"]
    settings = dict(SETTINGS)
    if expected_call.get("contact_role"):
        # Каталог добавил обязательный звонок заявителю: эталон делает его сам.
        settings["phone_contacts"] = {
            service: [{"number": expected_call["phone_ext"], "role": expected_call["contact_role"]}]
        }
        now = attempt.call(now, service_id=service, phone_ext=expected_call["phone_ext"])
    brigade = plan["messages"][0]["brigade_id"]
    # Прямой номер бригады плана: по нему эталон звонит и его пишет в «Номер наряда».
    brigade_ext = "201"
    # Вводная бригаде: звонок по прямому номеру, бригада повторяет адрес.
    if accepted:
        now = attempt.call(now + 2, service_id=service, phone_ext=brigade_ext, brigade_id=brigade)
    dispatched = now
    events = plan.get("events", [])
    state = "accepted"
    pending = list(plan["messages"]) if accepted else []
    while pending:
        message = next(item for item in pending if item["requires_state"] == state)
        pending.remove(message)
        # Бригада звонит с докладом сама; диспетчер отвечает и слушает.
        ring = max(now, dispatched) + message["available_after_s"]
        heard = attempt.call(
            ring,
            service_id=service,
            phone_ext=brigade_ext,
            brigade_id=message["brigade_id"],
            direction="inbound",
        )
        attempt.presented[message["message"]["id"]] = attempt.at(heard)
        now = heard
        for event in events:
            trigger = event["trigger"]
            if trigger["on"] == "message" and trigger["message_id"] == message["message"]["id"]:
                now = max(now, react(attempt, event, heard + trigger["after_s"], service))
        attempt.comment.append(_text(message["message"]["text"]))
        state = message["justifies_state"]
        now += STATUS_S
        attempt.status(now, state)
        if pending:
            # Молчание бригады на этапе: опытный диспетчер звонит ей сам.
            for event in events:
                trigger = event["trigger"]
                upcoming = next(item for item in pending if item["requires_state"] == state)
                silent = trigger["on"] == "no_contact" and trigger["state"] == state
                if silent and upcoming["available_after_s"] > trigger["silent_s"]:
                    now = max(now, react(attempt, event, now + trigger["silent_s"], service))
    current = {"service_number": brigade_ext, "comment": " ".join(attempt.comment)}
    scenario = {
        "id": str(row["id"]),
        "version": row["version"],
        "level": row["level"],
        "weight": row["weight"],
        "incident_type_code": row["incident_type_code"],
        "target_service_id": row["target_service_id"],
        "card": row["card"],
        "reference": row["reference"],
        "complications": row["complications"],
    }
    return EvalContext(
        scenario=scenario,
        current=current,
        events=attempt.events,
        calls=attempt.calls,
        settings=settings,
        # Номер наряда сверяется с бригадой, направленной на карточку (не своя — без бригады).
        brigade_numbers=(brigade_ext,) if accepted else (),
        text_checker=for_scenario((), row["card"], row["reference"]),
        planned_messages=tuple(
            {
                "message_id": item["message"]["id"],
                "justifies_state": item["justifies_state"],
                "presented_at": attempt.presented.get(item["message"]["id"]),
            }
            for item in plan["messages"]
            if accepted
        ),
        scenario_events=tuple(attempt.fired),
    )


def react(attempt: Attempt, event: dict[str, Any], fired: float, service: str) -> float:
    """Событие бригады сработало в `fired`; верная реакция в срок. Вернуть, когда закончили."""
    heard = fired + 1 if event["line"] is not None else fired
    replies: list[dict[str, Any]] = []
    said: list[dict[str, Any]] = []
    done = heard
    for expect in event["expect"]:
        action = expect["action"]
        if action in {"reply", "correct_readback"}:
            done = heard + REACT_S
            replies.append({"at": attempt.at(done), "option_key": expect["option_key"]})
        elif action == "call_service":
            ext = str(expect["phone_exts"][0])
            done = attempt.call(heard + REACT_S, service_id=ext, phone_ext=ext)
            # HQ-055: после вызова диспетчер сообщает бригаде, что служба едет.
            said.append({"at": attempt.at(done + 1), "text": "Службу вызвал, уже едет."})
        elif action == "call_brigade":
            done = attempt.call(
                heard + REACT_S, service_id=service, phone_ext="201", brigade_id=event["brigade_id"]
            )
    attempt.fired.append(
        {
            "event": event,
            "fired_at": attempt.at(fired),
            "source": "plan",
            "presented_at": attempt.at(heard) if event["line"] is not None else None,
            "replies": replies,
            "said": said,
        }
    )
    return done


CATALOG = load_catalog(SERVICES).scenarios


def test_catalog_is_not_empty():
    assert len(CATALOG) == len(list(SCENARIOS_DIR.glob("*.json"))) > 0


@pytest.mark.parametrize("data", CATALOG, ids=lambda data: data["code"])
def test_reference_run_has_no_false_remarks(data):
    result = evaluate(reference_attempt(data))
    lost = {item.key: item.explanation for item in result.criteria if item.score < 1}
    found = {item.key: item.remarks for item in result.criteria if item.remarks}
    assert lost == {}
    assert found == {}
    assert result.critical_flags == []
    assert result.total == 1


@pytest.mark.parametrize("data", CATALOG, ids=lambda data: data["code"])
def test_reference_run_without_final_status_is_noticed(data):
    """Проверка не пустая: без итогового статуса — замечание с последствием и памяткой."""
    ctx = reference_attempt(data)
    final = ctx.events[-1]
    assert final["type"] in {"status_change", "redirect"}
    result = evaluate(replace(ctx, events=ctx.events[:-1]))
    errors = [item for item in result.criteria if item.score < 1]
    second = "routing" if final["type"] == "redirect" else "handling_time"
    assert {item.key for item in errors} >= {"status_flow", second}
    for item in errors:
        assert item.remarks, item.key
        for remark in item.remarks:
            assert remark.consequence and remark.memo_page > 0
            assert remark.repeat.startswith("Повтор")
    status = next(item for item in errors if item.key == "status_flow")
    label = STATE_LABELS["redirected" if final["type"] == "redirect" else final["payload"]["state"]]
    assert status.remarks[0].text == f"Не поставлен статус «{label}»."


def test_brigade_events_of_reference_run_are_evaluated():
    """Сценарий с событиями бригады: все плановые события сработали и засчитаны в срок."""
    data = next(item for item in CATALOG if item["code"] == "smoke-apartment-101-1")
    ctx = reference_attempt(data)
    kinds = [item["event"]["kind"] for item in ctx.scenario_events]
    assert kinds == ["readback_error", "clarify", "request_service", "silence"]
    work = next(item for item in evaluate(ctx).criteria if item.key == "brigade_work")
    assert work.score == 1 and work.weight == 1 and work.remarks == ()


def test_wrong_readback_reply_shows_what_happened_in_the_world():
    """«Понял» на повтор адреса с ошибкой: последствие — подменённый доклад бригады."""
    data = next(item for item in CATALOG if item["code"] == "smoke-apartment-101-1")
    ctx = reference_attempt(data)
    fired = [dict(item) for item in ctx.scenario_events]
    readback = next(item for item in fired if item["event"]["kind"] == "readback_error")
    readback["replies"] = [
        {**readback["replies"][0], "option_key": "ok", "mode": "voice", "text": "Понял, едете"}
    ]
    result = evaluate(replace(ctx, scenario_events=tuple(fired)))
    work = next(item for item in result.criteria if item.key == "brigade_work")
    assert work.critical
    remark = work.remarks[0]
    assert remark.consequence.startswith("Бригада потом доложила: «Диспетчер, по тому адресу")
    assert remark.quote == "Понял, едете"
    assert (
        remark.repeat == "Повторите: сразу поправьте расчёт — «Поправка по адресу: "
        "Бескудниковский бульвар, 24»."
    )


def test_wrong_floor_answer_shows_the_brigade_reply_and_delay():
    """Неверный ответ на вопрос бригады: последствие — её ответ и задержка доклада о работах."""
    data = next(item for item in CATALOG if item["code"] == "smoke-apartment-101-1")
    ctx = reference_attempt(data)
    fired = [dict(item) for item in ctx.scenario_events]
    floor = next(item for item in fired if item["event"]["kind"] == "clarify")
    floor["replies"] = [{**floor["replies"][0], "option_key": "unknown"}]
    result = evaluate(replace(ctx, scenario_events=tuple(fired)))
    work = next(item for item in result.criteria if item.key == "brigade_work")
    (remark,) = work.remarks
    assert remark.consequence == (
        "Бригада ответила: «Ясно. Ищем сами, это займёт время.» "
        "Доклады бригады задержались на 60 с."
    )
    assert remark.repeat == "Повторите: ответьте бригаде «Девятый этаж»."
    assert remark.quote is None
