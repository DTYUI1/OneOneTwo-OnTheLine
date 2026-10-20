"""«Живая бригада» в идущем занятии (DT-10): события плана — когда, что говорит, что меняется.

Событие сценария (`TrainingPlan.events`, contracts/scenario-events.md, «Принято 08.10») —
уточнение, просьба о другой службе, молчание, тревога, повтор адреса с ошибкой. Здесь три
вещи:

1. **Когда срабатывает** (`due_events`): по статусу, после доклада плана, по молчанию бригады,
   после ветки другого события. Срабатывание записывается (`ScenarioEventFiring`) один раз;
   вводная преподавателя — то же событие, поданное вручную (`fire_event_now`, для DT-06).
2. **Что говорит бригада** (`world`): реплика события и реплика ветки выдаются тем же путём,
   что доклады плана, — `gating.report_schedule` добавляет их в расписание, worker выдаёт в
   идущий разговор или бригада звонит сама.
3. **Что меняется в мире**: доклад плана, на который действуют последствия события, ждёт его
   исхода (не дольше срока), затем `delay` отодвигает его, `replace` меняет содержание.
   Карточку событие не блокирует (решение 08.10, вопрос 6).

Тревога не врывается в разговор с той же бригадой (решение 15.10): бригада дожидается отбоя
и через `ALARM_AFTER_CALL` звонит отдельным тревожным вызовом, сроки — от этого звонка. Пока
тревога не взята и идёт тревожный разговор, новая карточка обучаемому не приходит
(`alarm_holds_cards`): 30 с её реакции не должны идти, пока он правильно занят тревогой.

Исход события — `evalcore.brigade.resolve_event`, та же функция, что в разборе: мир и оценка
не расходятся. Чистые функции получают снимок журнала (`Journal`), работа с БД — в `load_*`
и функциях с `db`.
"""

import copy
from collections.abc import Iterable, Mapping, Sequence
from collections.abc import Set as AbstractSet
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from typing import Any, cast
from uuid import UUID, uuid4

from evalcore.brigade import (  # type: ignore[import-untyped]
    SERVICE_ARRIVAL_S,
    EventOutcome,
    ahead_window,
    answered_call,
    awaited_call,
    effects_of,
    expectation_deadline,
    news_window,
    otherwise_of,
    resolve_event,
    service_called_at,
    targets_of,
)
from evalcore.service_told import (  # type: ignore[import-untyped]
    reply_says_service_called,
)
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.training.brigades import card_crew
from app.api.training.content import plan_for_assignment
from app.api.training.gating import (
    ScheduledReport,
    delayed,
    reached_at,
    report_stage,
    status_history,
)
from app.api.training.turns import (
    ANSWER_PAUSE,
    CONFIRM_ASK,
    OPEN,
    Quiet,
    Turn,
    asks_confirmation,
    quiet,
)
from app.core.evaluation_details import call_context
from app.core.models import (
    Assignment,
    Call,
    Card,
    CardEvent,
    MessageDelivery,
    MessagePresentation,
    Scenario,
    ScenarioEventFiring,
)
from app.core.read_cache import remembered
from app.seed.world_lexicon import RANK, STAGE_AFTER, stage_window

Crew = dict[UUID, tuple[UUID, UUID]]


@dataclass(frozen=True)
class Firing:
    event_id: UUID
    fired_at: datetime
    source: str


@dataclass(frozen=True)
class Journal:
    """Снимок журнала карточки, по которому мир решает, что дальше."""

    statuses: list[tuple[str, datetime]]
    # Сообщение (доклад плана или реплика события) → первое предъявление.
    presented: dict[UUID, datetime]
    # Сообщение → бригада, которой оно выдано.
    delivered: dict[UUID, UUID]
    # Бригада → моменты предъявления её реплик (для «на связи»).
    heard_from: dict[UUID, list[datetime]]
    # Реплика события → ответы бригаде [{at, option_key}] (+ как дан ответ, `reply_record`).
    replies: dict[UUID, list[dict[str, Any]]]
    # Звонки карточки, вид call_context (все направления).
    calls: list[dict[str, Any]]
    firings: dict[UUID, Firing]
    # Бригада → когда выехала по вводной (GP-05, `briefing.dispatched`).
    briefed: dict[UUID, datetime] = field(default_factory=dict)
    # Бригада → что диспетчер ей сказал [{at, text, via?}]: фразы разговора (`brigade_said`)
    # и вводные (`brigade_briefing`, `via: "briefing"`) — для правила «служба вызвана
    # заранее» (GP-28) и поправки повтора адреса фразой (HQ-024).
    said: dict[UUID, list[dict[str, Any]]] = field(default_factory=dict)
    # Реплики бригады, после которых она ждёт ответа (очередь реплик, `turns`).
    turns: list[Turn] = field(default_factory=list)
    # Реплика → когда диспетчер был на линии в разговоре, где она впервые прозвучала (ответ на
    # вызов бригады или её ответ на звонок диспетчера): с этого момента реплика шла уже к нему.
    on_line_since: dict[UUID, datetime] = field(default_factory=dict)
    # Только полные, разрешённые сценарием сведения заявителя → время получения.
    caller_facts: list[dict[str, Any]] = field(default_factory=list)


class EventNotApplicable(Exception):
    """Вводную сейчас подать нельзя; текст причины — для преподавателя."""


# Пауза между отбоем разговора с бригадой и её тревожным вызовом (и после тревожного
# разговора — до новой карточки). Перебить доклад на полуслове надёжно нельзя: оборванный
# доклад то ли услышан, то ли нет, а от этого зависят статусы карточки.
ALARM_AFTER_CALL = timedelta(seconds=10)


# --- Чистые правила -----------------------------------------------------------------------


def _time(value: Any) -> datetime | None:
    return datetime.fromisoformat(value) if isinstance(value, str) else None


def cast_event(event: dict[str, Any], crew: Crew | None) -> dict[str, Any]:
    """Событие от бригады, которая исполняет роль бригады плана (как доклады, `card_crew`)."""
    planned = UUID(event["brigade_id"])
    if not crew or planned not in crew:
        return event
    brigade, target = crew[planned]
    return {**event, "brigade_id": str(brigade), "call_target_id": str(target)}


def line_id(message: dict[str, Any] | None) -> UUID | None:
    return UUID(message["id"]) if message else None


def dispatched_at(brigade: UUID, journal: Journal) -> datetime | None:
    """Бригада работает по карточке: выехала по вводной диспетчера (GP-05)."""
    return journal.briefed.get(brigade)


def on_line(brigade: UUID, journal: Journal) -> bool:
    """Идёт разговор с бригадой или она звонит сама — она на связи сейчас."""
    return any(
        call["brigade_id"] == str(brigade)
        and _time(call["ended_at"]) is None
        and (_time(call["answered_at"]) is not None or call["direction"] == "inbound")
        for call in journal.calls
    )


def last_contact(brigade: UUID, journal: Journal) -> datetime | None:
    """Когда бригада последний раз была на связи: её реплику услышали или с ней говорили.

    None — связи ещё не было. Не зависит от часов: проекция при той же ревизии одна и та же.
    Это и «давно без доклада» на табло сил, и триггер `no_contact`: одно правило вместе с
    `on_line`.
    """
    moments = list(journal.heard_from.get(brigade, []))
    for call in journal.calls:
        if call["brigade_id"] != str(brigade):
            continue
        answered, ended = _time(call["answered_at"]), _time(call["ended_at"])
        if answered is not None and ended is not None:
            moments.append(ended)
    return max(moments, default=None)


def spoken_s(line: UUID | None, fired_at: datetime, journal: Journal) -> float:
    """Сколько реплика события шла до диспетчера, когда он уже был на линии: от срабатывания
    или ответа на вызов (что позже) до конца реплики. Ожидание ответа на вызов — его время."""
    if line is None:
        return 0.0
    heard = journal.presented.get(line)
    since = journal.on_line_since.get(line)
    if heard is None or since is None:
        return 0.0
    return max(0.0, (heard - max(fired_at, since)).total_seconds())


def outcome_of(
    event: dict[str, Any], firing: Firing, journal: Journal, now: datetime | None
) -> EventOutcome:
    """Исход сработавшего события к моменту `now` (evalcore — та же функция, что в разборе)."""
    line = line_id(event["line"])
    outcome: EventOutcome = resolve_event(
        event,
        firing.fired_at,
        journal.presented.get(line) if line else None,
        journal.replies.get(line, []) if line else [],
        [call for call in journal.calls if call["direction"] == "outbound"],
        now,
        journal.said.get(UUID(event["brigade_id"]), []),
        reached_at("accepted", journal.statuses),
        spoken_s(line, firing.fired_at, journal),
    )
    return outcome


def engaged(brigade: UUID, journal: Journal) -> bool:
    """С бригадой есть незавершённый звонок: идущий, набираемый диспетчером или её вызов."""
    return any(
        call["brigade_id"] == str(brigade) and _time(call["ended_at"]) is None
        for call in journal.calls
    )


def alarm_at(brigade: UUID, journal: Journal, at: datetime) -> datetime | None:
    """Когда тревоге бригады можно сработать не раньше `at`; None — пока с ней звонок.

    После отбоя — не раньше чем через `ALARM_AFTER_CALL`: бригада звонит отдельно, а не
    дописывает тревогу в только что законченный разговор.
    """
    if engaged(brigade, journal):
        return None
    ended = [
        moment
        for call in journal.calls
        if call["brigade_id"] == str(brigade) and (moment := _time(call["ended_at"])) is not None
    ]
    return max(at, max(ended) + ALARM_AFTER_CALL) if ended else at


def alarm_holds_cards(events: Iterable[dict[str, Any]], journal: Journal, now: datetime) -> bool:
    """Тревога на карточке занимает обучаемого — новая карточка подождёт.

    Тревога сработала и не взята (но не дольше её срока: проигнорированная тревога не
    останавливает выдачу), идёт разговор, в котором её услышали, или с его отбоя не прошло
    `ALARM_AFTER_CALL`. События — уже от исполнителя (`cast_event`).
    """
    for event in events:
        firing = journal.firings.get(UUID(event["id"]))
        line = line_id(event["line"])
        if firing is None or event["priority"] != "alarm" or line is None:
            continue
        heard = journal.presented.get(line)
        if heard is None:
            if now < firing.fired_at + longest_wait(event):
                return True
            continue
        talks = [
            (answered, _time(call["ended_at"]))
            for call in journal.calls
            if call["brigade_id"] == event["brigade_id"]
            and (answered := _time(call["answered_at"])) is not None
            and answered <= heard
        ]
        if not talks:
            continue
        _, ended = max(talks, key=lambda talk: talk[0])
        if ended is None or now < ended + ALARM_AFTER_CALL:
            return True
    return False


def caller_facts_at(journal: Journal, required: Sequence[str], since: datetime) -> datetime | None:
    """Когда получены все полные сведения в новом отвеченном звонке заявителю."""
    heard: dict[str, datetime] = {}
    for item in journal.caller_facts:
        if item["answered_at"] >= since and item["at"] >= item["answered_at"]:
            key = item["key"]
            heard[key] = min(heard.get(key, item["at"]), item["at"])
    if not required or not all(key in heard for key in required):
        return None
    return max(heard[key] for key in required)


def trigger_at(
    event: dict[str, Any],
    events: dict[UUID, dict[str, Any]],
    journal: Journal,
    reporting: set[UUID],
    now: datetime,
    carried: AbstractSet[UUID] = frozenset(),
) -> datetime | None:
    """Когда событие плана должно сработать; None — условия ещё нет (или только вводной).

    `reporting` — бригады, у которых остались невыданные доклады плана: молчание
    отработавшей бригады событием не считается. Тревога ещё и ждёт отбоя (`alarm_at`).
    `carried` — события, чью реплику говорит доклад плана (повтор адреса в докладе о выезде,
    `carried_events`): они срабатывают, как только доклад прозвучал.
    """
    at = _planned_at(event, events, journal, reporting, now, carried)
    if at is None or event["priority"] != "alarm":
        return at
    return alarm_at(UUID(event["brigade_id"]), journal, at)


def _planned_at(
    event: dict[str, Any],
    events: dict[UUID, dict[str, Any]],
    journal: Journal,
    reporting: set[UUID],
    now: datetime,
    carried: AbstractSet[UUID] = frozenset(),
) -> datetime | None:
    trigger = event["trigger"]
    brigade = UUID(event["brigade_id"])
    on = trigger["on"]
    if on == "message":
        presented = journal.presented.get(UUID(trigger["message_id"]))
        after = 0 if UUID(event["id"]) in carried else trigger["after_s"]
        return presented + timedelta(seconds=after) if presented else None
    if on == "event":
        parent = journal.firings.get(UUID(trigger["event_id"]))
        parent_event = events.get(UUID(trigger["event_id"]))
        if parent is None or parent_event is None:
            return None
        outcome = outcome_of(parent_event, parent, journal, now)
        if outcome.branch != trigger["branch"] or outcome.at is None:
            return None
        at = cast(datetime, outcome.at) + timedelta(seconds=trigger["after_s"])
        awaits = awaited_call(parent_event, outcome.branch)
        if awaits and awaits.get("required_facts"):
            # Верные варианты передачи не выдаются до полного ответа заявителя.
            facts = caller_facts_at(
                journal, cast(Sequence[str], awaits["required_facts"]), parent.fired_at
            )
            deadline = outcome.at + timedelta(seconds=cast(float, awaits["within_s"]))
            if facts is None or max(at, facts) > deadline or now > deadline:
                return None
            at = max(at, facts)
        return at
    if on not in {"state", "no_contact"}:
        return None
    reached = reached_at(trigger["state"], journal.statuses)
    started = dispatched_at(brigade, journal)
    if reached is None or started is None:
        return None
    base = max(reached, started)
    if on == "state":
        return base + timedelta(seconds=trigger["after_s"])
    if brigade not in reporting:
        return None
    if on_line(brigade, journal):
        return None
    contact = last_contact(brigade, journal)
    return max(base, contact or base) + timedelta(seconds=trigger["silent_s"])


def due_events(
    events: Sequence[dict[str, Any]],
    journal: Journal,
    reporting: set[UUID],
    now: datetime,
    carried: AbstractSet[UUID] = frozenset(),
) -> list[tuple[dict[str, Any], datetime]]:
    """События плана, которым пора сработать: (событие, момент срабатывания ≤ now).

    Событие с репликой ждёт очереди бригады (`turns`): пока она ждёт ответа на свой вопрос
    или «Как приняли?», новый вопрос она не задаёт — срок события идёт от того, когда она
    спросила. Тревога и реплика, которую говорит доклад (`carried`), очереди не ждут.
    """
    by_id = {UUID(event["id"]): event for event in events}
    gates = quiet(journal.turns)
    due = []
    for event in events:
        if UUID(event["id"]) in journal.firings:
            continue
        at = trigger_at(event, by_id, journal, reporting, now, carried)
        if (
            at is not None
            and event["line"] is not None
            and event["priority"] != "alarm"
            and UUID(event["id"]) not in carried
        ):
            at = gates.get(UUID(event["brigade_id"]), OPEN).ready(at)
        if at is not None and at <= now:
            due.append((event, at))
    return due


def carried_events(
    events: Iterable[dict[str, Any]], messages: Iterable[dict[str, Any]]
) -> dict[UUID, UUID]:
    """Событие → доклад плана, который говорит его реплику (проверка 17.10).

    Повтор адреса с ошибкой (`readback_error`) на докладе о выезде — это и есть ответ бригады
    на вводную: «Как поняли? Бескудниковский переулок, двадцать четыре, выезжаем!». Отдельной
    репликой после доклада «Бригада выехала» он противоречил сказанному («выехала» →
    «выезжаем») и дублировал выезд. Поэтому реплику ловушки говорит сам доклад о выезде:
    он обосновывает «Начало реагирования», событие срабатывает, как только доклад прозвучал,
    а ответить на повтор можно вариантом прямо на этот доклад.
    """
    departures = {
        UUID(planned["message"]["id"])
        for planned in messages
        if report_stage(planned) == "responding"
    }
    return {
        UUID(event["id"]): UUID(event["trigger"]["message_id"])
        for event in events
        if event["kind"] == "readback_error"
        and event["line"] is not None
        and event["trigger"]["on"] == "message"
        and UUID(event["trigger"]["message_id"]) in departures
    }


def following_reports(messages: Sequence[dict[str, Any]]) -> dict[UUID, UUID]:
    """Доклад плана → следующий доклад той же бригады по порядку плана."""
    result: dict[UUID, UUID] = {}
    last: dict[str, UUID] = {}
    for planned in messages:
        brigade = str(planned["brigade_id"])
        current = UUID(planned["message"]["id"])
        if brigade in last:
            result[last[brigade]] = current
        last[brigade] = current
    return result


# Вызванная служба едет к месту: следующий доклад бригады, который событие держит («хозяина
# забрала скорая»), — не раньше её приезда, а не в момент звонка диспетчера. Проверка 17.10:
# «вызвал скорую — и не успел сообщить, а они уже всё сделали». За это время диспетчер
# успевает сказать бригаде, что служба едет. Укладывается в паузу 40 с (gating).
SERVICE_ARRIVAL = timedelta(seconds=SERVICE_ARRIVAL_S)
# Ветки, в которых службу вызвали: она едет.
CALLED_BRANCHES = ("met", "late", "already")


def report_stages(messages: Iterable[dict[str, Any]]) -> dict[UUID, str]:
    """Доклад плана → этап бригады после него (`world_lexicon`: в пути, на месте, итог)."""
    result: dict[UUID, str] = {}
    for planned in messages:
        state = report_stage(planned)
        if state in STAGE_AFTER:
            result[UUID(planned["message"]["id"])] = STAGE_AFTER[state]
    return result


def stage_ready(
    text: str,
    brigade: UUID,
    targets: Iterable[UUID],
    at: datetime,
    journal: Journal,
    stages: Mapping[UUID, str],
) -> datetime | None:
    """Когда ответ ветки можно сказать по этапу бригады; None — после доклада, которого нет.

    Проверка 17.10: «Поздно, мы уже внутри.» звучало до доклада «На месте…» — поздний ответ
    (`late`) по смыслу принадлежит этапу позже текущего. Такой ответ ждёт, пока прозвучит
    доклад, который событие держит или подменяет (`targets_of`) и который обосновывает этап
    фразы (`world_lexicon.stage_window`): сначала «На месте», потом «Поздно, мы уже внутри».
    Бригада уже на этом этапе или ни один доклад-цель этап не обосновывает — ответ сразу.
    """
    window = stage_window(text)
    low = RANK[window.lo]
    if window.reason is None or low == 0:
        return at
    reached = [
        moment
        for message, moment in journal.presented.items()
        if journal.delivered.get(message) == brigade
        and message in stages
        and RANK[stages[message]] >= low
    ]
    if reached:
        return max(at, min(reached))
    if any(RANK[stages[key]] >= low for key in targets if key in stages):
        return None
    return at


def longest_wait(event: dict[str, Any]) -> timedelta:
    return timedelta(seconds=max(expect["within_s"] for expect in event["expect"]))


@dataclass(frozen=True)
class WorldLine:
    """Реплика бригады от мира: событие или ответ ветки."""

    message: dict[str, Any]
    brigade_id: UUID
    target_id: UUID
    # None — ответ ждёт доклада, который обосновывает его этап (`stage_ready`).
    ready_at: datetime | None
    # Ответ ветки на действие диспетчера (а не реплика события).
    answer: bool = False
    # Тревога проходит вне очереди обычных реплик, но не отменяет ожидание их ответа.
    alarm: bool = False


@dataclass(frozen=True)
class World:
    lines: list[WorldLine]
    # Доклад плана → не раньше (ждёт исхода события).
    holds: dict[UUID, datetime]
    # Доклад плана → на сколько секунд позже (delay).
    delays: dict[UUID, int]
    # Доклад плана → другое содержание (replace).
    replacements: dict[UUID, dict[str, Any]]
    # Доклад плана → реплика события, которую он говорит (`carried_events`).
    carried: dict[UUID, dict[str, Any]] = field(default_factory=dict)
    # Бригада → когда она может начать новую реплику (очередь реплик, `turns`).
    quiet: dict[UUID, Quiet] = field(default_factory=dict)
    # Реплики-вопросы (с вариантами ответа): после них бригада ждёт ответа.
    questions: frozenset[UUID] = frozenset()


def world(
    events: dict[UUID, dict[str, Any]],
    journal: Journal,
    now: datetime,
    carried: Mapping[UUID, UUID] | None = None,
    following: Mapping[UUID, UUID] | None = None,
    stages: Mapping[UUID, str] | None = None,
    contact_exts: Mapping[str, AbstractSet[str]] | None = None,
) -> World:
    """Что мир делает к моменту `now` по сработавшим событиям (события — уже от исполнителя).

    `carried` — событие → доклад, который говорит его реплику (`carried_events`);
    `following` — доклад → следующий доклад той же бригады (`following_reports`): событие,
    которое срабатывает после доклада X, звучит до следующего доклада — вопрос из дороги не
    задаётся с места (проверка 17.10); `stages` — доклад → этап после него (`report_stages`):
    ответ ветки этапа позже текущего ждёт доклада этого этапа (`stage_ready`);
    `contact_exts` — роль абонента телефона ДДС → её номера на занятии
    (`phone_contacts`): по ним ветка с `awaits_call` узнаёт, позвонил ли диспетчер.
    """
    carried = carried or {}
    following = following or {}
    stages = stages or {}
    contact_exts = contact_exts or {}
    lines: list[WorldLine] = []
    holds: dict[UUID, datetime] = {}
    delays: dict[UUID, int] = {}
    replacements: dict[UUID, dict[str, Any]] = {}
    carrying = {
        report: events[event_id]["line"]
        for event_id, report in carried.items()
        if event_id in events and events[event_id]["line"] is not None
    }
    for waiting in events.values():
        trigger = waiting["trigger"]
        if UUID(waiting["id"]) in journal.firings or trigger["on"] != "message":
            continue
        said = journal.presented.get(UUID(trigger["message_id"]))
        nxt = following.get(UUID(trigger["message_id"]))
        if said is None or nxt is None:
            continue
        # Событие ещё не сработало — следующий доклад его ждёт.
        after = 0 if UUID(waiting["id"]) in carried else trigger["after_s"]
        moment = said + timedelta(seconds=after)
        holds[nxt] = max(holds.get(nxt, moment), moment)
    for firing in sorted(journal.firings.values(), key=lambda item: item.fired_at):
        event = events.get(firing.event_id)
        if event is None:
            continue
        brigade, target = UUID(event["brigade_id"]), UUID(event["call_target_id"])
        outcome = outcome_of(event, firing, journal, now)
        # Служба вызвана заранее и бригаду предупредили (GP-28): бригада не просит и не
        # отвечает — событие решено в момент срабатывания. Реплику, которую говорит доклад
        # плана (`carried`), отдельно не выдаём.
        if event["line"] and not outcome.silent and firing.event_id not in carried:
            lines.append(
                WorldLine(
                    event["line"],
                    brigade,
                    target,
                    firing.fired_at,
                    alarm=event["priority"] == "alarm",
                )
            )
        # Ответ на реплику ждут от того, как её услышали (evalcore.brigade.resolve_expectation).
        heard_line = line_id(event["line"])
        heard_at = journal.presented.get(heard_line) if heard_line else None
        start = (
            max(firing.fired_at, heard_at)
            if heard_at is not None
            and any(item["action"] in ("reply", "correct_readback") for item in event["expect"])
            else firing.fired_at + timedelta(seconds=spoken_s(heard_line, firing.fired_at, journal))
        )
        until: datetime = (
            outcome.at
            if outcome.branch is not None and outcome.at is not None
            else start + longest_wait(event)
        )
        # Тревога со звонком в службу (ожидание call_service) — как просьба: доклад, который
        # её ветка подменяет («напарника забрала скорая»), ждёт приезда службы.
        if (
            (event["kind"] == "request_service" or service_called_at(outcome) is not None)
            and outcome.branch in CALLED_BRANCHES
            and outcome.at is not None
        ):
            until = outcome.at + SERVICE_ARRIVAL
            if service_called_at(outcome) is not None:
                # Весть «едет» не означает приезд (HQ-055): ждём 20 с после отбоя
                # службе, даже если бригаде уже сообщили. Пока звонок идёт, срок не известен.
                window = news_window(event, outcome, journal.calls)
                arrival = window[1] if window is not None else None
                until = max(until, arrival or now + SERVICE_ARRIVAL)
        targets = {UUID(message_id) for message_id in targets_of(event)}
        if event["kind"] == "alarm" and service_called_at(outcome) is None:
            # Тревога держит доклад, только когда службу вызвали (ждём её приезда). Пока не
            # вызвали или не вызвали вовсе, доклад звучит прежним, без подмены ветки: иначе
            # он ждал бы до минуты срока тревоги (`report_wait`).
            targets = set()
        trigger = event["trigger"]
        if event["kind"] == "request_service" and trigger["on"] == "message":
            # Просьба без delay/replace тоже держит следующий доклад этой бригады:
            # иначе итог выдаётся в удержанный разговор ещё до приезда вызванной службы.
            nxt = following.get(UUID(trigger["message_id"]))
            if nxt is not None:
                targets.add(nxt)
        effects = effects_of(event, outcome.branch)
        awaits = awaited_call(event, outcome.branch)
        if awaits is not None and outcome.at is not None:
            # Ветка ждёт звонка абоненту (HQ-019): «позвоню хозяйке» меняет мир только тогда,
            # когда диспетчер правда позвонил. Абонента нет в телефоне занятия — ждать нечего.
            exts = contact_exts.get(str(awaits["contact_role"]), frozenset())
            deadline = outcome.at + timedelta(seconds=float(cast(float, awaits["within_s"])))
            called = answered_call(journal.calls, exts, firing.fired_at) if exts else None
            required = cast(Sequence[str], awaits.get("required_facts", []))
            facts = caller_facts_at(journal, required, firing.fired_at) if required else None
            if required and (facts is None or facts > min(now, deadline)):
                called = None
            if awaits.get("relay_event"):
                relay = events.get(UUID(str(awaits["relay_event"])))
                relay_firing = journal.firings.get(UUID(relay["id"])) if relay else None
                relayed = (
                    outcome_of(relay, relay_firing, journal, now)
                    if relay and relay_firing
                    else None
                )
                if (
                    relayed is None
                    or relayed.branch != "met"
                    or relayed.at is None
                    or relayed.at > deadline
                    or relayed.at > now
                    or (facts is not None and facts > relayed.at)
                ):
                    called = None
                elif called is not None:
                    until = max(until, relayed.at)
            if (not exts and not required) or called is not None:
                pass
            elif now < deadline:
                # Пока срок не вышел, доклад ждёт: диспетчер ещё может позвонить.
                until = max(until, deadline)
            else:
                effects = otherwise_of(awaits)
        for key in targets:
            holds[key] = max(holds.get(key, until), until)
        for effect in effects:
            if "delay" in effect:
                key = UUID(str(effect["delay"]))
                delays[key] = delays.get(key, 0) + int(cast(int, effect["by_s"]))
            else:
                replacements[UUID(str(effect["replace"]))] = cast(dict[str, Any], effect["with"])
        branches = event.get("branches") or {}
        branch = branches.get(outcome.branch or "") or {}
        answer = None if outcome.silent else branch.get("line")
        answer_at = outcome.at
        # Бригада отвечает тому, кто её услышал: на неуслышанный вопрос ответа нет. Приезд
        # службы, о которой бригаде не сказали (`surprise`, GP-28), — не ответ: о нём
        # бригада сообщает в любом случае.
        heard = (
            event["line"] is None
            or line_id(event["line"]) in journal.presented
            or outcome.branch == "surprise"
        )
        if service_called_at(outcome) is not None:
            # Службу вызвали по просьбе бригады (HQ-055): бригада не перезванивает ради
            # «Понял». О службе ей сообщает диспетчер, и «Понял, ждём скорую» отвечает окно
            # телефона на его фразу; не сообщил к приезду — служба приезжает «внезапно»
            # (реплика ветки `surprise`, если она есть).
            surprise = branches.get("surprise") or {}
            untold = outcome.news == "untold"
            answer = surprise.get("line") if untold else None
            answer_at = outcome.news_at if untold else None
            heard = True
        if answer and heard and answer_at is not None:
            ready = stage_ready(
                str(answer.get("text") or ""),
                brigade,
                (UUID(key) for key in targets_of(event)),
                answer_at,
                journal,
                stages,
            )
            lines.append(WorldLine(answer, brigade, target, ready, answer=True))
    return World(
        lines,
        holds,
        delays,
        replacements,
        carrying,
        quiet(journal.turns),
        frozenset(reply_options(events.values())),
    )


def apply_world(
    reports: Sequence[ScheduledReport], state: World, issued: set[tuple[UUID, int]]
) -> list[ScheduledReport]:
    """Доклады плана с поправками мира и реплики мира — одно расписание для worker и разбора.

    Новая реплика бригады ждёт её очереди (`turns`): пока бригада ждёт ответа на свою
    реплику, следующая не готова.
    """
    adjusted = []
    for report in reports:
        key = report.identity[0]
        ready = report.ready_at
        if ready is not None and not report.issued:
            hold = state.holds.get(key)
            if hold is not None:
                ready = max(ready, hold)
            ready = delayed(report, ready, timedelta(seconds=state.delays.get(key, 0)))
            ready = state.quiet.get(report.brigade_id, OPEN).ready(ready)
        planned = report.planned
        content = state.replacements.get(key) or state.carried.get(key)
        if content is not None and not report.issued:
            # Версия — как у доклада плана: предъявление сверяется с выданной версией.
            message = {**content, "version": planned["message"]["version"]}
            planned = {**planned, "message": message}
        if UUID(planned["message"]["id"]) in state.questions:
            planned = {**planned, "question": True}
        adjusted.append(replace(report, planned=planned, ready_at=ready))
    for item in state.lines:
        identity = (UUID(item.message["id"]), item.message["version"])
        ready_at: datetime | None = item.ready_at
        if identity not in issued and not item.alarm:
            ready_at = state.quiet.get(item.brigade_id, OPEN).ready(ready_at)
        adjusted.append(
            ScheduledReport(
                planned={
                    "message": item.message,
                    "brigade_id": str(item.brigade_id),
                    "call_target_id": str(item.target_id),
                    "available_after_s": 0,
                    **({"priority": "alarm"} if item.alarm else {}),
                    **({"answer": True} if item.answer else {}),
                    **({"question": True} if UUID(item.message["id"]) in state.questions else {}),
                },
                identity=identity,
                brigade_id=item.brigade_id,
                target_id=item.target_id,
                issued=identity in issued,
                # Реплика мира звучит сразу: ожидания бригады здесь нет (разбор времени).
                waiting_started_at=item.ready_at,
                ready_at=ready_at,
            )
        )
    return adjusted


def reply_options(events: Iterable[dict[str, Any]]) -> dict[UUID, list[dict[str, Any]]]:
    """Реплика события → варианты ответа бригаде (нет вариантов — отвечать не нужно)."""
    return {
        UUID(event["line"]["id"]): list(event["reply_options"])
        for event in events
        if event["line"] and event.get("reply_options")
    }


def alarm_pending(events: dict[UUID, dict[str, Any]], journal: Journal) -> set[UUID]:
    """Бригады, чья тревога сработала, но ещё не выдана: их вызов — тревожный."""
    return {
        UUID(event["brigade_id"])
        for event_id, event in events.items()
        if event_id in journal.firings
        and event["priority"] == "alarm"
        and event["line"]
        and line_id(event["line"]) not in journal.delivered
    }


# --- Журнал из БД -------------------------------------------------------------------------


# Как дан ответ бригаде (DT-16): голосом или вариантом, громкость и неудачи голоса — для
# разбора (`evalcore.brigade`); исход события от них не зависит.
_REPLY_HOW = ("mode", "text", "loudness", "voice_failures")


def reply_record(event: CardEvent) -> dict[str, Any]:
    """Ответ бригаде для журнала и разбора: `{at, option_key}` и поля способа ответа."""
    record = {"at": event.server_ts.isoformat(), "option_key": event.payload["option_key"]}
    record.update({key: event.payload[key] for key in _REPLY_HOW if key in event.payload})
    return record


Plan = list[dict[str, Any]]


async def card_events_plan(db: AsyncSession, card: Card) -> tuple[Plan, Plan]:
    """(доклады, события) плана сценария карточки; пусто — плана нет."""

    async def load() -> tuple[Plan, Plan]:
        assignment = await db.get(Assignment, card.assignment_id)
        if assignment is None:
            return [], []
        scenario = await db.get(Scenario, assignment.scenario_id)
        if scenario is None:
            return [], []
        plan = await plan_for_assignment(db, assignment, scenario)
        if plan is None:
            return [], []
        return list(plan.plan["messages"]), list(plan.plan.get("events") or [])

    messages, events = await remembered(db, ("card_events_plan", card.assignment_id), load)
    return list(messages), list(events)


def content_id(delivery: MessageDelivery) -> UUID:
    """Что прозвучало в выдаче: реплика подмены или повтора адреса, а не id доклада плана.

    Выдача доклада, который говорит чужую реплику (подмена ветки, повтор адреса в докладе о
    выезде), хранит id доклада (`message_id`) — по нему статусы и разбор. Реплика внутри
    (`message.id`) — по ней событие узнаёт, что его реплику услышали и ответили.
    """
    raw = delivery.message.get("id") if isinstance(delivery.message, dict) else None
    return UUID(raw) if raw else delivery.message_id


async def load_journal(
    db: AsyncSession,
    card: Card,
    statuses: list[tuple[str, datetime]] | None = None,
    calls: Sequence[Call] | None = None,
    events: Sequence[dict[str, Any]] = (),
) -> Journal:
    """Снимок журнала карточки; `events` — события плана: по ним — очередь реплик бригады.

    Снимок неизменяем; повторный в той же транзакции без записей — из `read_cache`.
    """
    key = (
        "journal",
        card.id,
        statuses is None,
        calls is None,
        tuple(str(event.get("id")) for event in events),
    )
    return await remembered(db, key, lambda: _load_journal(db, card, statuses, calls, events))


async def _load_journal(
    db: AsyncSession,
    card: Card,
    statuses: list[tuple[str, datetime]] | None,
    calls: Sequence[Call] | None,
    events: Sequence[dict[str, Any]],
) -> Journal:
    if statuses is None:
        statuses = await status_history(db, card.id)
    if calls is None:
        card_id = card.id

        async def load() -> list[Call]:
            return list(await db.scalars(select(Call).where(Call.card_id == card_id)))

        calls = list(await remembered(db, ("journal_calls", card_id), load))
    deliveries = list(
        await db.scalars(
            select(MessageDelivery)
            .where(MessageDelivery.card_id == card.id)
            .order_by(MessageDelivery.delivered_at, MessageDelivery.id)
        )
    )
    first = dict(
        (
            await db.execute(
                select(MessagePresentation.delivery_id, func.min(MessagePresentation.recorded_at))
                .where(
                    MessagePresentation.delivery_id.in_([item.id for item in deliveries]),
                    MessagePresentation.kind == "message_presented",
                )
                .group_by(MessagePresentation.delivery_id)
            )
        )
        .tuples()
        .all()
    )
    presented: dict[UUID, datetime] = {}
    delivered: dict[UUID, UUID] = {}
    heard_from: dict[UUID, list[datetime]] = {}
    on_line_since: dict[UUID, datetime] = {}
    answered = {call.id: call.answered_at for call in calls if call.answered_at is not None}
    by_delivery = {item.id: item for item in deliveries}
    for item in deliveries:
        keys = {item.message_id, content_id(item)}
        for key in keys:
            delivered[key] = item.brigade_id
        at = first.get(item.id)
        if at is None:
            continue
        for key in keys:
            if key not in presented or at < presented[key]:
                presented[key] = at
                if item.call_id in answered:
                    on_line_since[key] = answered[item.call_id]
        heard_from.setdefault(item.brigade_id, []).append(at)
    replies: dict[UUID, list[dict[str, Any]]] = {}
    talk = list(
        await db.scalars(
            select(CardEvent)
            .where(
                CardEvent.card_id == card.id,
                CardEvent.type.in_(("brigade_reply", "report_confirmed", "brigade_said")),
            )
            .order_by(CardEvent.server_ts, CardEvent.id)
        )
    )
    for event in talk:
        if event.type != "brigade_reply":
            continue
        delivery = by_delivery.get(UUID(event.payload["delivery_id"]))
        if delivery is not None:
            for key in {delivery.message_id, content_id(delivery)}:
                replies.setdefault(key, []).append(reply_record(event))
    firings = {
        row.event_id: Firing(row.event_id, row.fired_at, row.source)
        for row in await db.scalars(
            select(ScenarioEventFiring).where(ScenarioEventFiring.card_id == card.id)
        )
    }
    from app.api.training.briefing import card_briefings, dispatched
    from app.api.training.caller import caller_fact_records, requires_caller_facts

    return Journal(
        briefed=await dispatched(db, card.id),
        said=await said_to_brigades(db, card.id, calls, await card_briefings(db, card.id)),
        statuses=statuses,
        presented=presented,
        delivered=delivered,
        heard_from=heard_from,
        replies=replies,
        calls=[call_context(call) for call in calls],
        firings=firings,
        turns=turns_of(deliveries, first, calls, talk, events),
        on_line_since=on_line_since,
        caller_facts=await caller_fact_records(db, card, calls)
        if requires_caller_facts({"events": list(events)})
        else [],
    )


def turns_of(
    deliveries: Sequence[MessageDelivery],
    first: Mapping[UUID, datetime],
    calls: Sequence[Call],
    talk: Sequence[CardEvent],
    events: Sequence[dict[str, Any]],
) -> list[Turn]:
    """Реплики бригады, после которых она ждёт ответа (`turns`): вопросы с вариантами ответа и
    доклады во входящем вызове («Как приняли?»). Ответ — первая реакция диспетчера в этом
    разговоре после реплики (вариант, «Принял», любая фраза) или отбой."""
    questions = set(reply_options(events))
    # Просьба о службе отвечена и звонком в эту службу (ожидание `call_service`).
    service_exts = {
        line: {str(ext) for expect in event["expect"] for ext in expect.get("phone_exts", [])}
        for event in events
        if (line := line_id(event["line"])) is not None
    }
    answers = {
        answer
        for event in events
        for branch in (event.get("branches") or {}).values()
        if isinstance(branch, dict) and (answer := line_id(branch.get("line"))) is not None
    }
    by_call = {call.id: call for call in calls}
    result = []
    for delivery in deliveries:
        call = by_call.get(delivery.call_id)
        content = content_id(delivery)
        question = content in questions
        inbound = call is not None and call.direction == "inbound"
        if not question and not asks_confirmation(inbound, question, content in answers):
            continue
        heard = first.get(delivery.id)
        answered = None
        if heard is not None:
            # Фраза диспетчера, сказанная, пока реплика звучала, — тоже ответ на неё: бригада
            # услышит её к концу своей реплики (окно телефона гасит только запись, а начатое
            # распознавание и быстрые фразы уходят и во время речи бригады).
            start = line_start(delivery, heard, call, deliveries, first)
            moments = [
                max(event.server_ts, heard)
                for event in talk
                if event.server_ts >= start
                and (
                    event.payload.get("delivery_id") == str(delivery.id)
                    or (
                        event.type == "brigade_said"
                        and event.payload.get("call_id") == str(delivery.call_id)
                    )
                )
            ]
            if call is not None and call.ended_at is not None and call.ended_at >= heard:
                moments.append(call.ended_at)
            exts = service_exts.get(content, set())
            moments += [
                other.started_at
                for other in calls
                if other.direction == "outbound"
                and other.refusal is None
                and other.dialed_ext in exts
                and other.started_at >= heard
            ]
            answered = min(moments, default=None)
        pause = ANSWER_PAUSE if question else ANSWER_PAUSE + CONFIRM_ASK
        result.append(Turn(delivery.brigade_id, heard, answered, pause))
    return result


def line_start(
    delivery: MessageDelivery,
    heard: datetime,
    call: Call | None,
    deliveries: Sequence[MessageDelivery],
    first: Mapping[UUID, datetime],
) -> datetime:
    """Когда реплика начала звучать: предъявление отмечает только её конец. Не раньше выдачи,
    ответа на звонок и конца предыдущей реплики этого разговора; по длительности записи —
    не раньше, чем за неё до конца."""
    bounds = [delivery.delivered_at]
    if call is not None and call.answered_at is not None:
        bounds.append(call.answered_at)
    bounds += [
        at
        for other in deliveries
        if other.call_id == delivery.call_id
        and other.id != delivery.id
        and (at := first.get(other.id)) is not None
        and at < heard
    ]
    audio = delivery.message.get("audio")
    if isinstance(audio, dict) and isinstance(audio.get("duration_ms"), int):
        bounds.append(heard - timedelta(milliseconds=audio["duration_ms"]))
    return min(heard, max(bounds))


async def said_to_brigades(
    db: AsyncSession, card_id: UUID, calls: Sequence[Call], briefings: Sequence[Any]
) -> dict[UUID, list[dict[str, Any]]]:
    """Бригада → что диспетчер ей сказал `[{at, text, via?}]` по времени (GP-28).

    Фразы разговора — события `brigade_said` (бригада — по звонку), вводные — записи
    `brigade_briefings` с `via: "briefing"` (в том числе неполные: «скорую вызвал» могли
    сказать и в них; поправкой повтора адреса вводная не считается, HQ-024).
    """
    by_call = {call.id: call.brigade_id for call in calls if call.brigade_id is not None}
    said: dict[UUID, list[dict[str, Any]]] = {}
    for event in await db.scalars(
        select(CardEvent)
        .where(CardEvent.card_id == card_id, CardEvent.type == "brigade_said")
        .order_by(CardEvent.server_ts, CardEvent.id)
    ):
        brigade = by_call.get(UUID(event.payload["call_id"]))
        if brigade is not None:
            said.setdefault(brigade, []).append(
                {"at": event.server_ts.isoformat(), "text": event.payload["text"]}
            )
    for row in briefings:
        said.setdefault(row.brigade_id, []).append(
            {"at": row.briefed_at.isoformat(), "text": row.text, "via": "briefing"}
        )
    for items in said.values():
        items.sort(key=lambda item: datetime.fromisoformat(item["at"]))
    return said


def _reporting(
    messages: Sequence[dict[str, Any]], issued: set[tuple[UUID, int]], crew: Crew
) -> set[UUID]:
    result = set()
    for planned in messages:
        identity = (UUID(planned["message"]["id"]), planned["message"]["version"])
        if identity in issued:
            continue
        brigade = UUID(planned["brigade_id"])
        result.add(crew[brigade][0] if brigade in crew else brigade)
    return result


async def phrase_fixes_readback(
    db: AsyncSession, card: Card, brigade_id: UUID, text: str, now: datetime
) -> bool:
    """Засчитает ли мир фразу бригаде `text`, сказанную в `now`, поправкой повтора адреса
    (`correct_readback`, HQ-024). Тогда бригада отвечает на неё репликой ветки `met`
    («Понял, Бескудниковский бульвар, едем.»), а окно телефона своего ответа не даёт: на
    одну фразу — один ответ, и он подтверждает поправку, даже если во фразе ещё «доложите».
    """
    _, events, crew, journal = await _context(db, card)
    if not events:
        return False
    said = [*journal.said.get(brigade_id, []), {"at": now.isoformat(), "text": text}]
    probe = replace(journal, said={**journal.said, brigade_id: said})
    by_id = {UUID(event["id"]): cast_event(event, crew) for event in events}
    for firing in journal.firings.values():
        event = by_id.get(firing.event_id)
        if event is None or UUID(event["brigade_id"]) != brigade_id:
            continue
        if (
            outcome_of(event, firing, probe, now).fixed_by_phrase
            and not outcome_of(event, firing, journal, now).fixed_by_phrase
        ):
            return True
    return False


async def world_schedule(
    db: AsyncSession,
    card: Card,
    events: list[dict[str, Any]],
    reports: list[ScheduledReport],
    crew: Crew,
    statuses: list[tuple[str, datetime]],
    calls: Sequence[Call],
    issued: set[tuple[UUID, int]],
    now: datetime,
    messages: Sequence[dict[str, Any]] = (),
) -> list[ScheduledReport]:
    """Расписание докладов с событиями бригады и очередью её реплик (`gating.report_schedule`)."""
    journal = await load_journal(db, card, statuses, calls, events)
    cast_events = {UUID(event["id"]): cast_event(event, crew) for event in events}
    state = world(
        cast_events,
        journal,
        now,
        carried_events(events, messages),
        following_reports(messages),
        report_stages(messages),
        await contact_exts(db, card, events),
    )
    return apply_world(reports, state, issued)


async def contact_exts(
    db: AsyncSession, card: Card, events: Sequence[dict[str, Any]]
) -> dict[str, set[str]]:
    """Роль абонента телефона ДДС → её номера на занятии карточки — для веток `awaits_call`.

    Спрашиваем только роли, которых ждут ветки: занятие без таких событий лишнего запроса
    не делает.
    """
    roles = {
        str(branch["awaits_call"]["contact_role"])
        for event in events
        for branch in (event.get("branches") or {}).values()
        if isinstance(branch, dict) and isinstance(branch.get("awaits_call"), dict)
    }
    if not roles:
        return {}
    from app.api.training.caller import role_numbers

    return {role: await role_numbers(db, card, role) for role in sorted(roles)}


async def _context(db: AsyncSession, card: Card) -> tuple[Plan, Plan, Crew, Journal]:
    messages, events = await card_events_plan(db, card)
    crew = await card_crew(db, card, messages) if events else {}
    journal = await load_journal(db, card, events=events)
    return messages, events, crew, journal


async def due_firings(
    db: AsyncSession, card: Card, now: datetime
) -> list[tuple[dict[str, Any], datetime]]:
    """События плана, которым к `now` пора сработать, и момент срабатывания каждого.

    Без действий обучаемого мир детерминирован: с `now` далеко впереди это ещё и когда
    сработают следующие события (прогон связности прыгает часами к этому моменту).
    """
    if card.closed_at is not None or card.interrupted_at is not None:
        return []
    messages, events, crew, journal = await _context(db, card)
    if not events:
        return []
    issued = set(
        (
            await db.execute(
                select(MessageDelivery.message_id, MessageDelivery.message_version).where(
                    MessageDelivery.card_id == card.id
                )
            )
        ).tuples()
    )
    cast_events = [cast_event(event, crew) for event in events]
    carried = set(carried_events(events, messages))
    return due_events(cast_events, journal, _reporting(messages, issued, crew), now, carried)


async def fire_due_events(db: AsyncSession, card: Card, now: datetime) -> int:
    """Worker: записать срабатывание событий плана, которым пора (одно на событие)."""
    due = await due_firings(db, card, now)
    for event, at in due:
        db.add(
            ScenarioEventFiring(
                id=uuid4(),
                card_id=card.id,
                event_id=UUID(event["id"]),
                event_version=event["version"],
                source="plan",
                injected_by=None,
                fired_at=at,
            )
        )
    if due:
        await db.flush()
    return len(due)


async def fire_event_now(
    db: AsyncSession, card: Card, event_id: UUID, *, injected_by: UUID, now: datetime
) -> ScenarioEventFiring:
    """Подать событие плана сейчас — вводная преподавателя (точка входа для DT-06, #69).

    Подаётся событие с `trigger.on = inject` или `injectable: true`. Карточка открыта,
    событие на ней ещё не срабатывало, бригада на связи; для `inject.requires_state` —
    карточка дошла до статуса. Иначе `EventNotApplicable` с причиной для преподавателя.
    Вызывающий держит блокировку карточки (как worker) и потом выдаёт реплику —
    `app.worker.training.deliver_messages` / `ring_brigades` или следующий тик worker.
    """
    if card.closed_at is not None or card.interrupted_at is not None:
        raise EventNotApplicable("Карточка уже закрыта.")
    _, events, crew, journal = await _context(db, card)
    event = next((item for item in events if UUID(item["id"]) == event_id), None)
    if event is None:
        raise EventNotApplicable("Такого события нет в плане сценария этой карточки.")
    if event["trigger"]["on"] != "inject" and not event["injectable"]:
        raise EventNotApplicable("Это событие подаётся только по плану сценария.")
    if event_id in journal.firings:
        raise EventNotApplicable("Это событие на карточке уже было.")
    brigade = UUID(cast_event(event, crew)["brigade_id"])
    if dispatched_at(brigade, journal) is None:
        raise EventNotApplicable(
            "Бригада ещё не выехала: дождитесь, пока диспетчер даст ей вводную."
        )
    required = event["trigger"].get("requires_state") or event["trigger"].get("state")
    if required and reached_at(required, journal.statuses) is None:
        raise EventNotApplicable("Рано: карточка ещё не дошла до нужного статуса.")
    if event["priority"] == "alarm":
        ready = alarm_at(brigade, journal, now)
        if ready is None:
            raise EventNotApplicable(
                "Обучаемый сейчас на связи с этой бригадой (разговор или её вызов) — тревога "
                "не перебивает разговор. Подайте после отбоя."
            )
        if ready > now:
            wait_s = int((ready - now).total_seconds()) + 1
            raise EventNotApplicable(
                f"Разговор с бригадой только что закончился — подайте через {wait_s} с."
            )
    firing = ScenarioEventFiring(
        id=uuid4(),
        card_id=card.id,
        event_id=event_id,
        event_version=event["version"],
        source="inject",
        injected_by=injected_by,
        fired_at=now,
    )
    db.add(firing)
    await db.flush()
    return firing


async def card_alarm_busy(db: AsyncSession, card: Card, now: datetime) -> bool:
    """Worker перед выдачей новой карточки: тревога на этой карточке занимает обучаемого."""
    if card.closed_at is not None or card.interrupted_at is not None:
        return False
    _, events, crew, journal = await _context(db, card)
    if not any(event["priority"] == "alarm" for event in events):
        return False
    return alarm_holds_cards([cast_event(event, crew) for event in events], journal, now)


# --- Проекция и разбор ----------------------------------------------------------------------


def manual_news_window(
    event: dict[str, Any], firing: Firing, journal: Journal
) -> tuple[datetime, datetime | None] | None:
    """Правдивая ручная весть: AND ожиданий, OR номеров внутри каждого ожидания.

    Не меняет историческую оценку evalcore: её объединение групп непригодно для
    утверждения «служба вызвана». Здесь проверяем реальные звонки каждой группы.
    """
    expects = event["expect"]
    groups = [item for item in expects if item["action"] == "call_service"]
    if not groups:
        return None
    ahead = event["kind"] == "request_service" and len(groups) == len(expects)
    accepted = reached_at("accepted", journal.statuses)
    starts: list[datetime] = []
    deadlines: list[datetime] = []
    for group in groups:
        candidates = sorted(
            (started, index, call)
            for index, call in enumerate(journal.calls)
            if call.get("direction", "outbound") == "outbound"
            and call.get("refusal") is None
            and call.get("brigade_id") is None
            and call.get("phone_ext") in group["phone_exts"]
            and (started := _time(call.get("started_at"))) is not None
            and (
                started >= firing.fired_at or (ahead and (accepted is None or started >= accepted))
            )
        )
        # Повторный звонок после просьбы использует обычное окно (HQ-055).
        after = [item for item in candidates if item[0] >= firing.fired_at]
        chosen = next(iter(after or candidates), None)
        if chosen is None:
            return None
        started, _, call = chosen
        starts.append(started)
        if started < firing.fired_at:
            line = line_id(event["line"])
            spoken = spoken_s(line, firing.fired_at, journal) if line else 0
            deadlines.append(
                firing.fired_at
                + timedelta(seconds=spoken + max(item["within_s"] for item in expects))
            )
        elif (ended := _time(call.get("ended_at"))) is not None:
            deadlines.append(max(started, ended) + timedelta(seconds=SERVICE_ARRIVAL_S))
    return max(starts), min(deadlines) if deadlines else None


@dataclass(frozen=True)
class EventView:
    """Что из событий видно обучаемому: варианты ответа, его ответ, тревога, связь."""

    options: dict[UUID, list[dict[str, Any]]]
    reply_keys: dict[UUID, str]
    alarm_brigades: set[UUID]
    contacts: dict[UUID, datetime | None]
    # Ответы бригады на реакцию диспетчера (реплики веток): после них «Как приняли?» нет.
    answers: set[UUID]
    # Реплика-просьба о службе → окно вести (HQ-055, `evalcore.brigade.news_window`): когда
    # позвонили в службу и срок сообщить бригаде (None — звонок в службу ещё идёт).
    news: dict[UUID, tuple[datetime, datetime | None]] = field(default_factory=dict)
    # Звонки в службы по карточке после «Принята» (исходящие, без отказа): служба, набор.
    # По ним окно телефона знает, что служба уже вызвана, до просьбы бригады (GP-28).
    service_calls: list[tuple[str, datetime]] = field(default_factory=list)
    manual_news: dict[UUID, tuple[datetime, datetime | None] | None] = field(default_factory=dict)
    manual_news_told: dict[UUID, datetime] = field(default_factory=dict)
    # Услышанный вопрос бригады (реплика с вариантами) → срок ответа на него (HQ-058): пока он
    # не прошёл, снятая с удержания бригада повторяет вопрос и придерживает новую реплику.
    reply_by: dict[UUID, datetime] = field(default_factory=dict)


async def event_view(db: AsyncSession, card: Card, brigades: Sequence[UUID]) -> EventView:
    """Для `CardTraining`: план (ожидания, ветки) наружу не уходит, часы не участвуют."""
    messages, events, crew, journal = await _context(db, card)
    cast_events = {UUID(event["id"]): cast_event(event, crew) for event in events}
    reply_keys: dict[UUID, str] = {}
    for event in await db.scalars(
        select(CardEvent)
        .where(CardEvent.card_id == card.id, CardEvent.type == "brigade_reply")
        .order_by(CardEvent.server_ts, CardEvent.id)
    ):
        reply_keys.setdefault(UUID(event.payload["delivery_id"]), event.payload["option_key"])
    # Окно вести о службе — без часов: звонок в службу и его отбой уже в журнале. Служба
    # вызвана заранее, а бригада всё же попросила (GP-28) — окно от того звонка до приезда.
    accepted = reached_at("accepted", journal.statuses)
    outbound = [call for call in journal.calls if call["direction"] == "outbound"]
    news: dict[UUID, tuple[datetime, datetime | None]] = {}
    reply_by: dict[UUID, datetime] = {}
    manual_news: dict[UUID, tuple[datetime, datetime | None] | None] = {}
    manual_news_told: dict[UUID, datetime] = {}
    for firing in journal.firings.values():
        planned = cast_events.get(firing.event_id)
        line = line_id(planned["line"]) if planned is not None else None
        if planned is None or line is None:
            continue
        if any(item["action"] == "call_service" for item in planned["expect"]):
            manual_news[line] = manual_news_window(planned, firing, journal)
            window = manual_news[line]
            if window is not None:
                # Время факта берётся из журнала сервера, не из HTTP ACK или часов UI.
                groups = [
                    e["phone_exts"] for e in planned["expect"] if e["action"] == "call_service"
                ]
                utterances = [
                    *journal.said.get(UUID(planned["brigade_id"]), []),
                    *journal.replies.get(line, []),
                ]
                told = min(
                    (
                        at
                        for item in utterances
                        if (at := _time(item.get("at"))) is not None
                        and at >= max(window[0], firing.fired_at)
                        and (window[1] is None or at <= window[1])
                        and all(reply_says_service_called(item, group) for group in groups)
                    ),
                    default=None,
                )
                if told is not None:
                    manual_news_told[line] = told
        outcome = outcome_of(planned, firing, journal, None)
        window = news_window(planned, outcome, journal.calls) or ahead_window(
            planned,
            outcome,
            firing.fired_at,
            outbound,
            accepted,
            spoken_s(line, firing.fired_at, journal),
        )
        if window is not None:
            news[line] = window
        # Срок ответа на услышанный вопрос — срок события (его ожиданий, кроме ответа на вызов).
        heard = journal.presented.get(line)
        waits = [expect for expect in planned["expect"] if expect["action"] != "answer_call"]
        if heard is not None and waits:
            spoken = spoken_s(line, firing.fired_at, journal)
            reply_by[line] = max(
                expectation_deadline(expect, firing.fired_at, heard, spoken) for expect in waits
            )
    service_calls = sorted(
        (str(call["service_id"]), started)
        for call in outbound
        if call["service_id"] is not None
        and call["brigade_id"] is None
        and call["refusal"] is None
        and (started := _time(call["started_at"])) is not None
        and (accepted is None or started >= accepted)
    )
    return EventView(
        options=reply_options(events),
        reply_keys=reply_keys,
        alarm_brigades=alarm_pending(cast_events, journal),
        contacts={
            brigade: None if on_line(brigade, journal) else last_contact(brigade, journal)
            for brigade in brigades
        },
        answers={
            answer
            for event in cast_events.values()
            for branch in (event.get("branches") or {}).values()
            if isinstance(branch, dict) and (answer := line_id(branch.get("line"))) is not None
        },
        news=news,
        manual_news=manual_news,
        manual_news_told=manual_news_told,
        service_calls=service_calls,
        reply_by=reply_by,
    )


async def evaluation_events(db: AsyncSession, card: Card) -> tuple[dict[str, Any], ...]:
    """`EvalContext.scenario_events`: сработавшие события с предъявлением и ответами."""
    _, events, crew, journal = await _context(db, card)
    by_id = {UUID(event["id"]): cast_event(event, crew) for event in events}
    result = []
    for firing in sorted(journal.firings.values(), key=lambda item: item.fired_at):
        event = by_id.get(firing.event_id)
        if event is None:
            continue
        line = line_id(event["line"])
        presented = journal.presented.get(line) if line else None
        accepted = reached_at("accepted", journal.statuses)
        result.append(
            {
                "event": copy.deepcopy(event),
                "fired_at": firing.fired_at.isoformat(),
                "source": firing.source,
                "presented_at": presented.isoformat() if presented else None,
                "replies": journal.replies.get(line, []) if line else [],
                # «Служба вызвана заранее» (GP-28): что сказали бригаде и когда «Принята».
                "said": journal.said.get(UUID(event["brigade_id"]), []),
                "accepted_at": accepted.isoformat() if accepted else None,
                # Сколько реплика шла до диспетчера на линии: срок звонка сдвигается на это.
                "spoken_s": spoken_s(line, firing.fired_at, journal),
            }
        )
    return tuple(result)


async def record_reply(db: AsyncSession, card: Card, payload: dict[str, Any]) -> None:
    """Ответ бригаде: один на реплику, в любом идущем разговоре с той же бригадой."""
    delivery = await db.get(MessageDelivery, UUID(payload["delivery_id"]))
    if delivery is None or delivery.card_id != card.id:
        raise HTTPException(404, "Реплика бригады не найдена.")
    # Непрослушанный вопрос бригада повторяет новым вызовом; выдача остаётся прежней.
    call = await db.get(Call, UUID(payload["call_id"]))
    if (
        call is None
        or call.card_id != card.id
        or call.brigade_id is None
        or call.brigade_id != delivery.brigade_id
        or call.refusal is not None
        or call.answered_at is None
        or call.ended_at is not None
    ):
        raise HTTPException(409, "Ответить можно только в идущем разговоре с этой бригадой.")
    _, events = await card_events_plan(db, card)
    known = reply_options(events)
    options = known.get(content_id(delivery)) or known.get(delivery.message_id, [])
    if payload["option_key"] not in {option["key"] for option in options}:
        raise HTTPException(422, "На эту реплику такого ответа нет.")
    answered = await db.scalar(
        select(CardEvent.id).where(
            CardEvent.card_id == card.id,
            CardEvent.type == "brigade_reply",
            CardEvent.payload["delivery_id"].astext == payload["delivery_id"],
        )
    )
    if answered is not None:
        raise HTTPException(409, "На эту реплику уже ответили.")
