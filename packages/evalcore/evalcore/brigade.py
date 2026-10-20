"""Работа с бригадой (DT-10, «живая бригада»): исход события сценария и критерий brigade_work.

Событие сценария (`TrainingPlan.events`, contracts/scenario-events.md) — то, что мир сообщает
обучаемому помимо планового доклада, и то, чего мир после этого ждёт (`expect`). Одна и та же
функция `resolve_event` решает, чем кончилось событие, и для мира (worker выбирает ветку и
следующую реплику бригады), и для разбора (критерий `brigade_work`): так ход занятия и оценка
не расходятся.

Правила исхода одного ожидания (`expect[]`), срок — `fired_at + within_s`:

- `reply` — первый ответ бригаде вариантом (`brigade_reply`) после срабатывания: нужный
  вариант (`option_key`) в срок — `met`, позже — `late`, другой вариант — `wrong`;
- `answer_call` — реплика события предъявлена (ответили на вызов бригады): в срок — `met`;
- `call_service` — исходящий звонок без отказа на один из номеров `phone_exts` (скорую
  вызывают через 103 или 112 — засчитываются оба) после срабатывания, по набору номера;
- `call_brigade` — исходящий звонок бригаде события после срабатывания, по ответу бригады;
- `correct_readback` — поправить расчёт, который повторил адрес с ошибкой: нужный вариант
  (`option_key`, «Поправка по адресу: …») в том же разговоре, фраза бригаде с верным адресом
  (`said`: «Каширское шоссе, двадцать шесть» — правило `voice_reply.names_address`, HQ-024)
  или звонок бригаде, пока она в пути (до срока). Считается первое такое действие в срок —
  `met`; действие после срока не считается: расчёт уже приехал не туда. Другой вариант
  («Понял») без поправки до срока — `wrong`, исход решается на сроке: звонок в пути ещё
  успевает поправить;
- у звонка в службу и звонка бригаде срок сдвигается на `spoken_s` — сколько реплика события
  шла до диспетчера, когда он уже был на линии (представление старшего во входящем вызове,
  пауза, сама просьба); сколько вызов бригады звонил без ответа — время диспетчера;
- нет действия к сроку — `missed`; если реплику события так и не предъявили (на вызов не
  ответили), а ждали не ответа на вызов, — `unheard`: событие ничего не требовало, балл не
  снижается (как у плановых докладов, L-01); для мира это всё равно пропуск.

Служба вызвана заранее (GP-28, только `request_service` из одних ожиданий `call_service`):
звонок без отказа на номер ожидания по этой карточке после «Принята» и до срабатывания —
это не пропуск, а лучший ход. Сказал ли диспетчер бригаде, что служба едет, — по правилу
`evalcore.service_told.says_service_called` (сказанное бригаде события: `said`, вводная,
ответ голосом; до просьбы — со словом службы, после — хватает «уже вызвал, едут»):

- вызвал и сказал до просьбы (после набора номера службы: раньше «вызвал» — неправда, как у
  вести по просьбе) — бригада не просит (реплика события не звучит), ветка `met`
  в момент срабатывания, ожидание `ahead` (балл 1): «служба вызвана заранее и бригада
  предупреждена»;
- вызвал, но не сказал — бригада просит; ответ «уже вызвал» (вариант `already` или фраза)
  в срок — ветка `already`, ожидание `ahead` (балл 1); новый звонок в службу в срок — `met`,
  как обычно; ни того ни другого к сроку — служба приезжает сама, ветка `surprise` на сроке,
  ожидание `untold` (балл `BRIGADE_UNTOLD_SCORE`, замечание «не сообщили бригаде»);
- не вызвал — правила выше (`met`/`late`/`missed`); сказал «вызвал», а звонка не было, —
  в разборе это видно.

Служба вызвана по просьбе бригады (ветки `met`/`late` с ожиданием `call_service`, HQ-055):
бригада сама не перезванивает ради «Понял» — о службе ей сообщает диспетчер, перезвонив или
вернувшись с удержания («уже едет», «отправил»; то же правило `says_service_called`, что у
ответа «уже вызвал»). Сказал до приезда службы (`SERVICE_ARRIVAL_S` после отбоя звонка в
неё; не раньше набора её номера) — `news` `told`, нет — `untold`: мир говорит реплику ветки
`surprise`, разбор пишет замечание, балл события — не выше `BRIGADE_UNTOLD_SCORE`, как
за непредупреждённую бригаду при вызове заранее: меньшее из балла ожиданий и
`BRIGADE_UNTOLD_SCORE` (поздний звонок и несообщённая весть — 0,5, а не 0,5 × 0,9: одна
ошибка не наказывается дважды, лист решений 18.10).

Ветка события — по худшему ожиданию: есть `wrong` → `wrong`; есть `missed`/`unheard` → `missed`;
есть `late` → `late`; иначе `met`. Пока хоть одно ожидание в сроке и не выполнено, ветки нет.
Ветка `missed` сменится на `late`, если действие сделано после срока: мир отвечает и на позднюю
реакцию.

Балл ожидания: `met` — 1, `late` — `LATE_SCORE`, `wrong` и `missed` — 0, `unheard` не
считается. Балл события — среднее его ожиданий с весами `expect.weight` (по умолчанию 1);
балл критерия — среднее событий. Страховочные реплики мира (событие с `trigger.on = "event"`)
показываются в разборе, но не оцениваются отдельно: их последствие уже в исходе события, за
которым они пришли. Исключение — обязательная цепочка передачи, явно заданная
`awaits_call.relay_event`: её ожидания оцениваются самостоятельно.
Критическая ошибка — по двум правилам:

- событие с `review.critical`, на которое не было верной реакции: все ожидания `missed`,
  `unheard` или `wrong`, и хоть одно услышано (11.10 — неисправленный повтор адреса);
- ожидание с `critical: true`, которое не выполнили ни в срок, ни позже — `missed`, `wrong`
  или `unheard`: не ответить на вызов — не оправдание (решение 15.10 — тревога: скорая к
  бойцу; ответ на вызов без скорой — 0,1 события, `weight`).
"""

from collections.abc import Sequence
from collections.abc import Set as AbstractSet
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from math import isfinite
from typing import Literal, cast

from evalcore import remarks
from evalcore.criteria import _criterion_weight
from evalcore.defaults import (
    AHEAD_BRANCHES,
    BRIGADE_LATE_SCORE,
    BRIGADE_UNTOLD_SCORE,
    SERVICE_ARRIVAL_S,
)
from evalcore.loudness import LOUDNESS_TEXT
from evalcore.models import CriterionResult, EvalContext, Json, Remark
from evalcore.service_told import ALREADY_OPTION, reply_says_service_called, says_service_called
from evalcore.voice_reply import names_address

# `ahead` — служба вызвана заранее и бригаде сказано, `untold` — вызвана, но не сказано (GP-28).
ExpectationState = Literal[
    "met", "late", "wrong", "missed", "unheard", "pending", "ahead", "untold"
]
Branch = Literal["met", "wrong", "late", "missed", "already", "surprise"]
# Как служба оказалась вызвана заранее (GP-28): бригаду предупредили до просьбы (`told`),
# после просьбы (`told_after`) или не предупредили (`untold`).
Ahead = Literal["told", "told_after", "untold"]

# Сначала худшее: по нему выбирается ветка события.
_BRANCH_ORDER: tuple[Branch, ...] = ("wrong", "missed", "late", "met")
_SCORES = {
    "met": 1.0,
    "late": BRIGADE_LATE_SCORE,
    "wrong": 0.0,
    "missed": 0.0,
    "ahead": 1.0,
    "untold": BRIGADE_UNTOLD_SCORE,
}
# Сообщил ли диспетчер бригаде о службе, вызванной по её просьбе (HQ-055): до приезда службы
# (`told`) или нет (`untold`).
News = Literal["told", "untold"]


@dataclass(frozen=True)
class ExpectationOutcome:
    """Исход одного ожидания: что сделали, когда и через сколько после срабатывания."""

    action: str
    state: ExpectationState
    # Момент действия; для пропуска — срок.
    at: datetime | None
    reaction_s: float | None
    # Чем подтверждено: ключ варианта ответа или набранный номер.
    detail: str | None


@dataclass(frozen=True)
class EventOutcome:
    """Ветка события на момент `now` (None — ещё ждём) и исходы ожиданий."""

    branch: Branch | None
    at: datetime | None
    expectations: tuple[ExpectationOutcome, ...]
    # Служба вызвана заранее (GP-28); None — не вызвана, правила обычные.
    ahead: Ahead | None = None
    # Не вызвали, а бригаде сказали «вызвал» (GP-28) — для разбора.
    claimed: bool = False
    # Служба вызвана по просьбе бригады (ветки met/late, HQ-055): сообщили ли бригаде, что
    # служба едет; None — правило не применялось или служба в пути и ещё не сказали.
    news: News | None = None
    # `told` — когда сказали, `untold` — когда служба приехала.
    news_at: datetime | None = None
    # Срок сообщить: приезд службы (`_with_news`); None — звонок в службу ещё идёт.
    news_by: datetime | None = None

    @property
    def silent(self) -> bool:
        """Бригада не просит: служба вызвана заранее и её предупредили (реплика не звучит)."""
        return self.ahead == "told"

    @property
    def fixed_by_phrase(self) -> bool:
        """Поправку засчитали фразой бригаде (`said`, HQ-024): на неё бригада отвечает репликой
        ветки («Понял, …, едем»), окно телефона своего «Принял» не даёт — один ответ."""
        return self.branch == "met" and any(
            item.action == "correct_readback" and item.detail == "said"
            for item in self.expectations
        )


def parse_time(value: Json | None, field: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"{field} должен быть строкой в формате date-time")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"{field} должен содержать часовой пояс")
    return parsed


def _optional_time(value: Json | None, field: str) -> datetime | None:
    return None if value is None else parse_time(value, field)


def _dict(value: Json | None, field: str) -> dict[str, Json]:
    if not isinstance(value, dict):
        raise ValueError(f"{field} должен быть объектом")
    return value


def _list(value: Json | None, field: str) -> list[Json]:
    if not isinstance(value, list):
        raise ValueError(f"{field} должен быть массивом")
    return value


def _seconds(value: Json | None, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} должен быть числом")
    result = float(value)
    if not isfinite(result) or result < 0:
        raise ValueError(f"{field} должен быть неотрицательным числом")
    return result


def _first_action(
    expect: dict[str, Json],
    event: dict[str, Json],
    fired_at: datetime,
    presented_at: datetime | None,
    replies: Sequence[dict[str, Json]],
    calls: Sequence[dict[str, Json]],
) -> tuple[datetime, str | None, bool] | None:
    """Первое действие обучаемого по ожиданию: (когда, чем, верно ли) или None."""
    action = expect.get("action")
    if action == "answer_call":
        if presented_at is None:
            return None
        return max(presented_at, fired_at), None, True
    if action == "reply":
        answers = sorted(
            (
                (parse_time(reply.get("at"), "replies[].at"), reply.get("option_key"))
                for reply in replies
            ),
            key=lambda item: item[0],
        )
        for at, key in answers:
            if at >= fired_at:
                return at, str(key), key == expect.get("option_key")
        return None
    if action == "call_service":
        exts = {str(ext) for ext in _list(expect.get("phone_exts"), "expect.phone_exts")}
        started = sorted(
            (parse_time(call.get("started_at"), "calls[].started_at"), str(call.get("phone_ext")))
            for call in calls
            if call.get("direction", "outbound") == "outbound"
            and call.get("refusal") is None
            and str(call.get("phone_ext")) in exts
        )
        return next(((at, ext, True) for at, ext in started if at >= fired_at), None)
    if action == "call_brigade":
        answered = sorted(
            parse_time(call.get("answered_at"), "calls[].answered_at")
            for call in calls
            if call.get("direction", "outbound") == "outbound"
            and call.get("refusal") is None
            and call.get("brigade_id") == event.get("brigade_id")
            and call.get("answered_at") is not None
        )
        return next(((at, None, True) for at in answered if at >= fired_at), None)
    raise ValueError(f"Неизвестное ожидание события: {action}")


def _correction(
    expect: dict[str, Json],
    event: dict[str, Json],
    fired_at: datetime,
    deadline: datetime,
    presented_at: datetime | None,
    replies: Sequence[dict[str, Json]],
    calls: Sequence[dict[str, Json]],
    now: datetime | None,
    said: Sequence[dict[str, Json]] = (),
) -> ExpectationOutcome:
    """`correct_readback`: поправили ли расчёт, пока он в пути (до срока).

    Поправка — нужный вариант ответа, фраза бригаде в разговоре с верным адресом (`said`,
    после «Понял» или без вопроса: «Нет, Каширское шоссе, 26»; вводная `via: "briefing"` —
    не поправка) или отвеченный звонок бригаде. «Понял» ещё
    не ошибка: до срока диспетчер может поправить; на сроке он становится `wrong`.
    """
    action = "correct_readback"
    options = sorted(
        (parse_time(reply.get("at"), "replies[].at"), str(reply.get("option_key")))
        for reply in replies
    )
    fixes = [(at, key) for at, key in options if key == expect.get("option_key")]
    fixes += [
        (parse_time(call.get("answered_at"), "calls[].answered_at"), "call")
        for call in calls
        if call.get("direction", "outbound") == "outbound"
        and call.get("refusal") is None
        and call.get("brigade_id") == event.get("brigade_id")
        and call.get("answered_at") is not None
    ]
    label = _option_label(event, str(expect.get("option_key")))
    line = event.get("line")
    question = line.get("text") if isinstance(line, dict) else None
    fixes += [
        (parse_time(item.get("at"), "said[].at"), "said")
        for item in said
        if item.get("via") != "briefing"
        and isinstance(text := item.get("text"), str)
        and names_address(label, text, question if isinstance(question, str) else "")
    ]
    horizon = deadline if now is None else min(deadline, now)
    fix = min(((at, how) for at, how in fixes if fired_at <= at <= horizon), default=None)
    if fix is not None:
        return ExpectationOutcome(
            action, "met", fix[0], (fix[0] - fired_at).total_seconds(), fix[1]
        )
    if now is not None and now < deadline:
        return ExpectationOutcome(action, "pending", None, None, None)
    wrong = next((key for at, key in options if fired_at <= at <= deadline), None)
    if wrong is not None:
        return ExpectationOutcome(action, "wrong", deadline, None, wrong)
    state: ExpectationState = "unheard" if presented_at is None else "missed"
    return ExpectationOutcome(action, state, deadline, None, None)


# Действия-ответы на реплику бригады: их срок идёт от того, как реплику услышали.
_HEARD_FIRST = ("reply", "correct_readback")
# Звонки по просьбе бригады: срок — от срабатывания плюс время, пока реплика шла до диспетчера.
_SPOKEN_FIRST = ("call_service", "call_brigade")


def expectation_deadline(
    expect: dict[str, Json],
    fired_at: datetime,
    presented_at: datetime | None,
    spoken_s: float = 0.0,
) -> datetime:
    """Срок ожидания (`resolve_expectation`); его же видит окно телефона у вопроса бригады
    (`delivery.reply_by`, HQ-058)."""
    action = str(expect.get("action"))
    # Ответить на вопрос бригады или поправить её повтор можно, только услышав реплику: срок
    # ответа — от того, как её услышали. Бригада перезванивает не сразу, и её вызов не съедает
    # срок (проверка 17.10: «уточнил — а они уже приехали не туда»). Сколько ждали ответа на
    # сам вызов, оценивает ожидание `answer_call`.
    if action in _HEARD_FIRST and presented_at is not None and presented_at > fired_at:
        start = presented_at
    elif action in _SPOKEN_FIRST and presented_at is not None:
        # Просьба позвонить в службу или бригаде: срок — от срабатывания, но время, пока
        # реплика доходила до диспетчера на линии, система у него не отнимает (проверка 17.10:
        # перезвон, «старший на связи», сама просьба съедали четверть срока).
        start = fired_at + timedelta(seconds=max(0.0, spoken_s))
    else:
        start = fired_at
    return start + timedelta(seconds=_seconds(expect.get("within_s"), "expect.within_s"))


def resolve_expectation(
    expect: dict[str, Json],
    event: dict[str, Json],
    fired_at: datetime,
    presented_at: datetime | None,
    replies: Sequence[dict[str, Json]],
    calls: Sequence[dict[str, Json]],
    now: datetime | None,
    spoken_s: float = 0.0,
    said: Sequence[dict[str, Json]] = (),
) -> ExpectationOutcome:
    """Исход ожидания к моменту `now`; `now=None` — занятие кончилось, ждать больше нечего.

    `spoken_s` — сколько реплика события шла до диспетчера, когда он уже был на линии
    (представление старшего, пауза, сама реплика): у звонка в службу и звонка бригаде срок
    сдвигается на это время. Сколько вызов бригады звонил без ответа — время диспетчера.
    """
    action = str(expect.get("action"))
    deadline = expectation_deadline(expect, fired_at, presented_at, spoken_s)
    if action == "correct_readback":
        return _correction(
            expect, event, fired_at, deadline, presented_at, replies, calls, now, said
        )
    found = _first_action(expect, event, fired_at, presented_at, replies, calls)
    if found is not None and (now is None or found[0] <= now):
        at, detail, right = found
        reaction = (at - fired_at).total_seconds()
        state: ExpectationState = "wrong" if not right else "met" if at <= deadline else "late"
        return ExpectationOutcome(action, state, at, reaction, detail)
    if now is not None and now < deadline:
        return ExpectationOutcome(action, "pending", None, None, None)
    unheard = presented_at is None and action != "answer_call"
    return ExpectationOutcome(action, "unheard" if unheard else "missed", deadline, None, None)


def _service_exts(event: dict[str, Json]) -> list[str] | None:
    """Номера службы, о которой просит бригада; None — правило «вызвана заранее» не про это
    событие (не `request_service` или ждут не только звонка в службу)."""
    if event.get("kind") != "request_service":
        return None
    expects = [_dict(item, "event.expect[]") for item in _list(event.get("expect"), "event.expect")]
    if not expects or any(expect.get("action") != "call_service" for expect in expects):
        return None
    return [
        str(ext)
        for expect in expects
        for ext in _list(expect.get("phone_exts"), "expect.phone_exts")
    ]


def _service_calls(
    calls: Sequence[dict[str, Json]], exts: Sequence[str]
) -> list[tuple[datetime, str]]:
    """Звонки в службу по набору номера (исходящие, без отказа), по времени."""
    return sorted(
        (parse_time(call.get("started_at"), "calls[].started_at"), str(call.get("phone_ext")))
        for call in calls
        if call.get("direction", "outbound") == "outbound"
        and call.get("refusal") is None
        and str(call.get("phone_ext")) in exts
    )


def _told_after(
    exts: Sequence[str],
    fired_at: datetime,
    replies: Sequence[dict[str, Json]],
    said: Sequence[dict[str, Json]],
) -> datetime | None:
    """Первый момент после просьбы, когда бригаде сказали «уже вызвал, едут»."""
    moments = [
        at
        for reply in replies
        if (at := parse_time(reply.get("at"), "replies[].at")) >= fired_at
        and reply_says_service_called(reply, exts)
    ]
    moments += [
        at
        for item in said
        if (at := parse_time(item.get("at"), "said[].at")) >= fired_at
        and says_service_called(str(item.get("text") or ""), exts, named=False)
    ]
    return min(moments, default=None)


def _ahead_call(
    exts: Sequence[str],
    calls: Sequence[dict[str, Json]],
    fired_at: datetime,
    accepted_at: datetime | None,
) -> tuple[datetime, str] | None:
    """Звонок в службу заранее (GP-28): первый по карточке после «Принята» и до просьбы."""
    return next(
        (
            (at, ext)
            for at, ext in _service_calls(calls, exts)
            if at < fired_at and (accepted_at is None or at >= accepted_at)
        ),
        None,
    )


def _ahead_deadline(event: dict[str, Json], fired_at: datetime, spoken_s: float) -> datetime:
    """Срок ответа на просьбу о службе, вызванной заранее: к нему служба приезжает сама."""
    return fired_at + timedelta(
        seconds=max(0.0, spoken_s)
        + max(
            _seconds(_dict(item, "event.expect[]").get("within_s"), "expect.within_s")
            for item in _list(event.get("expect"), "event.expect")
        )
    )


def ahead_window(
    event: dict[str, Json],
    outcome: EventOutcome,
    fired_at: datetime,
    calls: Sequence[dict[str, Json]],
    accepted_at: datetime | None,
    spoken_s: float = 0.0,
) -> tuple[datetime, datetime] | None:
    """Окно вести о службе, вызванной заранее, когда бригада всё же попросила (GP-28).

    `(звонок, срок)`: с набора номера службы до её приезда — срока ответа на просьбу (ветка
    `surprise`). Сказанное в окне после просьбы — ответ «уже вызвал» (`told_after`). То же
    правило, что у вести по просьбе (`news_window`): весть — только после набора номера.
    None — служба не вызвана заранее, бригаду предупредили до просьбы (она не просит) или
    после просьбы позвонили в службу ещё раз (тогда окно — `news_window`).
    """
    if outcome.ahead not in ("told_after", "untold"):
        return None
    exts = _service_exts(event)
    called = _ahead_call(exts, calls, fired_at, accepted_at) if exts is not None else None
    if called is None:
        return None
    return called[0], _ahead_deadline(event, fired_at, spoken_s)


def _ahead_outcome(
    event: dict[str, Json],
    exts: Sequence[str],
    called: tuple[datetime, str],
    fired_at: datetime,
    replies: Sequence[dict[str, Json]],
    calls: Sequence[dict[str, Json]],
    said: Sequence[dict[str, Json]],
    now: datetime | None,
    spoken_s: float = 0.0,
) -> EventOutcome:
    """Исход просьбы о службе, которую уже вызвали (правила — в docstring модуля)."""
    called_at, ext = called
    expects = _list(event.get("expect"), "event.expect")

    def each(
        state: ExpectationState, at: datetime | None, reaction: float | None
    ) -> tuple[ExpectationOutcome, ...]:
        return tuple(ExpectationOutcome("call_service", state, at, reaction, ext) for _ in expects)

    # Весть до просьбы — только после набора номера службы (то же окно, что у вести по
    # просьбе, HQ-055): «скорую вызвал» до звонка — неправда, бригада всё равно попросит.
    told_before = any(
        called_at <= parse_time(item.get("at"), "said[].at") < fired_at
        and says_service_called(str(item.get("text") or ""), exts, named=True)
        for item in said
    )
    if told_before:
        return EventOutcome("met", fired_at, each("ahead", called_at, None), "told")
    deadline = _ahead_deadline(event, fired_at, spoken_s)
    horizon = deadline if now is None else min(deadline, now)
    told = _told_after(exts, fired_at, replies, said)
    again = next((at for at, _ in _service_calls(calls, exts) if at >= fired_at), None)
    if told is not None and told <= horizon and (again is None or told <= again):
        reaction = (told - fired_at).total_seconds()
        return EventOutcome("already", told, each("ahead", told, reaction), "told_after")
    if again is not None and again <= horizon:
        # Позвонили в службу ещё раз после просьбы — как обычно: бригада слышит «вызвали».
        reaction = (again - fired_at).total_seconds()
        outcomes = tuple(
            ExpectationOutcome("call_service", "met", again, reaction, ext) for _ in expects
        )
        return EventOutcome("met", again, outcomes)
    if now is not None and now < deadline:
        return EventOutcome(None, None, each("pending", None, None), "untold")
    return EventOutcome("surprise", deadline, each("untold", deadline, None), "untold")


def resolve_event(
    event: dict[str, Json],
    fired_at: datetime,
    presented_at: datetime | None,
    replies: Sequence[dict[str, Json]],
    calls: Sequence[dict[str, Json]],
    now: datetime | None = None,
    said: Sequence[dict[str, Json]] = (),
    accepted_at: datetime | None = None,
    spoken_s: float = 0.0,
) -> EventOutcome:
    """Ветка события (по худшему ожиданию) и момент, с которого она действует.

    `presented_at` — первое предъявление реплики события (`message_presented`); у события
    без реплики (молчание бригады) его нет, и пропуск по нему не считается «не услышали».
    `said` — что диспетчер сказал бригаде события (`{at, text}`: фразы разговора и вводные),
    `accepted_at` — «Принята» карточки; оба нужны правилу «служба вызвана заранее» (GP-28).
    `spoken_s` — сколько реплика шла до диспетчера на линии (`resolve_expectation`).
    """
    exts = _service_exts(event)
    if exts is not None:
        called = _ahead_call(exts, calls, fired_at, accepted_at)
        if called is not None:
            return _with_news(
                event,
                _ahead_outcome(event, exts, called, fired_at, replies, calls, said, now, spoken_s),
                fired_at,
                replies,
                calls,
                said,
                now,
            )
    expects = [_dict(item, "event.expect[]") for item in _list(event.get("expect"), "event.expect")]
    heard = presented_at if event.get("line") is not None else fired_at
    outcomes = tuple(
        resolve_expectation(expect, event, fired_at, heard, replies, calls, now, spoken_s, said)
        for expect in expects
    )
    if not outcomes or any(item.state == "pending" for item in outcomes):
        return EventOutcome(None, None, outcomes)
    states = {"missed" if item.state == "unheard" else item.state for item in outcomes}
    branch = next(branch for branch in _BRANCH_ORDER if branch in states)
    at = max(item.at for item in outcomes if item.at is not None)
    claimed = (
        exts is not None
        and branch == "missed"
        and _told_after(exts, fired_at, replies, said) is not None
    )
    return _with_news(
        event,
        EventOutcome(branch, at, outcomes, claimed=claimed),
        fired_at,
        replies,
        calls,
        said,
        now,
    )


def service_called_at(outcome: EventOutcome) -> datetime | None:
    """Когда по просьбе бригады позвонили в службу (ветки met/late); None — не звонили или
    служба вызвана заранее и бригада предупреждена (просьбы не было)."""
    if outcome.branch not in ("met", "late") or outcome.ahead == "told":
        return None
    return min(
        (
            item.at
            for item in outcome.expectations
            if item.action == "call_service" and item.state in ("met", "late") and item.at
        ),
        default=None,
    )


def _call_service_exts(event: dict[str, Json]) -> list[str]:
    """Номера ожиданий `call_service` события (любого вида: просьба, тревога)."""
    return [
        str(ext)
        for raw in _list(event.get("expect"), "event.expect")
        if (expect := _dict(raw, "event.expect[]")).get("action") == "call_service"
        for ext in _list(expect.get("phone_exts"), "expect.phone_exts")
    ]


def news_window(
    event: dict[str, Json], outcome: EventOutcome, calls: Sequence[dict[str, Json]]
) -> tuple[datetime, datetime | None] | None:
    """Когда весть о службе, вызванной по просьбе бригады, засчитывается (HQ-055).

    `(звонок, срок)`: с набора номера службы (раньше — служба ещё не вызвана, «уже вызвал»
    неправда) до её приезда — `SERVICE_ARRIVAL_S` после отбоя звонка в неё, но не раньше чем
    через столько же после набора. Срок None — звонок в службу ещё идёт. None — по просьбе
    в службу не звонили (`service_called_at`). То же окно у окна телефона
    (`delivery.service_called_at`, `delivery.news_by`).
    """
    called = service_called_at(outcome)
    if called is None:
        return None
    exts = _call_service_exts(event)
    call = next(
        (
            item
            for item in calls
            if item.get("direction", "outbound") == "outbound"
            and item.get("refusal") is None
            and str(item.get("phone_ext")) in exts
            and parse_time(item.get("started_at"), "calls[].started_at") == called
        ),
        None,
    )
    ended = _optional_time((call or {}).get("ended_at"), "calls[].ended_at")
    if ended is None:
        return called, None
    return called, max(called, ended) + timedelta(seconds=SERVICE_ARRIVAL_S)


def _with_news(
    event: dict[str, Json],
    outcome: EventOutcome,
    fired_at: datetime,
    replies: Sequence[dict[str, Json]],
    calls: Sequence[dict[str, Json]],
    said: Sequence[dict[str, Json]],
    now: datetime | None,
) -> EventOutcome:
    """Сообщил ли диспетчер бригаде, что вызванная по её просьбе служба едет (HQ-055).

    Бригада сама не перезванивает ради «Понял»: о службе ей сообщает диспетчер — перезвонив
    или вернувшись с удержания («уже едет», «отправил»; правило `says_service_called` после
    просьбы, как у ответа «уже вызвал»). Засчитывается сказанное в окне `news_window`: не
    раньше набора номера службы и не позже её приезда. Сказал в окне — `told`; нет —
    `untold`: служба приезжает для бригады неожиданно. Пока звонок в службу идёт и бригаде
    не сказали, исхода нет.
    """
    window = news_window(event, outcome, calls)
    if window is None:
        return outcome
    called, deadline = window
    if deadline is None and now is None:
        deadline = called + timedelta(seconds=SERVICE_ARRIVAL_S)
    told = _told_after(_call_service_exts(event), max(fired_at, called), replies, said)
    if told is not None and (deadline is None or told <= deadline) and (now is None or told <= now):
        return replace(outcome, news="told", news_at=told, news_by=deadline)
    if deadline is None or (now is not None and now < deadline):
        return replace(outcome, news_by=deadline)
    return replace(outcome, news="untold", news_at=deadline, news_by=deadline)


def _weight(expect: dict[str, Json]) -> float:
    value = expect.get("weight", 1)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("expect.weight должен быть числом")
    result = float(value)
    if not isfinite(result) or result <= 0:
        raise ValueError("expect.weight должен быть положительным числом")
    return result


def event_score(outcome: EventOutcome, event: dict[str, Json]) -> float | None:
    """Среднее по ожиданиям с весами `expect.weight`; None — оценивать нечего (не услышали)."""
    expects = [_dict(item, "event.expect[]") for item in _list(event.get("expect"), "event.expect")]
    scored = [
        (_SCORES[item.state], _weight(expect))
        for item, expect in zip(outcome.expectations, expects, strict=True)
        if item.state in _SCORES
    ]
    total = sum(weight for _, weight in scored)
    if not scored:
        return None
    value = sum(score * weight for score, weight in scored) / total
    # Службу вызвали по просьбе, а бригаде не сообщили (HQ-055) — балл не выше, чем за
    # непредупреждённую бригаду при вызове заранее (GP-28, `untold`). Меньшее из двух, а не
    # произведение: поздний звонок уже снизил балл, одна ошибка не наказывается дважды.
    return min(value, BRIGADE_UNTOLD_SCORE) if outcome.news == "untold" else value


def no_reaction(outcome: EventOutcome) -> bool:
    """Верной реакции не было: все ожидания пропущены или ошибочны, и реплику услышали.

    Для тревоги это «без реакции» (ошибочного ответа у неё нет), для повтора адреса —
    «не поправили». Событие, которое целиком не услышали, ничего не требовало.
    """
    states = {item.state for item in outcome.expectations}
    return bool(states) and states <= {"missed", "unheard", "wrong"} and states != {"unheard"}


def _mmss(seconds: float) -> str:
    total = int(round(seconds))
    return f"{total // 60}:{total % 60:02d}"


def _option_label(event: dict[str, Json], key: str | None) -> str:
    options = event.get("reply_options")
    for option in options if isinstance(options, list) else []:
        if isinstance(option, dict) and option.get("key") == key:
            return str(option.get("label"))
    return str(key)


def _expectation_text(
    item: ExpectationOutcome,
    expect: dict[str, Json],
    event: dict[str, Json],
    how: str = "",
) -> str:
    """Что сделал диспетчер по ожиданию — по-русски, для разбора.

    `how` — как дан ответ вариантом: «голосом» или «вариантом» (DT-16); пусто — не важно.
    """
    by = f" {how}" if how else ""
    within = _mmss(_seconds(expect.get("within_s"), "expect.within_s"))
    late = f", позже срока {within}" if item.state == "late" else ""
    took = f"через {_mmss(item.reaction_s)}{late}" if item.reaction_s is not None else ""
    if item.state == "unheard":
        return "реплику не услышали — на вызов бригады не ответили"
    if item.action == "correct_readback":
        if item.state == "met":
            fixed = (
                "позвонили расчёту и поправили"
                if item.detail == "call"
                else "поправили голосом"
                if item.detail == "said"
                else f"поправили{by}"
            )
            return f"{fixed} через {_mmss(item.reaction_s or 0)}"
        answered = (
            f"ответили{by} «{_option_label(event, item.detail)}», " if item.state == "wrong" else ""
        )
        return f"{answered}не поправили — расчёт приехал не туда"
    if item.action == "reply":
        if item.state == "missed":
            return "бригаде не ответили"
        label = _option_label(event, item.detail)
        verdict = " — неверно" if item.state == "wrong" else ""
        return f"ответили{by} «{label}» {took}{verdict}"
    if item.action == "answer_call":
        if item.state == "missed":
            return "на вызов не ответили"
        # Не взятая вовремя тревога слышна и в своём звонке бригаде — «ответили» было бы неправдой.
        return f"ответили на вызов {took}" if item.state == "met" else f"реплику услышали {took}"
    if item.action == "call_service":
        if item.state == "missed":
            exts = " или ".join(str(ext) for ext in _list(expect.get("phone_exts"), "phone_exts"))
            return f"в {exts} не позвонили"
        return f"позвонили в {item.detail} {took}"
    if item.state == "missed":
        return "бригаде не позвонили"
    return f"позвонили бригаде {took}"


# Тренажёр — для системы-112 Москвы: в разборе время по Москве, как на доске и в ленте
# вводных (UTC+3, без перехода на летнее время с 2014 г.; tzdata в образе не нужна).
MOSCOW = timezone(timedelta(hours=3), "MSK")


@dataclass(frozen=True)
class _ReplyHow:
    """Как дан ответ бригаде (DT-16): способ и замечания о голосе."""

    mode: str  # «голосом», «вариантом» или пусто — ответа вариантом не было
    notes: str  # « (громкость в норме, голос не сопоставлен: 1)» или пусто


def _reply_how(
    item: ExpectationOutcome, fired_at: datetime, replies: Sequence[dict[str, Json]]
) -> _ReplyHow:
    """Ответ — первый `brigade_reply` после срабатывания с ключом варианта ожидания.

    Нет поля `mode` (ответы до голосового ввода) — вариантом. Громкость и число
    несопоставленных фраз — как у доклада службе (`criteria._report_line`).
    """
    if item.action not in ("reply", "correct_readback") or item.detail in (None, "call", "said"):
        return _ReplyHow("", "")
    reply = next(
        (
            reply
            for reply in sorted(replies, key=lambda raw: str(raw.get("at")))
            if reply.get("option_key") == item.detail
            and parse_time(reply.get("at"), "replies[].at") >= fired_at
        ),
        None,
    )
    if reply is None:
        return _ReplyHow("", "")
    notes = []
    loudness = reply.get("loudness")
    if reply.get("mode") == "voice" and isinstance(loudness, str) and loudness in LOUDNESS_TEXT:
        notes.append(LOUDNESS_TEXT[loudness])
    failures = reply.get("voice_failures")
    if isinstance(failures, int) and not isinstance(failures, bool) and failures > 0:
        notes.append(f"голос не сопоставлен: {failures}")
    return _ReplyHow(
        "голосом" if reply.get("mode") == "voice" else "вариантом",
        f" ({', '.join(notes)})" if notes else "",
    )


def _clock(at: datetime) -> str:
    return at.astimezone(MOSCOW).strftime("%H:%M:%S")


@dataclass(frozen=True)
class FiredEvent:
    """Сработавшее событие карточки и его исход к концу занятия."""

    event: dict[str, Json]
    fired_at: datetime
    source: str
    outcome: EventOutcome
    # Ответы бригаде на реплику события: {at, option_key, mode?, loudness?, voice_failures?}.
    replies: tuple[dict[str, Json], ...] = ()

    # Обязательная передача в цепочке awaits_call.relay_event — не страховка мира.
    required_relay: bool = False

    @property
    def fallback(self) -> bool:
        """Страховочная реплика мира: пришла из-за пропуска другого события."""
        trigger = self.event.get("trigger")
        return (
            isinstance(trigger, dict) and trigger.get("on") == "event" and not self.required_relay
        )

    @property
    def critical(self) -> bool:
        review = self.event.get("review")
        flagged = isinstance(review, dict) and review.get("critical") is True
        expects = [_dict(item, "expect[]") for item in _list(self.event.get("expect"), "expect")]
        failed = any(
            expect.get("critical") is True and item.state in {"missed", "wrong", "unheard"}
            for item, expect in zip(self.outcome.expectations, expects, strict=True)
        )
        return failed or (flagged and no_reaction(self.outcome))

    def evidence(self) -> str:
        review = _dict(self.event.get("review"), "event.review")
        expects = [_dict(item, "expect[]") for item in _list(self.event.get("expect"), "expect")]
        texts = []
        for item, expect in zip(self.outcome.expectations, expects, strict=True):
            how = _reply_how(item, self.fired_at, self.replies)
            texts.append(_expectation_text(item, expect, self.event, how.mode) + how.notes)
        actions = "; ".join(texts)
        prefix = (
            f"Вводная преподавателя, {_clock(self.fired_at)}. "
            if self.source == "inject"
            else "Страховка мира. "
            if self.fallback
            else ""
        )
        ahead = self._ahead_text()
        if ahead is not None:
            return f"{prefix}{review.get('label')}{ahead}"
        if self.outcome.claimed:
            actions += "; бригаде сказали, что служба вызвана, но звонка в службу не было"
        actions += self._news_text()
        return f"{prefix}{review.get('label')}: {actions}."

    @property
    def news_untold(self) -> bool:
        """Службу вызвали по просьбе бригады, а бригаде не сказали, что она едет (HQ-055)."""
        return self.outcome.news == "untold"

    def _news_text(self) -> str:
        """Сообщили ли бригаде о вызванной по её просьбе службе (HQ-055); пусто — не звонили."""
        called = service_called_at(self.outcome)
        if called is None or self.outcome.news is None or self.outcome.news_at is None:
            return ""
        if self.outcome.news == "told":
            after = max(0.0, (self.outcome.news_at - called).total_seconds())
            return f"; сообщили бригаде, что служба едет, через {_mmss(after)} после звонка"
        return "; бригаде не сообщили, что служба едет, — служба приехала для неё неожиданно"

    @property
    def untold(self) -> bool:
        """Служба вызвана заранее, а бригаду так и не предупредили (GP-28) — замечание."""
        return self.outcome.ahead == "untold" and self.outcome.branch == "surprise"

    def _ahead_text(self) -> str | None:
        """Строка разбора «служба вызвана заранее» (GP-28); None — правило не применялось."""
        ahead = self.outcome.ahead
        item = self.outcome.expectations[0] if self.outcome.expectations else None
        if ahead is None or item is None or self.outcome.branch is None:
            return None
        called = f"позвонили в {item.detail} до просьбы бригады"
        if ahead == "told":
            return (
                " — не понадобилось: служба вызвана заранее и бригада предупреждена "
                f"({called}). Лучший исход."
            )
        if ahead == "told_after":
            # Ответ кнопкой «Уже вызвал, едут» — вариантом, остальное (фраза, голос) — голосом.
            option = next(
                (
                    reply
                    for reply in self.replies
                    if reply.get("option_key") == ALREADY_OPTION
                    and parse_time(reply.get("at"), "replies[].at") == item.at
                ),
                None,
            )
            how = "вариантом" if option is not None and option.get("mode") != "voice" else "голосом"
            return (
                f": служба вызвана заранее ({called}), на просьбу ответили {how}, что служба "
                f"уже едет, через {_mmss(item.reaction_s or 0)}."
            )
        return (
            f": служба вызвана заранее ({called}), но бригаде об этом не сказали — служба "
            "приехала для неё неожиданно. Замечание: не сообщил бригаде, что служба вызвана."
        )


def _required_relay(event: dict[str, Json], events: dict[str, dict[str, Json]]) -> bool:
    """Входит ли событие в явную relay-цепочку, до её конечного события включительно.

    Сам on:event (в том числе после late) не определяет обязанность. Нужен gate
    awaits_call.relay_event в ветке предка; события после конечной передачи остаются
    страховками. Отсутствующий предок или цикл не меняют legacy-поведение.
    """
    between: set[str] = set()
    current = event
    while isinstance(trigger := current.get("trigger"), dict) and trigger.get("on") == "event":
        parent_id = trigger.get("event_id")
        if not isinstance(parent_id, str) or parent_id in between:
            return False
        parent = events.get(parent_id)
        if parent is None:
            return False
        branch = trigger.get("branch")
        awaits = awaited_call(parent, cast(Branch, branch)) if isinstance(branch, str) else None
        terminal = awaits.get("relay_event") if awaits is not None else None
        if isinstance(terminal, str) and terminal and terminal not in between:
            return True
        between.add(parent_id)
        current = parent
    return False


def fired_events(ctx: EvalContext) -> list[FiredEvent]:
    """Сработавшие события карточки с исходом к концу занятия, в порядке срабатывания.

    Вход — `EvalContext.scenario_events`: `{event, fired_at, source, presented_at, replies}`
    (ответ — `{at, option_key}`, у ответа голосом ещё `mode`, `loudness`, `voice_failures`);
    необязательные `said` — сказанное бригаде события `[{at, text, via?}]` и `accepted_at` —
    «Принята» карточки (GP-28, «служба вызвана заранее»), `spoken_s` — сколько реплика шла
    до диспетчера на линии (`resolve_expectation`); звонки — `ctx.calls`.
    """
    result = []
    for index, raw in enumerate(ctx.scenario_events):
        field = f"scenario_events[{index}]"
        item = _dict(raw, field)
        event = _dict(item.get("event"), f"{field}.event")
        fired_at = parse_time(item.get("fired_at"), f"{field}.fired_at")
        presented_at = _optional_time(item.get("presented_at"), f"{field}.presented_at")
        replies = [_dict(reply, f"{field}.replies[]") for reply in _list(item.get("replies"), "")]
        said = [_dict(one, f"{field}.said[]") for one in _list(item.get("said", []), "")]
        accepted_at = _optional_time(item.get("accepted_at"), f"{field}.accepted_at")
        spoken = item.get("spoken_s", 0)
        spoken_s = 0.0 if spoken is None else _seconds(spoken, f"{field}.spoken_s")
        outcome = resolve_event(
            event, fired_at, presented_at, replies, ctx.calls, None, said, accepted_at, spoken_s
        )
        result.append(
            FiredEvent(event, fired_at, str(item.get("source", "plan")), outcome, tuple(replies))
        )
    events = {
        event_id: item.event for item in result if isinstance(event_id := item.event.get("id"), str)
    }
    return sorted(
        (replace(item, required_relay=_required_relay(item.event, events)) for item in result),
        key=lambda fired: fired.fired_at,
    )


# Что сказать в итоге разбора о критическом событии (по виду события).
_CRITICAL = {
    "alarm": "по тревоге бригады к бойцу не вызвали скорую",
    "readback_error": "расчёт повторил адрес с ошибкой, его не поправили — приехал не туда",
}


def data_problem(event: dict[str, Json]) -> str | None:
    """Вопрос к данным (TC-10): событие ждёт вариант ответа, которого у реплики нет.

    Файлы сценариев это проверяет загрузчик (seed/scenarios.py), но вводные преподавателя и
    планы, выданные раньше проверки, могут дойти до оценки и с такой ошибкой. Нет — None.
    """
    options = event.get("reply_options")
    keys = {
        option.get("key")
        for option in (options if isinstance(options, list) else [])
        if isinstance(option, dict)
    }
    for expect in _list(event.get("expect"), "event.expect"):
        if not isinstance(expect, dict) or expect.get("action") not in {
            "reply",
            "correct_readback",
        }:
            continue
        if expect.get("option_key") not in keys:
            review = event.get("review")
            name = review.get("label") if isinstance(review, dict) else event.get("kind")
            return f"{name}: среди вариантов ответа нет нужного «{expect.get('option_key')}»."
    return None


def _world(event: dict[str, Json], branch: Branch | None) -> str | None:
    """Последствие ветки в мире: ответ бригады, подменённый доклад и задержка докладов."""
    texts = []
    branches = event.get("branches")
    chosen = branches.get(branch) if isinstance(branches, dict) and branch else None
    said = chosen.get("line") if isinstance(chosen, dict) else None
    if isinstance(said, dict) and isinstance(said.get("text"), str):
        texts.append(f"Бригада ответила: «{said['text']}»")
    for effect in effects_of(event, branch):
        replaced = effect.get("with")
        if isinstance(replaced, dict) and isinstance(replaced.get("text"), str):
            texts.append(f"Бригада потом доложила: «{replaced['text']}»")
    delays = [effect.get("by_s") for effect in effects_of(event, branch) if "delay" in effect]
    late = [value for value in delays if isinstance(value, (int, float)) and value > 0]
    if late:
        texts.append(f"Доклады бригады задержались на {round(max(late))} с.")
    return " ".join(texts) or None


def _repeat(item: ExpectationOutcome, expect: dict[str, Json], event: dict[str, Json]) -> str:
    """«Повторите: …» по невыполненному ожиданию."""
    option = _option_label(event, str(expect.get("option_key")))
    if item.action == "reply":
        return f"Повторите: ответьте бригаде «{option}»."
    if item.action == "correct_readback":
        return f"Повторите: сразу поправьте расчёт — «{option}»."
    if item.action == "call_service":
        exts = " или ".join(str(ext) for ext in _list(expect.get("phone_exts"), "phone_exts"))
        return f"Повторите: позвоните в {exts} и доложите по порядку памятки."
    if item.action == "call_brigade":
        return "Повторите: позвоните бригаде сами, если она долго молчит."
    return "Повторите: отвечайте на вызов бригады сразу."


def event_remarks(item: "FiredEvent") -> tuple[Remark, ...]:
    """Замечание события без верной реакции в срок: последствие — что сделал мир в ответ."""
    if item.untold:
        return (
            Remark(
                item.evidence(),
                _world(item.event, item.outcome.branch)
                or "Бригада не знала, что помощь уже едет, и ждала ответа диспетчера.",
                remarks.MEMO_WHAT_IF,
                "Повторите: после вызова другой службы сообщите бригаде, что служба уже едет.",
                kind="notice",
            ),
        )
    expects = [_dict(raw, "expect[]") for raw in _list(item.event.get("expect"), "expect")]
    failed = [
        (outcome, expect)
        for outcome, expect in zip(item.outcome.expectations, expects, strict=True)
        if outcome.state in {"late", "wrong", "missed"}
    ]
    if not failed:
        return ()
    outcome, expect = failed[0]
    said = next(
        (
            str(reply["text"])
            for reply in item.replies
            if reply.get("mode") == "voice"
            and isinstance(reply.get("text"), str)
            and parse_time(reply.get("at"), "replies[].at") >= item.fired_at
        ),
        None,
    )
    world = (
        "Бригада ждала реакции дольше срока: работа на месте задержалась."
        if outcome.state == "late"
        else _world(item.event, item.outcome.branch)
    )
    return (
        remarks.brigade_event(
            item.evidence(),
            str(item.event.get("kind")),
            outcome.action,
            _repeat(outcome, expect, item.event),
            world,
            remarks.excerpt(said) if said else None,
        ),
    )


class BrigadeWorkCriterion:
    """«Работа с бригадой»: среднее по событиям и первым полным вводным каждой бригаде.

    Балл первой полной вводной каждой бригаде — 1 за верный повод, 0 за неверный;
    последующая поправка не стирает уже начатое реагирование. Этот вклад некритический
    и независим от наличия событий. Сценарные события сохраняют прежние правила:
    `sₑ` — среднее по ожиданиям события (`met` = 1,
    `late` = BRIGADE_LATE_SCORE, `wrong` = `missed` = 0; службу вызвали по просьбе, а бригаде
    не сообщили — не выше BRIGADE_UNTOLD_SCORE), кроме страховочных событий и
    событий с вопросом к данным (`data_problem`: нужного варианта ответа нет —
    обучаемому не вменяется). Балл — арифметическое среднее всех этих вкладов.
    Нет оцениваемых событий и полных вводных — критерий не применялся: вес 0.
    """

    key = "brigade_work"

    def evaluate(self, ctx: EvalContext) -> CriterionResult:
        weight = _criterion_weight(ctx, self.key)
        fired = fired_events(ctx)
        evidence = [item.evidence() for item in fired]
        problems = {id(item): data_problem(item.event) for item in fired}
        scored = [item for item in fired if not item.fallback and problems[id(item)] is None]
        scores = [
            score for item in scored if (score := event_score(item.outcome, item.event)) is not None
        ]
        critical = any(item.critical for item in fired if problems[id(item)] is None)
        found = [
            *(remark for item in scored for remark in event_remarks(item)),
            *(
                remarks.brigade_event_data(problem)
                for problem in problems.values()
                if problem is not None
            ),
        ]
        briefings: dict[str, dict[str, Json]] = {}
        for item in ctx.briefings:
            brigade = item.get("brigade_id")
            if item.get("complete") is True and isinstance(brigade, str):
                briefings.setdefault(brigade, item)
        for brigade, item in briefings.items():
            correct = item.get("incident") is True
            scores.append(float(correct))
            text = str(item.get("text") or "")
            evidence.append(
                f"Вводная бригаде {brigade}: «{text}» — "
                + ("происшествие передано верно." if correct else "названо другое происшествие.")
            )
            if not correct:
                found.append(
                    Remark(
                        "Во вводной бригаде названо другое происшествие.",
                        "Бригада выехала по услышанному поводу; "
                        "при прибытии обнаружила другое происшествие.",
                        remarks.MEMO_RULES,
                        "Повторите: передайте бригаде адрес и суть происшествия из карточки.",
                        quote=remarks.excerpt(text),
                    )
                )
        if not scores:
            explanation = (
                "Событий бригады в этой карточке не было — критерий не применялся."
                if not fired
                else "Реплики бригады обучаемый не услышал — оценивать нечего."
            )
            return CriterionResult(
                self.key, 1.0, 0.0, critical, evidence, explanation, tuple(found)
            )
        score = sum(scores) / len(scores)
        met = sum(1 for value in scores if value == 1.0)
        event_count = len(scores) - len(briefings)
        event_met = met - sum(item.get("incident") is True for item in briefings.values())
        explanation = f"Работа с бригадой: в срок и верно — {event_met} из {event_count} событий."
        if briefings:
            correct_count = sum(item.get("incident") is True for item in briefings.values())
            explanation += (
                f" Вводные: происшествие передано верно — {correct_count} из {len(briefings)}."
            )
            if correct_count < len(briefings):
                explanation += (
                    " Во вводной названо другое происшествие; "
                    "бригада выехала по услышанному поводу."
                )
        ahead = sum(1 for item in fired if item.outcome.ahead == "told")
        if ahead:
            explanation += f" Служба вызвана заранее и бригада предупреждена — {ahead}."
        untold = sum(1 for item in fired if item.untold)
        if untold:
            explanation += (
                f" Замечание: служба вызвана заранее, но бригаде не сказали — {untold}; "
                "предупреждайте бригаду, что служба едет."
            )
        news_untold = sum(1 for item in fired if item.news_untold)
        if news_untold:
            explanation += (
                f" Замечание: службу вызвали, но бригаде не сообщили, что она едет, — "
                f"{news_untold}; балл события не выше, чем за непредупреждённую бригаду. "
                "Перезвоните бригаде или вернитесь к ней с удержания: «отправил, едет»."
            )
        if critical:
            what = "; ".join(
                _CRITICAL.get(str(item.event.get("kind")), "событие бригады без верной реакции")
                for item in fired
                if item.critical and problems[id(item)] is None
            )
            explanation += f" Критическая ошибка: {what}."
        return CriterionResult(
            self.key, score, weight, critical, evidence, explanation, tuple(found)
        )


BRIGADE_REGISTRY = {"brigade_work": BrigadeWorkCriterion()}


def effects_of(event: dict[str, Json], branch: Branch | None) -> list[dict[str, Json]]:
    """Последствия ветки в мире (`delay`/`replace`); без ветки — никаких."""
    if branch is None:
        return []
    branches = event.get("branches")
    if not isinstance(branches, dict):
        return []
    chosen = branches.get(branch)
    if chosen is None and branch in AHEAD_BRANCHES:
        chosen = branches.get("met")
    if not isinstance(chosen, dict):
        return []
    return [cast(dict[str, Json], item) for item in _list(chosen.get("effects", []), "effects")]


def awaited_call(event: dict[str, Json], branch: Branch | None) -> dict[str, Json] | None:
    """Ждёт ли ветка звонка диспетчера абоненту (`awaits_call`, HQ-019); нет — None.

    `{contact_role, within_s, otherwise}`: пока диспетчер не позвонил, доклад, который держит
    событие, не приходит — но не дольше `within_s` от исхода ветки; не позвонил к сроку —
    вместо `effects` ветки действуют `otherwise` (мир пошёл без него).
    """
    if branch is None:
        return None
    branches = event.get("branches")
    if not isinstance(branches, dict):
        return None
    chosen = branches.get(branch)
    if chosen is None and branch in AHEAD_BRANCHES:
        chosen = branches.get("met")
    if not isinstance(chosen, dict):
        return None
    awaits = chosen.get("awaits_call")
    return cast(dict[str, Json], awaits) if isinstance(awaits, dict) else None


def otherwise_of(awaits: dict[str, Json]) -> list[dict[str, Json]]:
    """Последствия ветки, которая не дождалась звонка (`awaits_call.otherwise`)."""
    return [
        cast(dict[str, Json], item)
        for item in _list(awaits.get("otherwise", []), "awaits_call.otherwise")
    ]


def answered_call(
    calls: Sequence[dict[str, Json]], exts: AbstractSet[str], since: datetime
) -> datetime | None:
    """Когда диспетчер дозвонился абоненту с номером из `exts` не раньше `since`; нет — None.

    Нужен ветке с `awaits_call` (HQ-019): звонок считается, только если абонент снял трубку
    (`answered_at`) — набор и отказ линии разговором не стали.
    """
    return min(
        (
            answered
            for item in calls
            if item.get("direction", "outbound") == "outbound"
            and item.get("refusal") is None
            and str(item.get("phone_ext")) in exts
            and (answered := _optional_time(item.get("answered_at"), "calls[].answered_at"))
            is not None
            and answered >= since
        ),
        default=None,
    )


def targets_of(event: dict[str, Json]) -> set[str]:
    """Доклады плана, которые последствия события могут задержать или подменить.

    Считаются и последствия ветки, не дождавшейся звонка (`awaits_call.otherwise`): этот
    доклад тоже ждёт исхода.
    """
    branches = event.get("branches")
    if not isinstance(branches, dict):
        return set()
    targets: set[str] = set()
    for branch in branches.values():
        if not isinstance(branch, dict):
            continue
        awaits = branch.get("awaits_call")
        effects = [*_list(branch.get("effects", []), "effects")]
        if isinstance(awaits, dict):
            effects += otherwise_of(cast(dict[str, Json], awaits))
        for effect in effects:
            if isinstance(effect, dict):
                target = effect.get("delay", effect.get("replace"))
                if isinstance(target, str):
                    targets.add(target)
    return targets
