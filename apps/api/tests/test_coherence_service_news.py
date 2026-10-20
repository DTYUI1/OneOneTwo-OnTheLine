"""HQ-055 в прогоне связности: о вызванной по просьбе службе бригаде сообщает диспетчер.

Бригада сама не перезванивает ради «Понял» (`callback_without_news`); после звонка в службу
она говорит о ней — «Понял, ждём скорую» на весть диспетчера или «подъехала, могли бы и
сказать», а доклад после — о совместной работе (`called_service_ignored`).
"""

import json
from dataclasses import replace
from typing import Any

from app.core.config import ROOT
from app.tools.coherence.invariants import check, failing
from app.tools.coherence.phone import Awaited, news_service
from app.tools.coherence.transcript import Line, Source, Transcript

CODE = "fight-street-102-1"


def scenario(code: str = CODE) -> dict[str, Any]:
    path = ROOT / "data" / "scenarios" / f"{code}.json"
    return json.loads(path.read_text(encoding="utf-8"))


def say(
    at: float,
    text: str,
    source: Source,
    key: str | None = None,
    *,
    call: str = "c1",
    inbound: bool = False,
    answer: bool = False,
) -> Line:
    who = "Вы" if source == "dispatcher" else "Бригада 1"
    meta = {"inbound": inbound, "answer": answer}
    return Line(at, "speech", who, text, source, end=at + 2.0, call=call, key=key, meta=meta)


def transcript(lines: list[Line], code: str = CODE, service: str = "102") -> Transcript:
    tr = Transcript(code, "проверка", service, lines=lines)
    tr.data["scenario"] = scenario(code)
    return tr


def rules(tr: Transcript) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for item in check(tr):
        found.setdefault(item.rule, []).append(item.detail)
    return found


def test_callback_only_for_ack_is_a_violation():
    tr = transcript([say(73, "Понял.", "branch", "ambulance:met", inbound=True, answer=True)])
    assert "callback_without_news" in rules(tr)


def test_callback_with_news_is_not():
    """Повторная просьба и «внезапный» приезд службы — повод позвонить."""
    surprise = "Скорая подъехала. Хорошо, но вы бы предупредили, что вызвали."
    tr = transcript(
        [
            say(73, surprise, "branch", "ambulance:surprise", inbound=True, answer=True),
            say(90, "Срочно скорую!", "branch", "ambulance:missed", call="c2", inbound=True),
        ]
    )
    assert "callback_without_news" not in rules(tr)


def _called(tr: Transcript) -> Transcript:
    tr.firings["ambulance"] = 42.7
    tr.service_calls.append(("103", 57.7))
    return tr


def test_called_service_needs_answer_and_report():
    data = scenario()
    completion = next(item for item in data["plan"] if item["key"] == "completion")
    told = [
        say(78, "Скорую уже вызвал, едет.", "dispatcher", call="c2"),
        say(80, "Понял, скорую ждём, место для машины освободим.", "client", call="c2"),
    ]
    report = [say(104, completion["line"]["text"], "plan", "completion", call="c3")]
    assert "called_service_ignored" not in rules(_called(transcript(told + report)))
    # Доклад после — без службы: бригада о совместной работе не говорит.
    plain = [say(104, "Наряд свободен.", "plan", "completion", call="c3")]
    assert any(
        "доклад" in item
        for item in rules(_called(transcript(told + plain)))["called_service_ignored"]
    )
    # Бригада о службе узнала только из доклада: ни «ждём», ни «подъехала».
    assert any(
        "Понял, ждём" in item
        for item in rules(_called(transcript(report)))["called_service_ignored"]
    )


def test_silence_about_called_service_fails_in_every_scenario():
    """Поблажек «ждёт озвучки» нет: фразы о совместной работе со службой записаны (bank-v9),
    доклад без службы роняет прогон в любом сценарии, в том числе бывших исключениях."""
    tr = transcript([say(80, "Поняла, ждём полицию.", "client")], "fight-street-103-1", "103")
    tr.firings["police"] = 40.0
    tr.service_calls.append(("102", 50.0))
    assert "called_service_ignored" in rules(tr)
    assert failing("called_service_ignored")


def test_phone_news_window_mirrors_the_window():
    """Окно телефона в прогоне (`phone.news_service`) — как voiceReply.ts `newsService`:
    о просимой службе весть засчитана только в окне сервера; две просьбы о скорой (просьба и
    тревога) — окно первой не закрывается второй."""
    open_ = Awaited("103", True, ("103",), ("103",))
    closed = Awaited("103", False, ("103",), ())
    assert news_service("Отправил, ждите.", open_) == "103"
    assert news_service("Отправил, ждите.", closed) is None
    assert news_service("Скорая будет.", closed) is None
    # О службе, которую не просили, — только после набора её номера или 112 (GP-28).
    assert news_service("Пожарные выехали.", closed) is None
    assert news_service("Пожарные выехали.", replace(closed, called=("101",))) == "101"
    assert news_service("Пожарные выехали.", replace(closed, called=("112",))) == "101"
    assert news_service("Сейчас вызову.", open_) is None
    twice = Awaited("103", True, ("103", "103"), ("103",))
    assert news_service("Скорую уже вызвал, едет.", twice) == "103"
