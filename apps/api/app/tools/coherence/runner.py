"""Прогон одного сценария за диспетчера по политике — с расшифровкой окна телефона.

Шаг симуляции — `STEP` секунд: тик worker (события бригады, выдача, вызовы бригады),
чтение `GET /cards/{id}/training`, окно телефона (что звучит, «Как приняли?», отбой) и
действия диспетчера по политике. Всё через настоящее API в процессе (ASGI), часы — общие
для сервера и прогона (`harness.sim_time`).
"""

import copy
import json
import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import partial
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession, async_sessionmaker

from app.api.training.control import WITHOUT_STATUS, control_plan
from app.api.training.gating import card_calls, report_schedule
from app.api.training.scenario_events import due_firings, phrase_fixes_readback
from app.core.models import Card, CardTrainingState, Evaluation, ScenarioEventFiring
from app.core.scored_criteria import applied_critical_flags, applied_scores
from app.seed.scenarios import scenario_uuid, training_plan
from app.seed.service_defaults import PHONEBOOK, phone_services, with_service_defaults
from app.tools.coherence import caller, phone
from app.tools.coherence.harness import SimClock, http, login, sim_time
from app.tools.coherence.policies import Policy, hold_call_target
from app.tools.coherence.transcript import QUESTION_REPEAT, Line, Transcript
from app.worker.scheduler import CardScheduler
from app.worker.training import (
    MISSED,
    MISSED_AFTER,
    REDIAL_AFTER,
    TrainingScheduler,
    unheard_reports,
)

STEP = 0.25
TICK_EVERY = 1.0
# Пропуск пустых тиков: насколько вперёд проба смотрит сначала и не дальше какого предела, с.
FIRST_LOOKAHEAD = 2.0
MAX_LOOKAHEAD = 32.0
# «Далеко впереди» для расписания мира без действий обучаемого.
FAR = timedelta(hours=1)
HORIZON_S = 900.0
# Сколько диспетчер говорит фразу (оценка): вводная, ответ, доклад службе.
SAY_SECONDS = 2.0
BRIEFING_SECONDS = 5.0
SERVICE_REPORT_SECONDS = 6.0
# Сколько ждёт на «Как приняли?» молчащий диспетчер, прежде чем положить трубку.
SILENT_HANGUP_S = 8.0
# Диспетчер не отвечает на вопрос или просьбу бригады: молча кладёт трубку через столько.
IGNORE_HANGUP_S = 5.0
# Решив звонить в службу, диспетчер дослушивает фразу бригады и кладёт трубку через полсекунды.
HANGUP_REACTION_S = 0.5
FULL_REPORT = {
    "report_choices": ["full"],
    "report_modes": ["voice"],
    "report_parts": [["who", "address", "card", "change"]],
}
TERMINAL = {"completed", "refused", "redirected", "rejected"}
# Живой заявитель (HQ-019): условный номер в телефоне ДДС занятия, пауза диспетчера между
# вопросами, сколько вопросов за звонок самое большее и через сколько перезвонить после отбоя.
CALLER_NUMBER = "458"
CALLER_GAP_S = 1.5
CALLER_MAX_ASKS = 10
CALLER_REDIAL_S = 3.0
# Что спрашивает диспетчер — ради чего звонят: где заявитель, когда подойдёт; потом просьба
# подойти и прощание. Тексты — кнопки окна телефона (caller/questions.ts): вопросы и просьба
# подойти из таблицы сюжета, заявитель их понимает тем же распознаванием (`caller.hear`).
CALLER_ASKS = ("where", "eta")
CALLER_BYE = "Спасибо, до свидания."
REPORT_STATES = ("responding", "arrived", "working", "completed", "refused")


@dataclass
class Talk:
    """Идущий разговор диспетчера."""

    id: str
    kind: str  # brigade | service | caller
    label: str
    inbound: bool
    answered_at: float | None = None
    brigade_id: str | None = None
    phone_ext: str | None = None
    briefed: bool = False
    # Звонок в службу по просьбе бригады: что сказать бригаде, перезвонив после него.
    told: str | None = None
    # С какого момента сказанное бригаде о службе в счёт: с набора номера службы (сервер,
    # `news_window`) — «уже вызвал» до звонка весть не засчитывается, его говорят снова.
    told_since: float = 0.0
    # Бригада в этом разговоре уже сказала выданную реплику (зачем звонила).
    heard: bool = False


@dataclass
class Playing:
    delivery: dict[str, Any]
    end: float
    call_id: str


@dataclass
class Scheduled:
    at: float
    what: str
    action: Callable[[], Awaitable[None]]


@dataclass
class Sources:
    """Сообщение плана → откуда оно в сценарии (по UUID, как их выводит seed)."""

    by_id: dict[str, tuple[str, str]]
    plan_text: dict[str, str]
    report_by_id: dict[str, dict[str, Any]]
    # У разных подмен одной ветки может быть один UUID; текст различает их цели.
    replacement_reports: dict[tuple[str, str], dict[str, Any]]
    event_by_line: dict[str, dict[str, Any]]
    # Реплика события → доклад плана, который её говорит (повтор адреса в докладе о выезде).
    carried: dict[str, str]


async def sources_of(data: dict[str, Any]) -> Sources:
    """Источники и цели подмен — из того же разбора, который записывает план в БД."""

    async def no_audio(path: str, text: str) -> None:
        # Нужны идентичности сообщений, а не чтение аудио или запись его ссылок в БД.
        return None

    plan = await training_plan(data, no_audio)
    by_id: dict[str, tuple[str, str]] = {}
    plan_text: dict[str, str] = {}
    reports: dict[str, dict[str, Any]] = {}
    replacements: dict[tuple[str, str], dict[str, Any]] = {}
    events: dict[str, dict[str, Any]] = {}
    carried: dict[str, str] = {}
    for report, parsed in zip(data["plan"], plan["messages"], strict=True):
        message = parsed["message"]
        mid = message["id"]
        by_id[mid] = ("plan", report["key"])
        plan_text[mid] = message["text"]
        reports[mid] = report
    justifies = {report["key"]: report["justifies_state"] for report in data["plan"]}
    for event, parsed in zip(data.get("events", []), plan.get("events", []), strict=True):
        key = event["key"]
        line_id = parsed["id"]
        by_id[line_id] = ("event", key)
        events[line_id] = event
        report = event["trigger"].get("report")
        if event["kind"] == "readback_error" and justifies.get(report) == "responding":
            # Повтор адреса говорит сам доклад о выезде (`scenario_events.carried_events`).
            carried[line_id] = str(report)
        for name, branch in parsed["branches"].items():
            if branch["line"] is not None:
                by_id[branch["line"]["id"]] = ("branch", f"{key}:{name}")
            groups = [
                (name, branch["effects"]),
                (f"{name}-no-call", branch.get("awaits_call", {}).get("otherwise", [])),
            ]
            for origin, effects in groups:
                for effect in effects:
                    if "replace" not in effect:
                        continue
                    mid = effect["with"]["id"]
                    # UUID общей реплики принадлежит первому месту в разборе, не обязательно
                    # обычной ветке: otherwise может встретиться раньше wrong.effects.
                    by_id.setdefault(mid, ("replace", f"{key}:{origin}"))
                    replacements[mid, effect["with"]["text"]] = reports[effect["replace"]]
    return Sources(by_id, plan_text, reports, replacements, events, carried)


def brigade_target(service: str, ordinal: int = 0) -> tuple[str, str]:
    return (
        str(uuid5(NAMESPACE_URL, f"arm112:c04:{service}:brigade:{ordinal}")),
        str(uuid5(NAMESPACE_URL, f"arm112:c04:{service}:target:{ordinal}")),
    )


class ScenarioRun:
    """Одна карточка одного сценария, одна политика диспетчера."""

    def __init__(
        self,
        app: Any,
        clock: SimClock,
        data: dict[str, Any],
        policy: Policy,
        trainee: str,
        *,
        carrying: bool = True,
        skip_idle: bool = True,
    ) -> None:
        self.app = app
        # Пропускать тики, которые ничего не меняют (`_world`); False — тик каждую секунду.
        self.skip_idle = skip_idle
        # Было ли действие обучаемого или преподавателя после последнего настоящего тика.
        self.dirty = True
        # До какой секунды проба доказала: без новых действий тик ничего не меняет.
        self.quiet_until = -1.0
        self.lookahead = FIRST_LOOKAHEAD
        # Когда мир без действий обучаемого изменится сам (`_next_change`); срок наступил, а тик
        # ничего не меняет — `blocked`, дальше пробы.
        self.next_change = 0.0
        self.blocked = False
        self.ticks = {"real": 0, "plan": 0, "probe": 0, "skipped": 0}
        # Движок говорит повтор адреса докладом о выезде (`scenario_events.carried_events`).
        self.carrying = carrying
        self.clock = clock
        self.data = with_service_defaults(data)
        self.policy = policy
        self.trainee = trainee
        self.service = data["service_id"]
        # Разбор загрузчика асинхронный: источники заполняются в run до первого сообщения.
        self.src = Sources({}, {}, {}, {}, {}, {})
        self.events = {event["key"]: event for event in self.data.get("events", [])}
        self.tr = Transcript(data["code"], policy.name, self.service)
        self.tr.data = {"scenario": self.data, "sources": self.src}
        self.brigade_id, self.target_id = brigade_target(self.service)
        self.brigade_name = "Бригада"
        self.card: dict[str, Any] = {}
        self.session_id = ""
        self.training: dict[str, Any] = {}
        self.talk: Talk | None = None
        self.speaking_until = 0.0
        self.queue: list[tuple[str, str, str, str | None]] = []
        self.playing: Playing | None = None
        self.presented: set[str] = set()
        self.heard_delivery: dict[str, float] = {}
        self.replied: set[str] = set()
        self.asked: dict[str, float] = {}  # call_id → когда прозвучало «Как приняли?»
        self.confirmed_on: str | None = None
        self.last_sound = 0.0
        # Бригада → последний её доклад, который звучал (Softphone `repeatReport`: с начала
        # воспроизведения, между разговорами не сбрасывается).
        self.last_report: dict[str, str] = {}
        self.stage: str | None = None
        self.plan: list[Scheduled] = []
        self.rings: dict[str, float] = {}
        self.missed_rings: set[str] = set()
        self.state = "added"
        self.dispatched = False
        self.ahead_done = False
        self.contact_called = False
        # Живой заявитель (HQ-019): книга характера, память разговора с карточкой.
        plan_caller = self.data.get("caller")
        self.caller_book = (
            caller.book(
                policy.caller_character or plan_caller.get("character", "calm"), plan_caller["plot"]
            )
            if plan_caller
            else None
        )
        self.caller_memory = caller.Memory()
        self.caller_asks = 0
        self.caller_agreed = False
        # Звонок заявителю с удержания бригады (`ask_via_hold`): только нужное бригаде — просьба
        # подойти к двери и прощание, без расспросов «где вы, когда подойдёте» (HQ-058).
        self.caller_short = False
        self.caller_dropped = 0
        self.injected: set[str] = set()
        # Что сказать бригаде в следующем исходящем звонке ей (служба едет).
        self.tell_brigade: str | None = None
        # Сказанное бригаде о службе: (когда, фраза) — второй раз то же не повторяют.
        self.told_said: list[tuple[float, str]] = []
        # Линия бригады на удержании, пока диспетчер звонит в службу (`tell_via_hold`) или
        # уточняет её вопрос (`ask_via_hold`).
        self.held: Talk | None = None
        # Ответы бригаде на удержании («Принял», вариант): после снятия и её повтора (`_resume`);
        # третий элемент — вопрос (id выдачи), на который отвечают, у «Принял» — None.
        self.on_resume: list[tuple[str, Callable[[], Awaitable[None]], str | None]] = []
        # Вопрос, повторённый снятой с удержания бригадой: (звонок, id выдачи, срок ответа в
        # секундах прогона или None) — до ответа или срока она придерживает новость (HQ-058).
        self.repeated: tuple[str, str, float | None] | None = None
        self.reload_needed = True
        self.next_tick = 0.0
        self.headers: dict[str, str] = {}
        self.teacher_headers: dict[str, str] = {}
        self.client: httpx.AsyncClient
        self.teacher: httpx.AsyncClient

    # --- время и расписание ----------------------------------------------------------------

    @property
    def t(self) -> float:
        return self.clock.offset

    def later(self, delay: float, what: str, action: Callable[[], Awaitable[None]]) -> None:
        self.plan.append(Scheduled(self.t + delay, what, action))

    def sim(self, moment: str | None) -> float | None:
        if not moment:
            return None
        return self.clock.at(datetime.fromisoformat(moment.replace("Z", "+00:00")))

    # --- API --------------------------------------------------------------------------------

    async def event(self, kind: str, payload: dict[str, Any]) -> httpx.Response:
        body = {
            "client_event_id": str(uuid4()),
            "client_ts": self.clock.now().isoformat().replace("+00:00", "Z"),
            "type": kind,
            "payload": payload,
        }
        response = await self.client.post(
            f"/api/cards/{self.card['id']}/events", json=body, headers=self.headers
        )
        # Не всякое действие меняет ревизию (связь с бригадой на табло после отбоя — нет):
        # клиент после своего действия перечитывает сведения.
        self.reload_needed = True
        if response.status_code != 200:
            self.tr.errors.append(
                f"{self.t:.1f} с: {kind} → {response.status_code} {response.text[:200]}"
            )
        return response

    async def reload(self) -> None:
        response = await self.client.get(f"/api/cards/{self.card['id']}/training")
        if response.status_code == 200:
            self.training = response.json()
        self.reload_needed = False

    async def _world(self) -> None:
        """Тик worker — только когда мир может измениться; иначе часы идут дальше без него.

        Мир меняется сам только по времени: доклад созрел, событию пора, вызов погас, отдел
        контроля звонит. Пока обучаемый ничего не делает, мир детерминирован, и движок сам
        говорит, когда наступит следующее (`_next_change`): тик до этого момента ничего не
        изменит. Если срок уже наступил, а тик ничего не меняет (доклад готов, но бригада
        занята), — проба вперёд с удвоением шага (`_probe`). Расшифровка та же, что при тике
        каждую секунду (`skip_idle=False`).
        """
        if not self.skip_idle:
            await self.tick()
            return
        t = self.t
        if self.dirty:
            self.dirty = False
            self.blocked = False
            self.quiet_until = -1.0
            self.next_change = await self._next_change()
        if t <= self.quiet_until or (not self.blocked and t < self.next_change):
            self.ticks["skipped"] += 1
            return
        if not self.blocked:
            if await self.tick():
                self.dirty = True
            else:
                self.blocked = True
            return
        horizon = t + self.lookahead
        if not await self._probe(horizon):
            self.quiet_until = horizon
            self.lookahead = min(self.lookahead * 2, MAX_LOOKAHEAD)
            self.ticks["skipped"] += 1
            return
        self.lookahead = FIRST_LOOKAHEAD
        lo, hi = t, horizon  # в hi мир меняется, в lo — неизвестно
        while hi - lo > TICK_EVERY:
            mid = lo + (int((hi - lo) / TICK_EVERY) // 2) * TICK_EVERY
            if await self._probe(mid):
                hi = mid
            else:
                lo = mid
                self.quiet_until = mid
        if self.quiet_until >= t:
            self.ticks["skipped"] += 1
            return
        if await self.tick():
            self.dirty = True

    async def _next_change(self) -> float:
        """Секунда симуляции, раньше которой мир без действий обучаемого не изменится."""
        self.ticks["plan"] += 1
        now = self.clock.now()
        far = now + FAR
        moments: list[datetime] = []
        async with self.app.state.database.sessions() as db:
            card = await db.get(Card, UUID(self.card["id"]))
            if card is None:
                return math.inf
            if card.closed_at is None and card.interrupted_at is None:
                moments += [at for _, at in await due_firings(db, card, far)]
                moments += [
                    report.ready_at
                    for report in await report_schedule(db, card, far)
                    if not report.issued and report.ready_at is not None
                ]
                if await unheard_reports(db, card):
                    moments.append(now)
                control = await control_plan(db, card)
                if control is not None and card.state in WITHOUT_STATUS:
                    moments.append(card.appeared_at + timedelta(seconds=int(control["after_s"])))
            for call in await card_calls(db, card.id):
                if (
                    call.direction == "inbound"
                    and call.answered_at is None
                    and call.ended_at is None
                ):
                    moments.append(call.started_at + MISSED_AFTER)
                if call.end_reason in MISSED and call.ended_at is not None:
                    moments.append(call.ended_at + REDIAL_AFTER)
        return min((self.clock.at(moment) for moment in moments), default=math.inf)

    async def _fingerprint(self, connection: AsyncConnection) -> tuple[Any, ...]:
        card = UUID(self.card["id"])
        revision = await connection.scalar(
            select(CardTrainingState.revision).where(CardTrainingState.card_id == card)
        )
        fired = await connection.scalar(
            select(func.count())
            .select_from(ScenarioEventFiring)
            .where(ScenarioEventFiring.card_id == card)
        )
        return revision, fired

    async def _probe(self, at: float) -> bool:
        """Изменит ли тик в секунду `at` что-нибудь — тик в транзакции, которая откатывается.

        Всё, что меняет тик, видно по ревизии сведений карточки (выдача, вызов бригады, отбой
        звонка, отдел контроля) или по записи срабатывания события.
        """
        self.ticks["probe"] += 1
        saved = self.clock.offset
        self.clock.offset = at
        try:
            async with self.app.state.database.engine.connect() as connection:
                outer = await connection.begin()
                try:
                    sessions = async_sessionmaker(
                        bind=connection,
                        class_=AsyncSession,
                        expire_on_commit=False,
                        join_transaction_mode="create_savepoint",
                    )
                    before = await self._fingerprint(connection)
                    await TrainingScheduler(sessions).tick(self.clock.now())
                    return await self._fingerprint(connection) != before
                finally:
                    await outer.rollback()
        finally:
            self.clock.offset = saved

    async def tick(self) -> bool:
        """Настоящий тик worker; True — мир изменился (ревизия сведений или срабатывание)."""
        self.ticks["real"] += 1
        self.quiet_until = -1.0
        engine = self.app.state.database.engine
        async with engine.connect() as connection:
            before = await self._fingerprint(connection)
        sessions = self.app.state.database.sessions
        await TrainingScheduler(sessions).tick(self.clock.now())
        async with engine.connect() as connection:
            after = await self._fingerprint(connection)
        # Перечитать сведения, только если тик что-то изменил: ревизия сведений карточки.
        if (after[0] or 1) != self.training.get("revision"):
            self.reload_needed = True
        return after != before

    def _logins(self) -> dict[str, dict[str, str]] | None:
        return getattr(self.app.state, "coherence_logins", None)

    async def _touched(self, request: httpx.Request) -> None:
        """Запрос, который может изменить мир (не чтение), — следующий тик настоящий."""
        if request.method != "GET":
            self.dirty = True

    # --- запуск -----------------------------------------------------------------------------

    async def run(self) -> Transcript:
        self.src = await sources_of(self.data)
        self.tr.data["sources"] = self.src
        with sim_time(self.clock):
            async with http(self.app) as teacher, http(self.app) as client:
                self.teacher, self.client = teacher, client
                for side in (teacher, client):
                    side.event_hooks["request"].append(self._touched)
                try:
                    await self._start()
                    await self._loop()
                finally:
                    await self._finish()
        self.tr.data["ticks"] = dict(self.ticks)
        return self.tr

    async def _start(self) -> None:
        self.teacher_headers = await login(self.teacher, "teacher", self._logins())
        users = {u["login"]: u for u in (await self.teacher.get("/api/users")).json()}
        settings = (await self.teacher.get("/api/settings")).json()
        call = self.data["reference"]["expected_call"]
        if call.get("contact_role"):
            contact: dict[str, Any] = {
                "role": call["contact_role"],
                "name": "Абонент",
                "number": CALLER_NUMBER,
            }
            # Характер заявителя меняет преподаватель у абонента занятия (HQ-019).
            if self.policy.caller_character:
                contact["character"] = self.policy.caller_character
            settings["phone_contacts"] = {self.service: [contact]}
        created = await self.teacher.post(
            "/api/sessions",
            headers=self.teacher_headers,
            json={
                "title": f"Связность {self.data['code']} · {self.policy.name}",
                "participants": [
                    {
                        "user_id": users[self.trainee]["id"],
                        "workstation_number": 17,
                        "dds_service_id": self.service,
                        "level": self.data["level"],
                    }
                ],
                "settings_snapshot": settings,
            },
        )
        if created.status_code != 201:
            raise RuntimeError(created.text)
        self.session_id = created.json()["id"]
        batch = await self.teacher.post(
            f"/api/sessions/{self.session_id}/assignments/batch",
            headers=self.teacher_headers,
            json={
                "request_id": str(uuid4()),
                "items": [
                    {
                        "participant_id": users[self.trainee]["id"],
                        "scenario_id": str(scenario_uuid(self.data)),
                        "scenario_version": self.data["version"],
                        "order": 1,
                        "delay_from_start_s": 0,
                        "delivery_mode": "profile",
                    }
                ],
            },
        )
        if batch.status_code != 201:
            raise RuntimeError(batch.text)
        started = await self.teacher.post(
            f"/api/sessions/{self.session_id}/start", headers=self.teacher_headers
        )
        if started.status_code != 200:
            raise RuntimeError(started.text)
        await CardScheduler(self.app.state.database.sessions).tick(self.clock.now())
        self.headers = await login(self.client, self.trainee, self._logins())
        cards = (await self.client.get("/api/cards")).json()
        self.card = next(c for c in cards if c["session_id"] == self.session_id)
        self.clock.offset = 0.0
        self.tr.add(Line(0.0, "world", "система", f"Карточка {self.card['source']['number']}"))
        self.later(1.0, "открыть карточку", self._open)
        decide = self._reject if self.policy.reject else self._accept
        self.later(self.policy.accept_after_s, "решение по карточке", decide)

    async def _finish(self) -> None:
        if self.talk is not None:
            await self._hang_up("диспетчер положил трубку (конец прогона)")
        sessions = self.app.state.database.sessions
        async with sessions() as db:
            card = await db.get(Card, UUID(self.card["id"])) if self.card else None
            if card is not None:
                self.tr.closed = card.closed_at is not None
                self.tr.final_state = card.state
                evaluation = await db.scalar(
                    select(Evaluation).where(Evaluation.card_id == card.id)
                )
                if evaluation is not None:
                    self.tr.scores = applied_scores(evaluation.rules_scores, evaluation.explanation)
                    self.tr.critical = applied_critical_flags(
                        evaluation.critical_flags, evaluation.explanation
                    )
                    for key, raw in (evaluation.explanation or {}).items():
                        if isinstance(raw, dict):
                            self.tr.review.extend(
                                f"{key}: {item}" for item in raw.get("evidence", [])
                            )
                keys = {
                    str(uuid5(scenario_uuid(self.data), f"event:{key}")): key for key in self.events
                }
                for firing in await db.scalars(
                    select(ScenarioEventFiring).where(ScenarioEventFiring.card_id == card.id)
                ):
                    key = keys.get(str(firing.event_id), str(firing.event_id))
                    at = self.clock.at(firing.fired_at)
                    self.tr.firings[key] = at
                    self.tr.add(Line(at, "world", "мир", f"сработало событие «{key}»", key=key))
        if self.session_id:
            await self.teacher.post(
                f"/api/sessions/{self.session_id}/finish",
                json={"contract_version": 2, "request_id": str(uuid4())},
                headers=self.teacher_headers,
            )

    # --- главный цикл ----------------------------------------------------------------------

    async def _loop(self) -> None:
        while self.t < HORIZON_S and self.state not in TERMINAL:
            if self.t >= self.next_tick:
                await self._world()
                self.next_tick = self.t + TICK_EVERY
            if self.reload_needed:
                await self.reload()
            await self._phone()
            await self._dispatcher()
            self.clock.advance(STEP)
        if self.state not in TERMINAL:
            self.tr.errors.append(f"карточку не закрыть за {HORIZON_S:.0f} с")

    async def _dispatcher(self) -> None:
        due = [item for item in self.plan if item.at <= self.t]
        for item in due:
            self.plan.remove(item)
            await item.action()
        await self._check_in()
        await self._inject()
        await self._incoming()

    # --- окно телефона ----------------------------------------------------------------------

    def _say_line(self, who: str, text: str, source: str, key: str | None = None) -> Line:
        duration = phone.speech_seconds(text)
        start = max(self.t, self.speaking_until)
        line = Line(
            start,
            "speech",
            who,
            text,
            source,  # type: ignore[arg-type]
            end=start + duration,
            call=self.talk.id if self.talk else None,
            key=key,
        )
        self.speaking_until = start + duration
        self.last_sound = self.speaking_until
        return self.tr.add(line)

    def _pending(self) -> list[dict[str, Any]]:
        """Выданные, но не предъявленные реплики бригады на линии — в порядке выдачи."""
        if self.talk is None or self.talk.kind != "brigade":
            return []
        items = [
            item
            for item in self.training.get("messages", [])
            if item["state"] != "presented"
            and item["delivery"]["delivery_id"] not in self.presented
            and item["delivery"]["brigade_id"] == self.talk.brigade_id
        ]
        # По времени, а не строкой («…16Z» и «…16.000001Z»), как `pendingMessages` клиента.
        return sorted(
            items, key=lambda item: datetime.fromisoformat(item["delivery"]["delivered_at"])
        )

    def _holds_news(self) -> bool:
        """Снятая с удержания бригада повторила вопрос и ждёт ответа в его сроке — новую
        реплику придерживает до ответа или срока (incoming.ts `holdsNews`, HQ-058)."""
        if self.repeated is None or self.talk is None:
            return False
        call, delivery_id, reply_by = self.repeated
        question = self._open_question()
        if call != self.talk.id or question is None:
            return False
        if question["delivery"]["delivery_id"] != delivery_id:
            return False
        return reply_by is None or self.t < reply_by

    def _open_question(self) -> dict[str, Any] | None:
        if self.talk is None:
            return None
        asked = [
            item
            for item in self.training.get("messages", [])
            if item["delivery"]["call_id"] == self.talk.id
            and item["delivery"]["delivery_id"] in self.presented
            and item["delivery"].get("reply_options")
            and not item.get("reply_key")
            and item["delivery"]["delivery_id"] not in self.replied
        ]
        return asked[-1] if asked else None

    def _origin(self, delivery: dict[str, Any]) -> tuple[str, str | None]:
        message = delivery["message"]
        if message["id"] in self.src.carried and self.carrying:
            return "plan", self.src.carried[message["id"]]
        source, key = self.src.by_id.get(message["id"], ("plan", None))
        if source == "plan" and key is not None:
            planned = self.src.plan_text.get(message["id"])
            if planned is not None and planned != message["text"]:
                return "wrong_address", key
        return source, key

    async def _phone(self) -> None:
        talk = self.talk
        if talk is None:
            return
        if self.playing is not None and self.t >= self.playing.end:
            await self._presented(self.playing)
            self.playing = None
        if self.t < self.speaking_until or self.playing is not None:
            return
        if talk.answered_at is None:
            return
        if self.queue:
            who, text, source, key = self.queue.pop(0)
            line = self._say_line(who, text, source, key)
            if source == "client" and key == "confirm_request":
                self.asked[talk.id] = line.end or self.t
            if key == QUESTION_REPEAT:
                question = self._open_question()
                if question is not None:
                    delivery = question["delivery"]
                    line.meta = {
                        "delivery_id": delivery["delivery_id"],
                        "options": [option["key"] for option in delivery["reply_options"]],
                        "inbound": talk.inbound,
                    }
            return
        if talk.kind != "brigade":
            return
        pending = [] if self._holds_news() else self._pending()
        if pending and self.t - talk.answered_at >= phone.MIN_LISTEN_S:
            item = pending[0]
            delivery = item["delivery"]
            message = delivery["message"]
            source, key = self._origin(delivery)
            line = self._say_line(self.brigade_name, message["text"], source, key)
            if not delivery.get("reply_options") and not delivery.get("answer"):
                # Доклад о выезде не повторяют (`departure`, Softphone `lastPlainReport`).
                if delivery.get("departure"):
                    self.last_report.pop(delivery["brigade_id"], None)
                else:
                    self.last_report[delivery["brigade_id"]] = message["text"]
            line.meta = {
                "delivery_id": delivery["delivery_id"],
                "message_id": message["id"],
                "options": [option["key"] for option in delivery.get("reply_options", [])],
                "answer": bool(delivery.get("answer")),
                "inbound": talk.inbound,
            }
            self.playing = Playing(delivery, line.end or self.t, talk.id)
            return
        await self._maybe_quiet()

    async def _presented(self, playing: Playing) -> None:
        delivery = playing.delivery
        audio = delivery["message"].get("audio")
        await self.event(
            "message_presented",
            {
                "delivery_id": delivery["delivery_id"],
                "message_version": delivery["message"]["version"],
                "playback_id": str(uuid4()),
                "channel": "audio" if audio else "text",
                "audio_version": audio["version"] if audio else None,
            },
        )
        self.presented.add(delivery["delivery_id"])
        self.heard_delivery[delivery["delivery_id"]] = self.t
        talk = self.talk
        if talk is not None:
            talk.heard = True
        inbound = talk.inbound if talk else False
        if talk is not None and phone.asks_confirmation(delivery, inbound):
            self.queue.append(
                (
                    self.brigade_name,
                    phone.confirm_request_phrase(self.service),
                    "client",
                    "confirm_request",
                )
            )
        await self._heard(delivery)

    async def _maybe_quiet(self) -> None:
        """Сказать нечего — бригада кладёт трубку (Softphone.tsx, `brigadeQuiet`)."""
        talk = self.talk
        if talk is None or talk.kind != "brigade" or talk.answered_at is None:
            return
        if not talk.inbound and not talk.briefed and not self.dispatched:
            return  # ждёт вводной
        if self._open_question() is not None:
            return
        if talk.id in self.asked:
            return  # спросила «Как приняли?» — ждёт ответа
        last = self.tr.lines[-1] if self.tr.lines else None
        quiet = (
            phone.CONFIRMED_QUIET_S
            if self.confirmed_on == talk.id and last is not None and last.who == "Вы"
            else phone.BRIGADE_QUIET_S
        )
        if self.t - self.last_sound >= quiet:
            await self._hang_up("бригада положила трубку", by_brigade=True)

    # --- звонки -----------------------------------------------------------------------------

    async def _hang_up(self, why: str, by_brigade: bool = False) -> None:
        talk = self.talk
        if talk is None:
            return
        payload: dict[str, Any] = {"call_id": talk.id}
        if talk.kind == "service":
            payload.update(FULL_REPORT)
        await self.event("call_hangup", payload)
        for line in self.tr.lines:
            # Оборванная отбоем реплика: звучала до отбоя.
            if line.call == talk.id and line.kind == "speech" and (line.end or 0) > self.t:
                line.end = max(line.at, self.t)
                line.meta["cut"] = True
        self.tr.add(Line(self.t, "call", "", f"{talk.label}: {why}"))
        self.talk = None
        self.queue.clear()
        if self.playing is not None:
            # Оборванная реплика не предъявлена — прозвучит в следующем разговоре.
            self.playing = None
        self.asked.pop(talk.id, None)
        self.speaking_until = self.t

    async def _dial_brigade(self, why: str) -> None:
        if self.talk is not None:
            await self._hang_up("диспетчер положил трубку")
        call_id = str(uuid4())
        await self.event(
            "call_dial_target",
            {"call_id": call_id, "call_target_id": self.target_id, "brigade_id": self.brigade_id},
        )
        self.talk = Talk(call_id, "brigade", self.brigade_name, False, brigade_id=self.brigade_id)
        self.tr.add(Line(self.t, "call", "", f"Исходящий вызов: {self.brigade_name} ({why})"))
        self.later(2.0, "бригада берёт трубку", self._brigade_answers)

    async def _brigade_answers(self) -> None:
        talk = self.talk
        if talk is None or talk.answered_at is not None:
            return
        await self.event("call_answer", {"call_id": talk.id})
        talk.answered_at = self.t
        self.last_sound = self.t
        self.queue.append(
            (self.brigade_name, phone.brigade_phrase(self.service, "answer"), "client", "answer")
        )
        if not self.dispatched:
            self.later(phone.speech_seconds("Расчёт на связи.") + 0.5, "вводная", self._brief)
        elif self.tell_brigade is not None:
            said, self.tell_brigade = self.tell_brigade, None
            self.later(
                phone.speech_seconds("Расчёт на связи.") + 0.5,
                "сказать бригаде, что служба едет",
                partial(self._say_to_brigade, said),
            )
        else:
            self.later(phone.speech_seconds("Расчёт на связи.") + 0.5, "доложите", self._ask_report)

    async def _incoming(self) -> None:
        ringing = {item["call_id"]: item for item in self.training.get("incoming", [])}
        for call_id, item in ringing.items():
            if call_id not in self.rings:
                self.rings[call_id] = self.t
                label = "ТРЕВОЖНЫЙ вызов" if item.get("priority") == "alarm" else "Входящий вызов"
                self.tr.add(Line(self.t, "call", "", f"{label}: {self.brigade_name}"))
        for call_id in list(self.rings):
            if call_id in ringing or call_id in self.missed_rings:
                continue
            if self.talk is not None and self.talk.id == call_id:
                continue
            self.missed_rings.add(call_id)
            self.tr.add(Line(self.t, "call", "", f"Вызов «{self.brigade_name}» погас без ответа"))
        if self.talk is not None:
            return
        delay = self.policy.ring_answer_s
        for call_id, item in ringing.items():
            alarm = item.get("priority") == "alarm"
            wait = 2.0 if alarm and delay is None else delay
            if wait is None or self.t - self.rings[call_id] < wait:
                continue
            await self.event("call_answer", {"call_id": call_id})
            self.rings.pop(call_id, None)
            self.talk = Talk(
                call_id, "brigade", self.brigade_name, True, self.t, brigade_id=item["brigade_id"]
            )
            self.last_sound = self.t
            self.tr.add(Line(self.t, "call", "", f"Ответ на вызов: {self.brigade_name}"))
            self.queue.append(
                (self.brigade_name, phone.intro_phrase(self.service), "client", "intro")
            )
            return

    async def _check_in(self) -> None:
        """Бригада долго без связи (табло сил) — диспетчер звонит ей сам."""
        if self.talk is not None or not self.dispatched or self.state in TERMINAL:
            return
        after = self.policy.check_in_after_s
        silent_dispatcher = self.policy.ring_answer_s is None
        if after is None and not silent_dispatcher:
            return
        if any(item.what.startswith("звонок") for item in self.plan):
            return
        contacts = {
            item["brigade_id"]: item.get("last_contact_at")
            for item in self.training.get("brigade_contacts", [])
        }
        last = self.sim(contacts.get(self.brigade_id))
        limit = after if after is not None else 30.0
        if silent_dispatcher and self.training.get("callbacks"):
            limit = min(limit, 30.0)
        if last is not None and self.t - last >= limit:
            await self._dial_brigade("бригада долго без связи")

    async def _inject(self) -> None:
        for kind, state in self.policy.injects.items():
            if kind in self.injected or not _reached(self.state, state):
                continue
            response = await self.teacher.post(
                f"/api/sessions/{self.session_id}/injects",
                json={"kind": kind, "targets": "all"},
                headers=self.teacher_headers,
            )
            results = response.json().get("results", []) if response.status_code == 200 else []
            if any(item.get("status") == "fired" for item in results):
                self.injected.add(kind)
                self.reload_needed = True
                self.tr.add(Line(self.t, "action", "преподаватель", f"вводная «{kind}»"))

    # --- действия диспетчера ----------------------------------------------------------------

    async def _open(self) -> None:
        await self.event("deliver", {})
        await self.event("open", {})
        # «Номер наряда» — прямой номер бригады, которую движок направит (оценка его сверяет).
        targets = (await self.client.get(f"/api/services/{self.service}/call-targets")).json()
        number = next(t["phone_ext"] for t in targets if t["id"] == self.target_id)
        self.brigade_name = f"Бригада {number}"
        await self.event("field_change", {"field": "service_number", "value": number})
        self.state = "received"

    async def _status(self, state: str, comment: str) -> bool:
        response = await self.event("status_change", {"state": state, "comment": comment})
        if response.status_code == 200:
            self.state = state
            self.tr.add(Line(self.t, "action", "Вы", f"статус «{state}»"))
            return True
        return False

    async def _accept(self) -> None:
        source = self.card["source"]
        victims = "Есть пострадавшие." if source["victims"] else "Пострадавших нет."
        comment = f"Принята: {source['incident_class']}. {source['description']} {victims}"
        if await self._status("accepted", comment):
            self.later(1.0, "звонок бригаде с вводной", lambda: self._dial_brigade("вводная"))
            await self._call_ahead()

    async def _reject(self) -> None:
        comment = self.data["reference"]["expected_comment"]
        if await self._status("rejected", comment):
            services = self.data["reference"].get("expected_service_ids") or ["GKH"]
            await self.event("redirect", {"service_id": services[0], "comment": comment})
            self.state = "redirected"

    def _ahead_events(self) -> list[dict[str, Any]]:
        return [
            event
            for event in self.events.values()
            if event["kind"] == "request_service"
            and self.policy.aim(event["key"]) in ("already", "surprise", "told")
        ]

    async def _call_ahead(self) -> None:
        """Служба вызвана заранее (GP-28): звонок сразу после «Принята»."""
        for event in self._ahead_events():
            ext = _first_ext(event)
            self.later(0.5, f"звонок в {ext} заранее", partial(self._dial_service, ext))

    def after_speech(self, line: Line, what: str, action: Callable[[], Awaitable[None]]) -> None:
        """Событие уходит, когда диспетчер договорил фразу (как клиент после распознавания)."""
        self.later(max(0.0, (line.end or self.t) - self.t), what, action)

    async def _brief(self) -> None:
        talk = self.talk
        if talk is None or talk.answered_at is None:
            return
        address = self.card["source"]["address"]
        house = address.get("house") or ""
        if self.policy.briefing == "wrong_address" and house:
            house = house + "1"
        incident = self.card["source"].get("incident_class") or self.card["source"]["description"]
        text = f"{address['street']}, дом {house}. {incident}"
        line = self._say_line("Вы", text, "dispatcher", "briefing")
        self.after_speech(line, "вводная отправлена", lambda: self._briefed(talk, text))

    async def _briefed(self, talk: Talk, text: str) -> None:
        if self.talk is not talk:
            return
        check = await self.client.post(
            f"/api/calls/{talk.id}/briefing-check", json={"text": text}, headers=self.headers
        )
        body = check.json() if check.status_code == 200 else {}
        answer = body.get("readback") or body.get("ask_again")
        if answer:
            self.queue.append((self.brigade_name, answer, "readback", None))
        if body.get("complete"):
            payload = {"call_id": talk.id, "mode": "voice", "text": text}
            await self.event("brigade_briefing", payload)
            talk.briefed = True
            self.dispatched = True
            self.tr.add(Line(self.t, "action", "Вы", "вводная бригаде (выезд)"))
            for event in self._ahead_events():
                if self.policy.aim(event["key"]) == "told":
                    said = _told_phrase(event)
                    self.later(
                        4.0,
                        "сказать бригаде, что служба вызвана",
                        partial(self._say_to_brigade, said),
                    )

    async def _say_to_brigade(self, text: str) -> None:
        talk = self.talk
        if talk is None or talk.kind != "brigade" or talk.answered_at is None:
            return
        if self.playing is not None or self.t < self.speaking_until or self.queue:
            # Обучаемый не говорит поверх бригады: фраза уходит на сервер, когда звучит.
            # Иначе (ночной прогон 17.10) «Скорую уже вызвал» уходило во время тревоги, сервер
            # не считал его ответом на неё, а расшифровка ставила фразу после — и «Как
            # приняли?» звучало после «Понял, скорую ждём» без ответа.
            self.later(0.5, "сказать бригаде в паузе", partial(self._say_to_brigade, text))
            return
        self._say_line("Вы", text, "dispatcher")
        # Поправку повтора адреса (HQ-024) окно телефона узнаёт из распознавания фразы
        # (`world_answers`): ответит бригада репликой ветки мира, своего ответа окно не даёт.
        world_answers = await self._world_answers(talk, text)
        await self.event("brigade_said", {"call_id": talk.id, "text": text})
        self.told_said.append((self.t, text))
        if world_answers:
            return
        # Ответ — как у окна телефона (`brigadeAnswer`): «Понял, ждём скорую», только если
        # сервер засчитал бы весть сейчас (после звонка в службу и до её приезда, HQ-055).
        awaited = phone.awaited_service(
            self.training.get("messages", []), talk.brigade_id, self.clock.now(), self._dials()
        )
        news = phone.news_service(text, awaited) is not None
        answer = phone.brigade_answer(
            text, self.last_report.get(talk.brigade_id or ""), self.service, awaited
        )
        self.queue.append(
            (self.brigade_name, answer, "client", "service_coming" if news else "ack")
        )

    async def _world_answers(self, talk: Talk, text: str) -> bool:
        """`world_answers` распознавания фразы (`POST /calls/{id}/voice-reply`, HQ-024)."""
        if self.app is None or talk.brigade_id is None:
            return False
        async with self.app.state.database.sessions() as db:
            card = await db.get(Card, UUID(self.card["id"]))
            return card is not None and bool(
                await phrase_fixes_readback(db, card, UUID(talk.brigade_id), text, self.clock.now())
            )

    def _dials(self) -> list[phone.Dial]:
        """Наборы номеров служб, как их знает окно телефона: из выдачи и свои (`dials.ts`)."""
        own = [
            phone.Dial(
                phone_services().get(ext, ext),
                self.clock.start + timedelta(seconds=at),
                local=True,
            )
            for ext, at in self.tr.service_calls
        ]
        return [*phone.server_dials(self.training.get("service_calls", [])), *own]

    async def _ask_report(self) -> None:
        talk = self.talk
        if talk is None or talk.answered_at is None:
            return
        text = "Доложите обстановку."
        self._say_line("Вы", text, "dispatcher")
        await self.event("brigade_said", {"call_id": talk.id, "text": text})
        answer = phone.brigade_answer(
            text, self.last_report.get(talk.brigade_id or ""), self.service
        )
        self.queue.append((self.brigade_name, answer, "client", "report_request"))

    async def _heard(self, delivery: dict[str, Any]) -> None:
        """Диспетчер услышал реплику бригады — что он делает по политике."""
        source, key = self._origin(delivery)
        talk = self.talk
        message_id = delivery["message"]["id"]
        report = self._report_for(delivery, source, key)
        if report is not None:
            self.stage = report["justifies_state"]
            await self._after_report(report, delivery)
        if delivery.get("reply_options"):
            event = self.src.event_by_line.get(message_id)
            if event is None and source == "plan" and key is not None:
                event = None
            await self._react(event, delivery)
        elif source == "event" and key in self.events:
            await self._react(self.events[key], delivery)
        if talk is not None and talk.inbound and phone.asks_confirmation(delivery, True):
            if self.policy.hangup_after_report:
                self.later(0.3, "трубку сразу", lambda: self._hang_up("диспетчер положил трубку"))
            elif self.policy.confirm_after_s is not None:
                self.later(
                    self.policy.confirm_after_s + 1.2,
                    "«Принял»",
                    partial(self._confirm, delivery),
                )
            else:
                self.later(
                    SILENT_HANGUP_S + 1.2,
                    "молча кладёт трубку",
                    lambda: self._hang_up("диспетчер положил трубку"),
                )

    def _report_for(
        self, delivery: dict[str, Any], source: str, key: str | None
    ) -> dict[str, Any] | None:
        if source in ("plan", "wrong_address") and key is not None:
            return next((r for r in self.data["plan"] if r["key"] == key), None)
        if source == "replace" and key is not None:
            # Подмена доклада веткой: обосновывает тот же статус, что подменённый доклад.
            message = delivery["message"]
            return self.src.replacement_reports.get((message["id"], message["text"]))
        return None

    async def _after_report(self, report: dict[str, Any], delivery: dict[str, Any]) -> None:
        state = report["justifies_state"]
        plan = self.data["plan"]
        last = report["key"] == plan[-1]["key"]
        change = report.get("task_change") or {}
        call = change.get("expected_call") or {}
        if call.get("required") and call.get("phone_ext"):
            ext = str(call["phone_ext"])
            self.later(3.0, f"звонок в {ext} по докладу", lambda: self._dial_service(ext))
        if last:
            flow = self.data["reference"]["expected_flow"]
            final = flow[-1] if flow[-1] in REPORT_STATES else state
            comment = self.data["reference"]["expected_comment"]
            if change.get("expected_comment"):
                comment = change["expected_comment"]
            delay = self.policy.status_after_s + (12.0 if call.get("required") else 0.0)
            self.later(delay, f"статус «{final}»", lambda: self._final(final, comment))
            return
        if _reached(self.state, state):
            return
        text = delivery["message"]["text"]
        self.later(
            self.policy.status_after_s,
            f"статус «{state}»",
            lambda: self._status_if_needed(state, text),
        )

    async def _status_if_needed(self, state: str, comment: str) -> None:
        if not _reached(self.state, state):
            await self._status(state, comment)

    async def _final(self, final: str, comment: str) -> None:
        talk = self.talk
        busy = talk is not None and (
            talk.kind == "service"
            or talk.id in self.asked
            or bool(self.queue)
            or self.speaking_until > self.t
        )
        if busy:
            # Сначала договорить: после закрытия карточки отбой не принимается, а на
            # «Как приняли?» эталонный диспетчер отвечает.
            self.later(1.0, f"статус «{final}»", partial(self._final, final, comment))
            return
        if self.talk is not None:
            await self._hang_up("диспетчер положил трубку")
        # Ход статусов до завершающего: недостающие промежуточные — по порядку плана.
        for report in self.data["plan"][:-1]:
            state = report["justifies_state"]
            if not _reached(self.state, state):
                await self._status(state, comment)
        await self._status(final, comment)

    async def _confirm(self, delivery: dict[str, Any]) -> None:
        held = self.held
        if held is not None and held.id in self.asked:
            # Спросившая бригада на удержании (диспетчер говорит со службой) — ответить, когда
            # её снимут с удержания и она переспросит.
            self.on_resume.append(("«Принял»", partial(self._confirm, delivery), None))
            return
        talk = self.talk
        if talk is None or talk.id not in self.asked:
            return
        if any(key == "confirm_request" for *_, key in self.queue):
            # Снятая с удержания бригада сейчас переспросит «Как приняли?» — ответить на него.
            self.later(0.5, "«Принял»", partial(self._confirm, delivery))
            return
        text = "Принял."
        self._say_line("Вы", text, "dispatcher", "confirm")
        await self.event(
            "report_confirmed",
            {"call_id": talk.id, "delivery_id": delivery["delivery_id"], "text": text},
        )
        self.asked.pop(talk.id, None)
        self.confirmed_on = talk.id

    async def _react(self, event: dict[str, Any] | None, delivery: dict[str, Any]) -> None:
        if event is None:
            return
        aim = self.policy.aim(event["key"])
        expect = event["expect"][0]
        action = expect["action"]
        within = float(expect.get("within_s", 30))
        options = [item["key"] for item in delivery.get("reply_options", [])]
        if action in ("reply", "correct_readback"):
            right = expect["option_key"]
            wrong = next((key for key in options if key != right), None)
            if aim == "met" and self.policy.fix_phrase and action == "correct_readback":
                # «Понял», следом верный адрес фразой (HQ-024): поправка голосом до срока.
                fix = _fix_phrase(delivery, right, self.policy.fix_phrase)
                self.later(
                    self.policy.reply_after_s,
                    "«Понял» бригаде",
                    lambda: self._reply(delivery, wrong or right),
                )
                self.later(
                    self.policy.reply_after_s + 4.0,
                    "поправка адреса фразой",
                    partial(self._say_to_brigade, fix),
                )
                return
            if aim in ("met", "already", "told", "surprise"):
                if self.policy.ask_via_hold and action == "reply":
                    self.later(
                        self.policy.reply_after_s,
                        "уточнить с удержания",
                        partial(self._ask_via_hold, delivery, right),
                    )
                    return
                self.later(
                    self.policy.reply_after_s, "ответ бригаде", lambda: self._reply(delivery, right)
                )
            elif aim == "wrong" and wrong is not None:
                self.later(
                    self.policy.reply_after_s,
                    "ответ бригаде (не тот)",
                    lambda: self._reply(delivery, wrong),
                )
            elif aim == "late":
                self.later(
                    within + 3.0, "ответ бригаде после срока", lambda: self._reply(delivery, right)
                )
            else:
                self.later(
                    IGNORE_HANGUP_S,
                    "молча кладёт трубку",
                    lambda: self._hang_up("диспетчер положил трубку"),
                )
            return
        if action == "call_service":
            ext = _first_ext(event)
            if self.policy.ask_via_hold and any(
                ext == number for number, _ in self.tr.service_calls
            ):
                # Уточняя вопрос бригады, диспетчер уже позвонил в эту службу: «уже вызвал».
                aim = "already"
            if aim == "already":
                self.later(
                    self.policy.reply_after_s,
                    "«уже вызвал»",
                    lambda: self._reply(delivery, "already"),
                )
                return
            if aim in ("surprise", "missed", "told"):
                self.later(
                    IGNORE_HANGUP_S,
                    "молча кладёт трубку",
                    lambda: self._hang_up("диспетчер положил трубку"),
                )
                return
            if "calling" in options:
                self.later(
                    self.policy.reply_after_s, "«вызываю»", lambda: self._reply(delivery, "calling")
                )
            delay = self.policy.reply_after_s + 2.5 if aim != "late" else within + 4.0
            told = _told_phrase(event, self.policy) if self.policy.tell_after_call else None
            since = self.t
            self.later(delay, f"звонок в {ext}", lambda: self._dial_service(ext, told, since=since))
            return
        if action == "answer_call" and len(event["expect"]) > 1:
            second = event["expect"][1]
            if second["action"] == "call_service":
                ext = str(second["phone_exts"][0])
                delay = 4.0 if aim != "late" else float(second["within_s"]) + 4.0
                told = _told_phrase(event, self.policy) if self.policy.tell_after_call else None
                since = self.t
                self.later(
                    delay, f"звонок в {ext}", lambda: self._dial_service(ext, told, since=since)
                )

    async def _reply(self, delivery: dict[str, Any], key: str) -> None:
        held = self.held
        if held is not None and held.id == delivery["call_id"]:
            # Спросившая бригада на удержании — ответить, когда её снимут с удержания и она
            # повторит вопрос (HQ-058).
            self.on_resume.append(
                ("ответ бригаде", partial(self._reply, delivery, key), delivery["delivery_id"])
            )
            return
        talk = self.talk
        if talk is not None and any(item[3] == QUESTION_REPEAT for item in self.queue):
            # Снятая с удержания бригада сейчас повторит вопрос — ответить на него.
            self.later(0.5, "ответ бригаде", partial(self._reply, delivery, key))
            return
        if talk is None or talk.id != delivery["call_id"]:
            self.tr.errors.append(f"{self.t:.1f} с: ответить бригаде нельзя — разговора нет")
            return
        label = next(
            (o["label"] for o in delivery.get("reply_options", []) if o["key"] == key), key
        )
        line = self._say_line("Вы", label, "dispatcher", f"reply:{key}")
        self.replied.add(delivery["delivery_id"])
        payload = {
            "call_id": talk.id,
            "delivery_id": delivery["delivery_id"],
            "option_key": key,
            "mode": "option",
        }
        self.after_speech(line, "ответ отправлен", lambda: self._send_reply(talk, payload))

    async def _ask_via_hold(self, delivery: dict[str, Any], key: str) -> None:
        """Уточнить вопрос бригады (политика `ask_via_hold`, HQ-058): бригада на удержание,
        звонок заявителю или в службу сценария (`hold_call_target`), после него — снятие с
        удержания (`_resume`: бригада повторяет вопрос) и ответ на повтор."""
        talk = self.talk
        if talk is None or talk.id != delivery["call_id"]:
            await self._reply(delivery, key)
            return
        if self.playing is not None or self.t < self.speaking_until or self.queue:
            end = max(self.speaking_until, self.playing.end if self.playing else self.t)
            self.later(
                max(0.0, end - self.t) + HANGUP_REACTION_S,
                "уточнить с удержания",
                partial(self._ask_via_hold, delivery, key),
            )
            return
        target = hold_call_target(self.data)
        if target == "caller" and (self.caller_book is None or self.contact_called):
            target = None
        if target is None:
            await self._reply(delivery, key)
            return
        await self._hold(talk)
        self.on_resume.append(
            ("ответ бригаде", partial(self._reply, delivery, key), delivery["delivery_id"])
        )
        if target == "caller":
            self.contact_called = True
            self.caller_short = True
            await self._dial_caller()
        else:
            await self._dial_service(target)

    async def _send_reply(self, talk: Talk, payload: dict[str, Any]) -> None:
        if self.talk is talk:
            await self.event("brigade_reply", payload)
            # Бригада спросила то, что знает только заявитель (HQ-019): ответив ей, диспетчер
            # звонит заявителю.
            if self.caller_book is not None and not self.contact_called:
                self.contact_called = True
                self.later(CALLER_GAP_S, "звонок заявителю", self._call_caller)

    async def _dial_service(
        self, ext: str, told: str | None = None, heard: bool = False, since: float = 0.0
    ) -> None:
        """Звонок в службу; `told` — потом перезвонить бригаде и сказать, что служба едет
        (решение HQ-055: о вызванной службе бригаде сообщает диспетчер). Политика
        `tell_via_hold` — как в окне телефона: линия бригады на удержании (отметка `call_hold`,
        звонок бригады на сервере не кончается), звонок в службу, возврат на линию бригады.

        Говорит бригада — диспетчер дослушивает фразу (`heard`) и кладёт трубку; позвонившую
        бригаду он сперва выслушивает, зачем она звонит. Мир он не останавливает: следующую
        выданную реплику окно телефона начинает само сразу после предыдущей (useBrigade,
        `present`), и отбой её обрывает — она не предъявлена и прозвучит в следующем разговоре.
        """
        talk = self.talk
        if talk is not None:
            if talk.kind == "brigade" and talk.answered_at is not None:
                busy = self.speaking_until > self.t or self.playing is not None
                unheard = talk.inbound and not talk.heard and (busy or bool(self._pending()))
                if unheard or (busy and not heard):
                    end = max(self.speaking_until, self.playing.end if self.playing else self.t)
                    self.later(
                        max(0.0, end - self.t) + HANGUP_REACTION_S,
                        f"звонок в {ext}",
                        partial(self._dial_service, ext, told, True, since),
                    )
                    return
            if talk.kind == "brigade" and told is not None and self.policy.tell_via_hold:
                await self._hold(talk)
            else:
                await self._hang_up("диспетчер положил трубку")
        call_id = str(uuid4())
        response = await self.event("call_dial", {"call_id": call_id, "phone_ext": ext})
        if response.status_code != 200:
            await self._back_after_failed_dial()
            return
        self.tr.service_calls.append((ext, self.t))
        service = phone_services().get(ext, ext)
        self.talk = Talk(
            call_id,
            "service",
            f"Служба {service}",
            False,
            phone_ext=ext,
            told=told,
            told_since=max(since, self.t),
        )
        self.tr.add(Line(self.t, "call", "", f"Исходящий вызов: служба {ext}"))
        self.later(2.0, "служба отвечает", self._service_answers)

    async def _service_answers(self) -> None:
        talk = self.talk
        if talk is None or talk.kind != "service":
            return
        await self.event("call_answer", {"call_id": talk.id})
        talk.answered_at = self.t
        self._say_line(talk.label, phone.official_phrase("answer"), "service")
        if self.policy.tell_during_service and self.held is not None and talk.told is not None:
            # Служба на удержании, звонок в неё идёт (срока вести ещё нет) — к бригаде.
            self.talk = None
            await self.event("call_hold", {"call_id": talk.id})
            self.tr.add(Line(self.t, "call", "", f"{talk.label}: на удержании"))
            back = await self._resume()
            self.later(
                max(0.0, self.speaking_until - self.t) + back + 0.5,
                "сказать бригаде, что служба едет (звонок в службу идёт)",
                partial(self._say_to_brigade, talk.told),
            )
            self.later(back + 1.0, "вернуться к службе", partial(self._back_to_service, talk))
            return
        await self._report_to_service(talk)

    async def _back_to_service(self, talk: Talk) -> None:
        """Сказав бригаде, что служба едет, — положить трубку бригаде и снять службу с
        удержания: дежурный снова на связи, доклад продолжается (окно телефона, `hold.ts`)."""
        said = any(text == talk.told and at >= talk.told_since for at, text in self.told_said)
        busy = self.queue or self.playing is not None or self.t < self.speaking_until
        if not said or busy:
            self.later(0.5, "вернуться к службе", partial(self._back_to_service, talk))
            return
        await self._hang_up("диспетчер положил трубку")
        self.talk = talk
        await self.event("call_resume", {"call_id": talk.id})
        self.tr.add(Line(self.t, "call", "", f"{talk.label}: снят с удержания"))
        self._say_line(talk.label, phone.official_phrase("answer"), "service")
        await self._report_to_service(talk)

    async def _report_to_service(self, talk: Talk) -> None:
        source = self.card["source"]
        text = (
            f"Диспетчер службы {self.service}. {source['address']['street']}, "
            f"{source['address'].get('house', '')}. Работаем по карточке "
            f"{source['number']}, нужна помощь."
        )
        line = self._say_line("Вы", text, "dispatcher", "service_report")
        line.end = (line.at or self.t) + SERVICE_REPORT_SECONDS
        self.speaking_until = line.end
        self._say_line(talk.label, phone.official_phrase("accepted"), "service")
        self.later(
            self.speaking_until - self.t + 0.5, "отбой службе", partial(self._service_done, talk)
        )

    async def _service_done(self, talk: Talk) -> None:
        if self.talk is talk:
            await self._hang_up("отбой")
        already = any(text == talk.told and at >= talk.told_since for at, text in self.told_said)
        if self.held is not None and self.talk is None:
            back = await self._resume()
            if talk.told is not None and not already and self.state not in TERMINAL:
                self.tell_brigade = talk.told
                self.later(back + 0.5, "сказать бригаде, что служба едет", self._tell_pending)
            return
        if talk.told is not None and not already and self.state not in TERMINAL:
            self.tell_brigade = talk.told
            self.later(3.0, "сказать бригаде, что служба едет", self._tell_pending)

    # --- живой заявитель (HQ-019) -------------------------------------------------------------

    async def _call_caller(self) -> None:
        """Звонок заявителю: дослушав бригаду и ответив «Принял» на её «Как приняли?» (HQ-058),
        диспетчер кладёт ей трубку и набирает номер."""
        talk = self.talk
        if talk is not None:
            busy = (
                self.speaking_until > self.t
                or self.playing is not None
                or bool(self.queue)
                or talk.id in self.asked
            )
            if busy or (talk.kind == "brigade" and bool(self._pending())):
                end = max(self.speaking_until, self.playing.end if self.playing else self.t)
                self.later(
                    max(0.0, end - self.t) + HANGUP_REACTION_S,
                    "звонок заявителю",
                    self._call_caller,
                )
                return
            await self._hang_up("диспетчер положил трубку")
        await self._dial_caller()

    async def _dial_caller(self) -> None:
        call_id = str(uuid4())
        response = await self.event("call_dial", {"call_id": call_id, "phone_ext": CALLER_NUMBER})
        if response.status_code != 200:
            await self._back_after_failed_dial()
            return
        self.talk = Talk(call_id, "caller", "Заявитель", False, phone_ext=CALLER_NUMBER)
        self.tr.add(Line(self.t, "call", "", f"Исходящий вызов: заявитель {CALLER_NUMBER}"))
        self.later(2.0, "заявитель отвечает", self._caller_answers)

    async def _caller_answers(self) -> None:
        talk = self.talk
        if talk is None or talk.kind != "caller" or self.caller_book is None:
            return
        await self.event("call_answer", {"call_id": talk.id})
        talk.answered_at = self.t
        self._caller_turn(talk, caller.pick_up(self.caller_book, self.caller_memory))

    def _caller_turn(self, talk: Talk, turn: caller.Turn) -> None:
        """Реплики заявителя по очереди, отметка `caller_said` — когда каждая зазвучала; потом —
        отбой заявителя или следующий шаг диспетчера."""
        self.caller_memory = turn.memory
        for phrase in turn.lines:
            line = self._say_line("Заявитель", phrase["text"], "caller", phrase["id"])
            payload = {"call_id": talk.id, "phrase_id": phrase["id"]}
            self.later(
                max(0.0, line.at - self.t),
                "реплика заявителя",
                partial(self._caller_said, talk, payload),
            )
        after = max(0.0, self.speaking_until - self.t)
        if turn.hangup:
            self.later(after + 0.8, "заявитель кладёт трубку", partial(self._caller_leaves, talk))
            return
        self.later(after + CALLER_GAP_S, "вопрос заявителю", partial(self._caller_next, talk))

    async def _caller_said(self, talk: Talk, payload: dict[str, Any]) -> None:
        await self.event("caller_said", payload)

    async def _caller_next(self, talk: Talk) -> None:
        """Следующий шаг диспетчера: политика «молчит» молчит до отбоя заявителя (один раз),
        иначе — где заявитель и когда подойдёт (до полного ответа), просьба подойти, прощание."""
        if self.talk is not talk or self.caller_book is None:
            return
        if self.policy.caller == "silent" and self.caller_dropped == 0:
            self.later(caller.NO_REPLY_S, "тишина диспетчера", partial(self._caller_silence, talk))
            return
        memory = self.caller_memory
        needed = tuple(f for f in CALLER_ASKS if memory.facts.get(f) != "full")
        if self.caller_asks >= CALLER_MAX_ASKS or self.caller_short:
            needed = ()
        intro = not memory.service
        table = caller.plots()[self.caller_book.plot]
        if needed:
            text = " ".join(table["facts"][fact]["ask"] for fact in needed)
        elif not self.caller_agreed:
            text = table["come"]
            self.caller_agreed = True
        else:
            text = CALLER_BYE
        if intro:
            text = f"Диспетчер {service_name(self.service)}, по вашей заявке. {text}"
        self.caller_asks += 1
        self._say_line("Вы", text, "dispatcher", "caller_ask")
        address = self.card["source"]["address"]
        heard = caller.hear(text, self.caller_book.plot, address["street"])
        turn = caller.reply(
            self.caller_book, memory, heard, (address["house"], address["apartment"])
        )
        self._caller_turn(talk, turn)

    async def _caller_silence(self, talk: Talk) -> None:
        if self.talk is not talk or self.caller_book is None:
            return
        self._caller_turn(talk, caller.silence(self.caller_book, self.caller_memory))

    async def _caller_leaves(self, talk: Talk) -> None:
        """Заявитель положил трубку: попрощавшись — разговор окончен; по тишине — перезвон."""
        if self.talk is not talk:
            return
        farewell = not self.caller_memory.dropped
        self.caller_memory = caller.hung_up(self.caller_memory, farewell)
        await self._hang_up("заявитель положил трубку")
        if farewell and self.held is not None:
            # Уточнял вопрос бригады с удержания (`ask_via_hold`) — снова к ней.
            self.caller_short = False
            await self._resume()
            return
        if not farewell:
            self.caller_dropped += 1
            self.later(CALLER_REDIAL_S, "звонок заявителю", self._call_caller)

    async def _hold(self, talk: Talk) -> None:
        """Линия бригады — на удержание (окно телефона, `phone/hold.ts`): отметка `call_hold` в
        журнал (HQ-033), разговор бригады на сервере не кончается, бригада молчит."""
        if talk.answered_at is not None:
            await self.event("call_hold", {"call_id": talk.id})
        self.held = talk
        self.talk = None
        self.queue.clear()
        self.playing = None
        # «Как приняли?» без ответа удержание не снимает: бригада ждёт «Принял» и после него.
        self.tr.add(Line(self.t, "call", "", f"{talk.label}: на удержании"))

    async def _back_after_failed_dial(self) -> None:
        """Набор не прошёл (сервер отказал), а бригада на удержании — диспетчер снова к ней:
        снимает с удержания, отложенные ответы идут после её фразы (`_resume`)."""
        if self.held is not None and self.talk is None:
            self.tr.add(Line(self.t, "call", "", "набор не прошёл — снова к бригаде"))
            await self._resume()

    async def _resume(self) -> float:
        """Снять бригаду с удержания: старший снова на связи (`resumedPhrase`), отметка
        `call_resume` в журнал (HQ-033); ждал ответа на вопрос с вариантами — повторяет его
        (HQ-058), ждал «Принял» — переспрашивает «Как приняли?», а не говорит поверх своего
        вопроса. Возвращает, сколько звучит его фраза."""
        talk, self.held = self.held, None
        assert talk is not None
        if talk.answered_at is not None:
            await self.event("call_resume", {"call_id": talk.id})
        self.talk = talk
        talk.answered_at = self.t
        self.last_sound = self.t
        self.tr.add(Line(self.t, "call", "", f"{talk.label}: снят с удержания"))
        waiting = talk.id in self.asked
        question = self._open_question()
        self.repeated = None
        dropped: str | None = None
        if question is not None:
            delivery = question["delivery"]
            reply_by = self.sim(delivery.get("reply_by"))
            if reply_by is not None and self.t >= reply_by:
                # Срок вопроса истёк на удержании (событие уже пропущено) — бригада его не
                # повторяет: «на связи» и новость; ответа на непрозвучавший вопрос нет
                # (incoming.ts `resumedSay`, `dropped`).
                dropped = delivery["delivery_id"]
                question = None
            else:
                # В сроке — повторяет и придерживает новость до ответа или срока (`_holds_news`).
                self.repeated = (talk.id, delivery["delivery_id"], reply_by)
        if dropped is not None:
            self.replied.add(dropped)
            self.on_resume = [item for item in self.on_resume if item[2] != dropped]
        text = question["delivery"]["message"]["text"] if question is not None else None
        back = phone.resumed_phrase(self.service, waiting_confirm=waiting, question=text)
        key = (
            QUESTION_REPEAT if question is not None else "confirm_request" if waiting else "answer"
        )
        self.queue.append((self.brigade_name, back, "client", key))
        seconds = phone.speech_seconds(back)
        # Ответы, отложенные на удержании, — когда бригада договорит повтор.
        for what, action, _ in self.on_resume:
            self.later(seconds + HANGUP_REACTION_S, what, action)
        self.on_resume.clear()
        return seconds

    async def _tell_pending(self) -> None:
        """Сказать бригаде, что служба едет: в идущем разговоре с ней (она могла позвонить,
        пока диспетчер говорил со службой) или перезвонив."""
        said = self.tell_brigade
        if said is None or self.state in TERMINAL:
            return
        talk = self.talk
        if talk is not None and talk.kind == "brigade" and talk.answered_at is not None:
            self.tell_brigade = None
            await self._say_to_brigade(said)
        elif talk is None:
            await self._dial_brigade("служба едет")
        else:
            self.later(1.0, "сказать бригаде, что служба едет", self._tell_pending)


def service_name(service: str) -> str:
    """Название службы в справочнике (ЖКХ, Мослифт) — им диспетчер представляется заявителю."""
    names = {
        str(item["id"]): str(item["name"])
        for item in json.loads(PHONEBOOK.read_text(encoding="utf-8"))
    }
    return names.get(service, service)


def _first_ext(event: dict[str, Any]) -> str:
    for expect in event["expect"]:
        if expect["action"] == "call_service":
            exts = [str(ext) for ext in expect["phone_exts"]]
            return next((ext for ext in exts if ext != "112"), exts[0])
    return "112"


_TOLD_WORDS = {
    "103": "Скорую уже вызвал, едет.",
    "101": "Пожарных уже вызвал, выехали.",
    "102": "Полицию уже вызвал, наряд едет.",
    "104": "Газовую службу уже вызвал, едут.",
    "GKH": "Аварийку уже вызвал, едут.",
    "MOSLIFT": "Механика Мослифта уже вызвал, едет.",
}


def _told_phrase(event: dict[str, Any], policy: Policy | None = None) -> str:
    if policy is not None and policy.told_text is not None:
        return policy.told_text
    ext = _first_ext(event)
    return _TOLD_WORDS.get(phone_services().get(ext, ext), "Службу уже вызвал, едут.")


_RANK = {"added": 0, "received": 0, "accepted": 1, "responding": 2, "arrived": 3, "working": 4}


def _fix_phrase(delivery: dict[str, Any], key: str, template: str) -> str:
    """Верный адрес фразой из варианта «Поправка по адресу: …» — без самих этих слов."""
    label = next((o["label"] for o in delivery.get("reply_options", []) if o["key"] == key), key)
    return template.format(address=label.split(":", 1)[-1].strip())


def _reached(current: str, wanted: str) -> bool:
    if current in TERMINAL:
        return True
    return _RANK.get(current, 0) >= _RANK.get(wanted, 9)


def run_copy(data: dict[str, Any]) -> dict[str, Any]:
    return copy.deepcopy(data)
