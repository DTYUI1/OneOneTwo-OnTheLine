"""Ответ бригаде голосом (DT-16): отказы эндпоинта. Сопоставление с вариантом в разговоре с
бригадой — test_live_brigade_flow.py, правило — packages/evalcore/tests/test_voice_reply.py."""

from uuid import uuid4

from . import test_voice_report as voice
from .test_call_report import send
from .test_voice_report import FakeSTT, call  # noqa: F401 — фикстура звонка

lesson = voice.lesson


def reply(case, call_id, delivery_id=None, audio=voice.AUDIO):
    return case.client.post(
        f"/api/calls/{call_id}/voice-reply",
        data={"delivery_id": delivery_id or str(uuid4())},
        files={"audio": audio},
        headers=case.headers,
    )


def test_stt_off_is_explicit(call):  # noqa: F811
    case, call_id = call
    response = reply(case, call_id)
    assert response.status_code == 503
    assert response.json()["code"] == "stt_off"


def test_unknown_delivery_wrong_audio_and_ended_call_are_rejected(call):  # noqa: F811
    case, call_id = call
    fake = FakeSTT("Девятый этаж", 0.9)
    case.client.app.state.voice_report_stt = fake
    # В звонке службе реплик бригады нет.
    assert reply(case, call_id).status_code == 404
    assert reply(case, call_id, audio=("reply.txt", b"text", "text/plain")).status_code == 422
    assert reply(case, str(uuid4())).status_code == 404
    send(case, "call_hangup", {"call_id": call_id})
    assert reply(case, call_id).status_code == 409
    assert fake.calls == 0


def test_phrase_without_question_is_only_recognized(call):  # noqa: F811
    # DT-19: бригаде говорят и без её вопроса — только текст и громкость, без варианта.
    case, call_id = call
    fake = FakeSTT("Выезжайте, Каширское шоссе 26", 0.9)
    case.client.app.state.voice_report_stt = fake
    response = case.client.post(
        f"/api/calls/{call_id}/voice-reply", files={"audio": voice.AUDIO}, headers=case.headers
    )
    assert response.status_code == 200
    assert response.json()["text"] == "Выезжайте, Каширское шоссе 26"
    assert response.json()["option_key"] is None
    assert fake.calls == 1
