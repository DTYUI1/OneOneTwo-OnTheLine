"""Доклад службе голосом (DT-05): распознавание фразы в разговоре и вид доклада по сведениям."""

import asyncio
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import pytest
from app.api.database import create_database_app
from app.api.voice_report import service as voice_report_service
from app.api.voice_report.service import heard
from app.core.models import Assignment, Card, Scenario
from app.worker.providers.interfaces import Recognition
from app.worker.providers.stt.local import LocalFasterWhisperSTT
from app.worker.providers.stt.null import NullSTT
from fastapi.testclient import TestClient
from sqlalchemy import select

from . import test_c03_sessions as c03
from .test_call_report import send
from .test_lifecycle import login, run_db

lesson = c03.lesson
AUDIO = ("report.webm", b"\x1a\x45\xdf\xa3voice", "audio/webm;codecs=opus")


class FakeSTT:
    name = "fake:test"

    def __init__(self, text: str, confidence: float | None) -> None:
        self.result = Recognition(text, confidence)
        self.calls = 0

    async def transcribe(self, path: Path) -> str:
        return self.result.text

    async def recognize(self, path: Path, hints: tuple[str, ...] = ()) -> Recognition:
        self.calls += 1
        self.hints = hints
        assert path.is_file()
        return self.result


@pytest.mark.parametrize(
    ("text", "confidence", "expected"),
    [
        ("ДТП на Дубнинской", 0.8, True),
        ("ДТП на Дубнинской", None, True),
        ("ДТП на Дубнинской", 0.2, False),
        ("", 0.9, False),
    ],
)
def test_heard_needs_text_and_confidence(text, confidence, expected):
    assert heard(text, confidence, 0.45) is expected


def stt(handle) -> LocalFasterWhisperSTT:
    return LocalFasterWhisperSTT(
        base_url="http://stt.test", timeout_seconds=1, transport=httpx.MockTransport(handle)
    )


def test_local_provider_returns_confidence(tmp_path):
    audio = tmp_path / "phrase.webm"
    audio.write_bytes(b"voice")
    with_confidence = stt(
        lambda request: httpx.Response(200, json={"text": "ДТП", "confidence": 0.7})
    )
    old_server = stt(lambda request: httpx.Response(200, json={"text": "ДТП"}))
    broken = stt(lambda request: httpx.Response(500))

    assert asyncio.run(with_confidence.recognize(audio)) == Recognition("ДТП", 0.7)
    # Образ до DT-05 уверенности не сообщает — её нет, а не «уверен на 100 %».
    assert asyncio.run(old_server.recognize(audio)) == Recognition("ДТП", None)
    assert asyncio.run(broken.recognize(audio)) == Recognition("", None)
    assert asyncio.run(NullSTT().recognize(audio)) == Recognition("", None)


@pytest.fixture
def call(lesson, database_config, database_url):
    """Идущий звонок в службу карточки обучаемого trainee01."""
    c03.batch(lesson, [c03.item(lesson), c03.item(lesson, participant=1)])
    c03.start(lesson)
    c03.tick(database_url)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, "trainee01")
        card = next(c for c in client.get("/api/cards").json() if c["session_id"] == lesson.id)
        case = SimpleNamespace(client=client, headers=headers, card=card)
        send(case, "deliver", {})
        send(case, "status_change", {"state": "accepted", "comment": "Принята"})
        call_id = str(uuid4())
        send(case, "call_dial", {"call_id": call_id, "phone_ext": card["source"]["service_ids"][0]})
        send(case, "call_answer", {"call_id": call_id})
        yield case, call_id


def recognize(case, call_id):
    return case.client.post(
        f"/api/calls/{call_id}/voice-report", files={"audio": AUDIO}, headers=case.headers
    )


def test_stt_off_is_explicit(call):
    case, call_id = call
    response = recognize(case, call_id)
    assert response.status_code == 503
    assert response.json()["code"] == "stt_off"


def test_full_voice_report_is_recognized_by_meaning(call):
    case, call_id = call
    source = case.card["source"]
    address = source["address"]
    # Порядок памятки ДДС, с. 32: кто вы, адрес и повод, карточка, что изменилось.
    text = (
        f"Диспетчер ДДС Иванов. {address['street']}, дом {address['house']}, "
        f"{source['incident_class']}. Работаем по карточке {source['number']}. "
        "Ситуация изменилась, бригада направлена"
    )
    fake = FakeSTT(text, 0.8)
    case.client.app.state.voice_report_stt = fake

    response = recognize(case, call_id)

    assert response.status_code == 200, response.text
    assert response.json()["text"] == text
    assert response.json()["choice"] == "full"
    assert response.json()["parts"] == ["who", "address", "card", "change"]
    assert fake.calls == 1


def test_card_is_not_required_outside_112(call):
    case, call_id = call
    source = case.card["source"]
    address = source["address"]
    # Звонок службе карточки, не в 112: карточку памятка ДДС, с. 32 требует только для 112.
    text = (
        f"Диспетчер ДДС Иванов. {address['street']}, дом {address['house']}, "
        f"{source['incident_class']}. Ситуация изменилась, бригада направлена"
    )
    case.client.app.state.voice_report_stt = FakeSTT(text, 0.8)

    body = recognize(case, call_id).json()

    assert body["choice"] == "full"
    assert body["parts"] == ["who", "address", "change"]


def street_of_card(database_url: str, card_id: str, street: str) -> None:
    """Улица карточки в сценарии занятия (копия сценария — только у этого занятия)."""

    async def change(db):
        card = await db.get(Card, UUID(card_id))
        scenario = await db.scalar(
            select(Scenario).join(Assignment).where(Assignment.id == card.assignment_id)
        )
        scenario.card = {**scenario.card, "address": {**scenario.card["address"], "street": street}}

    run_db(database_url, change)


def report_text(source: dict, street: str) -> str:
    address = source["address"]
    return (
        f"Диспетчер ДДС Иванов. {street}, дом {address['house']}, "
        f"{source['incident_class']}. Работаем по карточке {source['number']}. "
        "Ситуация изменилась, бригада направлена"
    )


def test_confusable_street_is_spelled_by_letters(call, database_url):
    # TC-03: похожая улица Москвы (data/confusable_streets.json) — дежурный переспросит улицу
    # по буквам; ответ называет улицу, с которой её легко спутать.
    case, call_id = call
    street_of_card(database_url, case.card["id"], "Дубнинская улица")
    case.client.app.state.voice_report_stt = FakeSTT(
        report_text(case.card["source"], "Дубнинская улица"), 0.8
    )
    body = recognize(case, call_id).json()
    assert "address" in body["parts"]
    assert body["spell_street"] == "Дубининская улица"


def test_spelling_is_asked_only_for_confusable_street_and_named_address(
    call, database_url, monkeypatch
):
    case, call_id = call
    source = case.card["source"]
    # Улица карточки похожая, но адрес не прозвучал — переспрашивать по буквам нечего.
    street_of_card(database_url, case.card["id"], "Дубнинская улица")
    case.client.app.state.voice_report_stt = FakeSTT(
        f"{source['incident_class']}, бригада направлена", 0.8
    )
    body = recognize(case, call_id).json()
    assert "address" not in body["parts"] and body["spell_street"] is None
    # Улица без похожей (пары нет в списке) — переспроса по буквам нет.
    monkeypatch.setattr(voice_report_service, "confusable_pairs", lambda: ())
    case.client.app.state.voice_report_stt = FakeSTT(report_text(source, "Дубнинская улица"), 0.8)
    body = recognize(case, call_id).json()
    assert "address" in body["parts"] and body["spell_street"] is None


def test_missing_parts_are_named(call):
    case, call_id = call
    source = case.card["source"]
    case.client.app.state.voice_report_stt = FakeSTT(
        f"{source['incident_class']}, есть пострадавшие, бригада направлена", 0.8
    )
    body = recognize(case, call_id).json()
    # Не представился и без адреса: вид — первая недостающая часть, части — все сказанные.
    assert body["choice"] == "no_who"
    assert body["parts"] == ["change"]


def test_unclear_phrase_is_not_recognized(call):
    case, call_id = call
    case.client.app.state.voice_report_stt = FakeSTT("э-э", 0.1)
    body = recognize(case, call_id).json()
    assert body == {
        "text": "э-э",
        "confidence": 0.1,
        "choice": None,
        "parts": [],
        "address_gap": None,
        "loudness": None,
        "spell_street": None,
    }


def test_report_adds_up_over_the_call(call):
    # Стенд 17.10: адрес и повод одной фразой, «кто вы» — ответом на переспрос. Клиент
    # присылает прежние фразы звонка (earlier), части считаются по сумме.
    case, call_id = call
    source = case.card["source"]
    address = source["address"]
    first = f"{address['street']}, дом {address['house']}, {source['incident_class']}"
    case.client.app.state.voice_report_stt = FakeSTT(first, 0.8)
    body = recognize(case, call_id).json()
    assert body["parts"] == ["address"] and body["choice"] == "no_who"

    case.client.app.state.voice_report_stt = FakeSTT("Обучаемый 0.1. Служба 102", 0.8)
    alone = recognize(case, call_id).json()
    assert alone["parts"] == ["who"] and alone["choice"] == "no_address"
    together = case.client.post(
        f"/api/calls/{call_id}/voice-report",
        files={"audio": AUDIO},
        data={"earlier": first},
        headers=case.headers,
    ).json()
    assert together["text"] == "Обучаемый 0.1. Служба 102"
    # Звонок своей службе: номер карточки обязателен только для 112, здесь не хватает
    # следующей части доклада — что изменилось.
    assert source["service_ids"][0] != "112"
    assert together["parts"] == ["who", "address"] and together["choice"] == "no_change"

    # Поправленный текст (TC-04) складывается так же.
    response = case.client.post(
        f"/api/calls/{call_id}/voice-report",
        data={"text": f"Работаем по карточке {source['number']}", "earlier": first},
        headers=case.headers,
    )
    assert response.json()["parts"] == ["address", "card"]
    too_long = case.client.post(
        f"/api/calls/{call_id}/voice-report",
        data={"text": "Диспетчер", "earlier": "а" * 4001},
        headers=case.headers,
    )
    assert too_long.status_code == 422


def test_address_gap_names_what_is_missing(call):
    # Служба переспрашивает одним вопросом то, чего не хватило: адреса или повода.
    case, call_id = call
    address = case.card["source"]["address"]
    case.client.app.state.voice_report_stt = FakeSTT("Диспетчер ДДС Иванов", 0.8)
    assert recognize(case, call_id).json()["address_gap"] == "place"
    case.client.app.state.voice_report_stt = FakeSTT(
        f"{address['street']}, дом {address['house']}", 0.8
    )
    assert recognize(case, call_id).json()["address_gap"] == "reason"


def test_changed_situation_is_the_reason_of_the_call(call, monkeypatch):
    # Стенд 17.10: бригада доложила «под капотом загорелось, нужны пожарные» (task_change), и
    # диспетчер звонит в 101: «<адрес> горит автомобиль» — адрес и повод и что изменилось,
    # хотя класс карточки — другой.
    case, call_id = call
    address = case.card["source"]["address"]
    text = f"{address['street']}, дом {address['house']}, горит автомобиль"
    case.client.app.state.voice_report_stt = FakeSTT(text, 0.8)
    before = recognize(case, call_id).json()
    assert before["parts"] == [] and before["address_gap"] == "reason"

    change = {"comment_keywords": ["пожар / пожарные / загорелось / горит / возгорание / огонь"]}
    planned = (
        {"message_id": "a", "presented_at": None, "task_change": {"comment_keywords": ["газ"]}},
        {"message_id": "b", "presented_at": "2026-10-17T10:00:00+00:00", "task_change": change},
    )

    async def fake_planned(*args):
        return planned

    monkeypatch.setattr(voice_report_service, "planned_messages", fake_planned)
    after = recognize(case, call_id).json()
    assert after["parts"] == ["address", "change"] and after["choice"] == "no_who"
    assert after["address_gap"] is None


def test_only_presented_task_changes_count():
    planned = (
        {"presented_at": None, "task_change": {"comment_keywords": ["газ"]}},
        {"presented_at": "2026-10-17T10:00:00+00:00", "task_change": {"label": "пожар"}},
        {"presented_at": "2026-10-17T10:00:00+00:00"},
    )
    assert voice_report_service.presented_changes(planned) == ({"label": "пожар"},)
    assert voice_report_service.report_text(None, "Диспетчер") == "Диспетчер"
    assert voice_report_service.report_text(" Улица. ", "Диспетчер") == "Улица. Диспетчер"


def typed(case, call_id, text):
    return case.client.post(
        f"/api/calls/{call_id}/voice-report", data={"text": text}, headers=case.headers
    )


def test_checked_text_is_judged_like_recognized_one_even_when_stt_is_off(call):
    # TC-04: неуверенную фразу обучаемый проверил в поле правки; текст уходит вместо звука,
    # распознавание не нужно (на стенде оно выключено), уверенности и громкости нет.
    case, call_id = call
    source = case.card["source"]
    case.client.app.state.voice_report_stt = FakeSTT("дубнинская", 0.2)
    first = recognize(case, call_id).json()
    # Речь есть, а доклад не засчитан: клиент покажет text в поле правки.
    assert first["text"] == "дубнинская" and first["choice"] is None

    text = f"Диспетчер ДДС Иванов. {source['incident_class']}, бригада направлена"
    del case.client.app.state.voice_report_stt
    response = typed(case, call_id, text)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["text"] == text
    assert body["confidence"] is None and body["loudness"] is None
    assert body["choice"] == "no_address"
    assert body["parts"] == ["who", "change"]


def test_checked_text_needs_exactly_one_of_audio_and_text(call):
    case, call_id = call
    case.client.app.state.voice_report_stt = FakeSTT("ДТП", 0.9)
    url = f"/api/calls/{call_id}/voice-report"
    assert case.client.post(url, headers=case.headers).status_code == 422
    assert typed(case, call_id, "   ").status_code == 422
    both = case.client.post(url, files={"audio": AUDIO}, data={"text": "ДТП"}, headers=case.headers)
    assert both.status_code == 422
    assert typed(case, call_id, "а" * 1001).status_code == 422
    send(case, "call_hangup", {"call_id": call_id})
    assert typed(case, call_id, "ДТП").status_code == 409


def test_loudness_of_phrase_is_judged(call):
    case, call_id = call
    fake = FakeSTT("ДТП на Дубнинской", 0.9)
    fake.result = Recognition("ДТП на Дубнинской", 0.9, (-46.0, 0.0))
    case.client.app.state.voice_report_stt = fake
    assert recognize(case, call_id).json()["loudness"] == "quiet"


def test_ended_call_and_wrong_audio_are_rejected(call):
    case, call_id = call
    case.client.app.state.voice_report_stt = FakeSTT("ДТП", 0.9)
    wrong = case.client.post(
        f"/api/calls/{call_id}/voice-report",
        files={"audio": ("report.txt", b"text", "text/plain")},
        headers=case.headers,
    )
    assert wrong.status_code == 422
    send(case, "call_hangup", {"call_id": call_id})
    assert recognize(case, call_id).status_code == 409


def test_other_trainee_cannot_use_the_call(call, database_config):
    case, call_id = call
    with TestClient(create_database_app(database_config)) as other:
        headers = login(other, "trainee02")
        other.app.state.voice_report_stt = FakeSTT("ДТП", 0.9)
        response = other.post(
            f"/api/calls/{call_id}/voice-report", files={"audio": AUDIO}, headers=headers
        )
        assert response.status_code == 404
