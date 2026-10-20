"""Проверка гарнитуры (TC-14): фраза без звонка — contracts/headset-check.md."""

from . import test_voice_report as voice
from .test_voice_report import FakeSTT, call  # noqa: F401 — фикстура: вошедший обучаемый

lesson = voice.lesson


def check(case, audio=voice.AUDIO, headers=None):
    return case.client.post(
        "/api/headset-check",
        files={"audio": audio},
        headers=case.headers if headers is None else headers,
    )


def test_headset_check_returns_phrase(call):  # noqa: F811
    case, _ = call
    fake = FakeSTT("Проверка связи, меня слышно", 0.9)
    case.client.app.state.voice_report_stt = fake
    response = check(case)
    assert response.status_code == 200
    assert response.json()["text"] == "Проверка связи, меня слышно"
    assert set(response.json()) == {"text", "confidence", "loudness"}
    assert fake.calls == 1


def test_headset_check_refusals(call):  # noqa: F811
    case, _ = call
    assert check(case).status_code == 503  # распознавание выключено
    case.client.app.state.voice_report_stt = FakeSTT("x", 0.9)
    assert check(case, audio=("a.txt", b"text", "text/plain")).status_code == 422
    assert check(case, headers={}).status_code in (401, 403)
