"""Что окно телефона говорит само — правила клиента (`apps/web/src/arm/softphone`) для прогона.

Сервер выдаёт доклады и реплики событий; остальное в разговоре говорит браузер фразами банка
(`bankPhrases.json` — тот же файл, что у клиента): бригада снимает трубку, во входящем
вызове старший называет себя, после доклада спрашивает «Как приняли?», отвечает на фразы
диспетчера вне своего вопроса, кладёт трубку, когда сказать нечего. Прогону эти правила нужны,
чтобы расшифровка совпадала с тем, что слышит обучаемый.

Правило «Как приняли?» — то же, по которому сервер держит очередь реплик
(`app.api.training.turns.asks_confirmation`); с клиентом оно общее по таблице примеров
`apps/web/src/arm/softphone/brigade/confirmRequest.cases.json`: её проверяют и vitest
(`asksConfirmation`), и pytest (`test_turns.py`), так правила не расходятся.
"""

import json
import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from typing import Any

from evalcore.service_told import (  # type: ignore[import-untyped]
    parse_service_intent,
)

from app.api.training import turns
from app.core.config import ROOT
from app.seed.service_defaults import phone_services

SOFTPHONE = ROOT / "apps" / "web" / "src" / "arm" / "softphone"
BANK_PHRASES = SOFTPHONE / "bankPhrases.json"
CONFIRM_CASES = SOFTPHONE / "brigade" / "confirmRequest.cases.json"
VOICES = ROOT / "data" / "voices"

# Константы клиента (Softphone.tsx, speech.ts, incoming.ts) — те же значения.
MIN_LISTEN_S = 2.0  # speech.ts MIN_LISTEN_MS: бригада дослушивает диспетчера после ответа
BRIGADE_QUIET_S = 6.0  # Softphone.tsx BRIGADE_QUIET_MS: сказать нечего — бригада кладёт трубку
CONFIRMED_QUIET_S = 1.2  # Softphone.tsx CONFIRMED_QUIET_MS: после «Принял» — быстрее
# Служба без своей книги бригады отвечает голосом пожарного расчёта (bank.ts FALLBACK_SERVICE).
FALLBACK_SERVICE = "101"
# Скорость речи текста без записи (оценка для расшифровки): ~14 знаков в секунду.
CHARS_PER_SECOND = 14.0


@lru_cache(maxsize=1)
@lru_cache(maxsize=1)
def bank() -> dict[str, Any]:
    """Выборка банка окна телефона: книги (`books`) и таблицы сюжетов заявителя (`callerPlots`)."""
    return dict(json.loads(BANK_PHRASES.read_text(encoding="utf-8")))


def books() -> dict[str, Any]:
    return dict(bank()["books"])


def brigade_phrases(service: str, slot: str) -> list[dict[str, Any]]:
    book = service if books().get(service, {}).get("speaker") == "brigade" else FALLBACK_SERVICE
    return list(books()[book]["slots"].get(slot, []))


def brigade_phrase(service: str, slot: str) -> str:
    """Первая фраза места — так выбирает клиент (`brigadePhrase`, turn = 0)."""
    phrases = brigade_phrases(service, slot)
    if not phrases:
        raise KeyError(f"нет фраз банка {service}.{slot}")
    return str(phrases[0]["text"])


def official_phrase(slot: str) -> str:
    phrases = [item for item in books()["OFFICIAL"]["slots"].get(slot, []) if not item.get("only")]
    return str(phrases[0]["text"])


def intro_phrase(service: str) -> str:
    """Входящий вызов: старший называет себя (incoming.ts `introPhrase`)."""
    return brigade_phrase(service, "intro")


def confirm_request_phrase(service: str) -> str:
    """Конец доклада (incoming.ts `confirmRequestPhrase`): «Как приняли?», если есть в книге."""
    phrases = brigade_phrases(service, "confirm_request")
    preferred = next((item for item in phrases if item["text"] == "Как приняли?"), None)
    return str((preferred or phrases[0])["text"])


def resumed_phrase(service: str, waiting_confirm: bool, question: str | None = None) -> str:
    """Снят с удержания (incoming.ts `resumedPhrase`): старший снова на связи — фраза места
    `answer` со словами «на связи»; ждал ответа на свой вопрос с вариантами (`question` — его
    реплика) — повторяет вопрос (HQ-058); ждал «Принял» на «Как приняли?» — переспрашивает его."""
    if question:
        return question
    if waiting_confirm:
        return confirm_request_phrase(service)
    return next(
        (
            str(item["text"])
            for item in brigade_phrases(service, "answer")
            if "на связи" in item["text"].lower()
        ),
        brigade_phrase(service, "answer"),
    )


def asks_confirmation(delivery: dict[str, Any], inbound: bool) -> bool:
    """После реплики бригада спрашивает «Как приняли?» — правило сервера и окна телефона
    (`app.api.training.turns.asks_confirmation`) по полям выдачи."""
    return turns.asks_confirmation(
        inbound, bool(delivery.get("reply_options")), bool(delivery.get("answer"))
    )


@lru_cache(maxsize=1)
def durations() -> dict[str, float]:
    """Текст фразы → длительность записи, с; по всем наборам `data/voices/bank-v*`."""
    found: dict[str, float] = {}
    for manifest in sorted(VOICES.glob("bank-v*/manifest.json")):
        for item in json.loads(manifest.read_text(encoding="utf-8"))["messages"]:
            if item.get("duration_ms"):
                found.setdefault(item["text"], item["duration_ms"] / 1000)
    return found


def speech_seconds(text: str, audio: dict[str, Any] | None = None) -> float:
    """Сколько звучит реплика: длительность записи или оценка по длине текста."""
    if audio and audio.get("duration_ms"):
        return max(1.2, float(audio["duration_ms"]) / 1000)
    known = durations().get(text)
    if known:
        return known
    return max(1.2, len(text) / CHARS_PER_SECOND)


# --- Ответ бригады на фразу вне её вопроса (voiceReply.ts `brigadeAnswer`) ---------------

_ASKS_REPORT = re.compile(
    r"доклад|доложи|обстановк|ситуаци|что у вас|как у вас|где вы|на месте|прибыл", re.I
)


# Система-112: через неё вызывают любую службу (logic.ts `SYSTEM_112`).
SYSTEM_112 = "112"
# Сколько окно верит своему набору номера службы до выдачи (logic.ts `LOCAL_DIAL_TRUST_MS`).
LOCAL_DIAL_TRUST_S = 10.0


@dataclass(frozen=True)
class Dial:
    """Набор номера службы (logic.ts `ServiceDial`): из выдачи или свой (`local`)."""

    service: str
    at: datetime
    local: bool = False


@dataclass(frozen=True)
class Awaited:
    """Просьбы бригады о службах и засчитал бы сервер весть о них сейчас (logic.ts
    `awaitedService`, HQ-055): `service` — о какой службе «отправил» без названия (None —
    бригада не просила), `open` — есть просьба в окне вести, `asked` — просимые службы,
    `opened` — те, что в окне, `called` — службы, номер которых уже набран (GP-28)."""

    service: str | None
    open: bool
    asked: tuple[str, ...]
    opened: tuple[str, ...]
    called: tuple[str, ...] = ()


def _time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def server_dials(calls: Iterable[dict[str, Any]]) -> list[Dial]:
    """Звонки в службы из выдачи (`CardTraining.service_calls`, logic.ts `serverDials`)."""
    return [Dial(str(call["service_id"]), _time(call["started_at"])) for call in calls]


def _dialed_at(
    dials: Iterable[Dial], service: str, since: datetime, now: datetime
) -> datetime | None:
    found = [
        dial.at
        for dial in dials
        if dial.service in (service, SYSTEM_112)
        and since <= dial.at <= now
        and (not dial.local or (now - dial.at).total_seconds() <= LOCAL_DIAL_TRUST_S)
    ]
    return min(found, default=None)


def awaited_service(
    messages: Iterable[dict[str, Any]],
    brigade_id: str | None,
    now: datetime,
    dials: Iterable[Dial] = (),
) -> Awaited:
    """Предъявленные просьбы бригады о службе (`needs_service`) и окно вести каждой: после
    звонка в службу (`service_called_at`; до выдачи — свой набор после просьбы) и не позже
    срока (`news_by`); набранные службы (`called`)."""
    dials = list(dials)
    local = [dial for dial in dials if dial.local]
    asks: list[tuple[str, bool]] = []
    for item in messages:
        delivery = item["delivery"]
        if (
            item["state"] != "presented"
            or delivery["brigade_id"] != brigade_id
            or not delivery.get("needs_service")
        ):
            continue
        service = str(delivery["needs_service"])
        raw = delivery.get("service_called_at")
        delivered = delivery.get("delivered_at")
        called = (
            _time(raw)
            if raw is not None
            else _dialed_at(local, service, _time(delivered) if delivered else now, now)
        )
        by = delivery.get("news_by")
        is_open = called is not None and now >= called and (by is None or now <= _time(by))
        asks.append((service, is_open))
    opened = [service for service, is_open in asks if is_open]
    about = opened or [service for service, _ in asks]
    called_services = tuple(
        dict.fromkeys(
            dial.service
            for dial in dials
            if _dialed_at([dial], dial.service, dial.at, now) is not None
        )
    )
    return Awaited(
        about[-1] if about else None,
        bool(opened),
        tuple(service for service, _ in asks),
        tuple(opened),
        called_services,
    )


def _clean(text: str) -> str:
    return text.lower().replace("ё", "е")


def says_called(text: str) -> bool:
    """«Вызвана» без названия службы (voiceReply.ts `saysCalled`)."""
    return parse_service_intent(text)["called"]


def called_service(text: str) -> str | None:
    """Названная вызванной служба (voiceReply.ts `calledService`): служба справочника."""
    ext = next(iter(parse_service_intent(text)["services"]), None)
    return None if ext is None else phone_services().get(ext, ext)


def news_service(text: str, awaited: Awaited | None) -> str | None:
    """О какой службе весть (voiceReply.ts `newsService`): о просимой — только в окне сервера."""
    named = called_service(text)
    if awaited is None:
        return named
    if named is not None:
        if named in awaited.asked:
            return named if named in awaited.opened else None
        # О службе, которую не просили, — только после набора её номера или 112 (GP-28).
        return named if named in awaited.called or SYSTEM_112 in awaited.called else None
    return awaited.service if awaited.open and says_called(text) else None


def service_coming_answer(text: str, service: str, named: str) -> str:
    """«Понял, ждём …» о службе `named` (voiceReply.ts `serviceComingAnswer`)."""
    phrases = [
        item for item in brigade_phrases(service, "service_coming") if item.get("needs") == named
    ]
    stems = [word[:5] for word in re.findall(r"[^\W\d_]+", _clean(text)) if len(word) >= 5]
    same = next(
        (item for item in phrases if any(stem in _clean(str(item["text"])) for stem in stems)),
        None,
    )
    chosen = same or (phrases[0] if phrases else None)
    return str(chosen["text"]) if chosen else brigade_phrase(service, "ack")


def brigade_answer(
    text: str, report: str | None, service: str, awaited: Awaited | None = None
) -> str:
    """Что бригада отвечает на фразу диспетчера вне своего вопроса (`brigadeAnswer` клиента).

    Весть о вызванной службе — «Понял, ждём скорую» (GP-28, HQ-055; о просимой службе —
    только в окне сервера, `awaited`). Просьба доложить — «Повторяю» и последний доклад
    бригады (не её вопрос и не ответ на действие диспетчера, Softphone `repeatReport`);
    доклада ещё не было — обещание доложить по прибытии. Новые сведения — «Принял».
    """
    named = news_service(text, awaited)
    if named is not None:
        return service_coming_answer(text, service, named)
    if _ASKS_REPORT.search(text):
        if report:
            return f"{brigade_phrase(service, 'repeat_report')} {report}"
        enroute = brigade_phrases(service, "enroute")
        promise = next((item for item in enroute if "доложу" in item["text"].lower()), None)
        return str((promise or enroute[0])["text"])
    return brigade_phrase(service, "ack")
