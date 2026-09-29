"""OP-08: голосовой ввод вопроса (выключаемая опция) — contracts/operator/voice.md."""

from pathlib import Path

from app.api.database import create_database_app
from fastapi.testclient import TestClient

from .test_lifecycle import login

SCENARIO = "fire_apartment_smoke"
CARD = "fire_apartment"


class FakeSTT:
    name = "fake:test"

    def __init__(self, text: str) -> None:
        self.text = text
        self.calls = 0

    async def transcribe(self, path: Path) -> str:
        self.calls += 1
        assert path.is_file()
        return self.text


def test_config_reports_stt_disabled_by_default(database_client):
    headers = login(database_client, "trainee01")
    response = database_client.get("/api/operator/config", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == {"stt_enabled": False}


def test_transcribe_requires_login(database_client):
    response = database_client.post(
        "/api/operator/transcribe", files={"audio": ("q.webm", b"\x00\x01", "audio/webm")}
    )
    assert response.status_code == 401


def test_transcribe_disabled_returns_404(database_client):
    headers = login(database_client, "trainee01")
    response = database_client.post(
        "/api/operator/transcribe",
        files={"audio": ("q.webm", b"\x00\x01", "audio/webm")},
        headers=headers,
    )
    assert response.status_code == 404


def test_transcribe_and_config_with_fake_provider(database_config):
    with TestClient(create_database_app(database_config)) as client:
        client.app.state.operator_stt_provider = FakeSTT("где горит")
        headers = login(client, "trainee01")

        config = client.get("/api/operator/config", headers=headers)
        assert config.status_code == 200, config.text
        assert config.json() == {"stt_enabled": True}

        response = client.post(
            "/api/operator/transcribe",
            files={"audio": ("q.webm", b"\x00\x01\x02\x03", "audio/webm")},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json() == {"text": "где горит"}
        assert client.app.state.operator_stt_provider.calls == 1


def test_transcribe_empty_audio_rejected(database_config):
    with TestClient(create_database_app(database_config)) as client:
        client.app.state.operator_stt_provider = FakeSTT("где горит")
        headers = login(client, "trainee01")
        response = client.post(
            "/api/operator/transcribe",
            files={"audio": ("q.webm", b"", "audio/webm")},
            headers=headers,
        )
        assert response.status_code == 422


def test_recognized_text_becomes_questionnaire_card_question(database_config):
    """Распознанный текст идёт тем же путём, что свободный вопрос (OP-03/OP-05):
    совпадает по смыслу с вопросом карты — узнаётся как этот вопрос."""
    with TestClient(create_database_app(database_config)) as client:
        client.app.state.operator_stt_provider = FakeSTT("Где горит, на каком адресе?")
        headers = login(client, "trainee01")

        transcribed = client.post(
            "/api/operator/transcribe",
            files={"audio": ("q.webm", b"\x00\x01\x02\x03", "audio/webm")},
            headers=headers,
        )
        assert transcribed.status_code == 200, transcribed.text
        text = transcribed.json()["text"]

        response = client.post(
            "/api/operator/ask",
            json={
                "scenario_id": SCENARIO,
                "state": {"panic": 1, "asked": [], "facts": []},
                "text": text,
            },
            headers=headers,
        )
        assert response.status_code == 200, response.text
        reply = response.json()["reply"]
        assert reply["question_key"] == "address"
        assert reply["outcome"] == "correct"
