"""STT-01: распознавание голосового доклада — выключаемая опция."""

import asyncio
import shutil
import wave
from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

import httpx
from app.api.database import create_database_app
from app.core.db import Database
from app.core.models import Assignment, Call, Card, Job
from app.worker.jobs import handlers
from app.worker.providers.stt.local import LocalFasterWhisperSTT
from app.worker.queue import ClaimedJob
from app.worker.runtime import Worker
from fastapi.testclient import TestClient
from sqlalchemy import select


def login(client: TestClient, name: str = "teacher") -> dict[str, str]:
    response = client.post("/api/auth/login", json={"login": name, "password": "test-password"})
    assert response.status_code == 200, response.text
    return {"X-CSRF-Token": client.cookies["csrf"]}


def event(kind: str, payload: dict, event_id: UUID | None = None) -> dict:
    return {
        "client_event_id": str(event_id or uuid4()),
        "client_ts": datetime.now(UTC).isoformat(),
        "type": kind,
        "payload": payload,
    }


def run_db(url: str, action):
    async def run():
        database = Database(url)
        try:
            async with database.sessions.begin() as db:
                return await action(db)
        finally:
            await database.close()

    return asyncio.run(run())


def wav_bytes() -> bytes:
    """Полсекунды тишины — валидный WAV, который декодирует ffmpeg (transcode_audio)."""
    buffer = BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(8000)
        handle.writeframes(b"\x00\x00" * 4000)
    return buffer.getvalue()


def make_ended_call(
    client: TestClient, headers: dict[str, str], database_url: str
) -> tuple[UUID, dict[str, str]]:
    """Занятие → назначение → карточка → звонок в статусе ended, минимально для теста.

    Логинится под teacher, затем переключает ту же сессию TestClient на trainee01
    (повторный login просто заменяет cookie сессии) — так не нужен второй экземпляр приложения.
    """
    users = {item["login"]: item for item in client.get("/api/users").json()}
    trainee = users["trainee01"]
    settings = client.get("/api/settings").json()
    scenario = next(
        item for item in client.get("/api/scenarios").json() if item["status"] == "approved"
    )
    session_body = {
        "title": f"STT-01 {uuid4().hex[:8]}",
        "participants": [
            {
                "user_id": trainee["id"],
                "workstation_number": 1,
                "dds_service_id": "102",
                "level": 1,
            }
        ],
        "settings_snapshot": settings,
    }
    session_id = client.post("/api/sessions", json=session_body, headers=headers).json()["id"]
    assignment_id = client.post(
        f"/api/sessions/{session_id}/assignments",
        json={
            "participant_id": trainee["id"],
            "scenario_id": scenario["id"],
            "order": 1,
            "planned_at": (datetime.now(UTC) + timedelta(seconds=1)).isoformat(),
        },
        headers=headers,
    ).json()["id"]
    assert client.post(f"/api/sessions/{session_id}/start", headers=headers).status_code == 200

    card_id = uuid4()

    async def insert_card(db):
        assignment = await db.get(Assignment, UUID(assignment_id))
        db.add(
            Card(
                id=card_id,
                assignment_id=assignment.id,
                number=scenario["card"]["number"],
                state="added",
                appeared_at=datetime.now(UTC),
                delivered_at=None,
                opened_at=None,
                first_status_at=None,
                closed_at=None,
                current={"service_number": "", "comment": ""},
                redirected_to_service_id=None,
            )
        )

    run_db(database_url, insert_card)

    trainee_headers = login(client, "trainee01")
    for body in [
        event("deliver", {}),
        event("open", {}),
    ]:
        assert (
            client.post(
                f"/api/cards/{card_id}/events", json=body, headers=trainee_headers
            ).status_code
            == 200
        )

    call_id = uuid4()
    for body in [
        event("call_dial", {"call_id": str(call_id), "phone_ext": "102"}),
        event("call_answer", {"call_id": str(call_id)}),
        event("call_hangup", {"call_id": str(call_id)}),
    ]:
        response = client.post(f"/api/cards/{card_id}/events", json=body, headers=trainee_headers)
        assert response.status_code == 200, response.text
    return call_id, trainee_headers


async def claim_by_key(worker: Worker, idempotency_key: str) -> ClaimedJob:
    """БД в тестах общая на модуль: обычный claim() мог бы забрать чужой pending job."""
    async with worker.database.sessions.begin() as db:
        row = await db.scalar(
            select(Job).where(Job.idempotency_key == idempotency_key).with_for_update()
        )
        assert row is not None
        row.status, row.locked_by, row.locked_at = "running", worker.worker_id, datetime.now(UTC)
        return ClaimedJob(id=row.id, kind=row.kind, payload=row.payload, attempts=row.attempts)


class FakeSTT:
    name = "fake:test"

    def __init__(self, text: str) -> None:
        self.text = text
        self.calls = 0

    async def transcribe(self, path: Path) -> str:
        self.calls += 1
        assert path.is_file()
        return self.text


def test_transcribe_job_enqueued_only_when_stt_enabled(database_config, database_url):
    off_config = database_config.model_copy(update={"stt_provider": "off"})
    with TestClient(create_database_app(off_config)) as client:
        headers = login(client)
        call_id, trainee_headers = make_ended_call(client, headers, database_url)
        uploaded = client.post(
            f"/api/calls/{call_id}/audio",
            files={"audio": ("report.wav", wav_bytes(), "audio/wav")},
            headers=trainee_headers,
        )
        assert uploaded.status_code == 200, uploaded.text

    async def no_job(db):
        return await db.scalar(select(Job).where(Job.idempotency_key == f"transcribe:{call_id}:1"))

    assert run_db(database_url, no_job) is None

    local_config = database_config.model_copy(update={"stt_provider": "local"})
    with TestClient(create_database_app(local_config)) as client:
        headers = login(client)
        call_id, trainee_headers = make_ended_call(client, headers, database_url)
        uploaded = client.post(
            f"/api/calls/{call_id}/audio",
            files={"audio": ("report.wav", wav_bytes(), "audio/wav")},
            headers=trainee_headers,
        )
        assert uploaded.status_code == 200, uploaded.text

    async def job(db):
        return await db.scalar(select(Job).where(Job.idempotency_key == f"transcribe:{call_id}:1"))

    row = run_db(database_url, job)
    assert row is not None
    assert row.kind == "transcribe"
    assert row.payload == {"call_id": str(call_id)}


async def copy_transcode(source: Path, output_dir: Path, call_id: UUID) -> tuple[Path, Path]:
    """Замена transcode_audio без ffmpeg: те же имена файлов, содержимое — исходная запись."""
    output_dir.mkdir(parents=True, exist_ok=True)
    wav, mp3 = output_dir / f"{call_id}.pcm.wav", output_dir / f"{call_id}.mp3"
    shutil.copyfile(source, wav)
    shutil.copyfile(source, mp3)
    return wav, mp3


def test_transcribe_job_saves_transcript_with_fake_provider(
    database_config, database_url, tmp_path, monkeypatch
):
    if shutil.which("ffmpeg") is None:
        # Тест — про задание распознавания, а не про ffmpeg: он есть в образе worker
        # (apps/api/Dockerfile) и в CI, там перекодирование проверяется по-настоящему.
        monkeypatch.setattr(handlers, "transcode_audio", copy_transcode)
    config = database_config.model_copy(update={"audio_dir": tmp_path, "stt_provider": "local"})
    with TestClient(create_database_app(config)) as client:
        headers = login(client)
        call_id, trainee_headers = make_ended_call(client, headers, database_url)
        uploaded = client.post(
            f"/api/calls/{call_id}/audio",
            files={"audio": ("report.wav", wav_bytes(), "audio/wav")},
            headers=trainee_headers,
        )
        assert uploaded.status_code == 200, uploaded.text

    async def check():
        worker = Worker(config, worker_id="worker-stt-test")
        fake = FakeSTT("выезд бригады, работаем на месте")
        worker.handlers.stt = fake
        try:
            claimed = await claim_by_key(worker, f"transcribe:{call_id}:1")
            assert await worker.process(claimed)
            async with worker.database.sessions() as db:
                row = await db.get(Job, claimed.id)
                assert row.status == "done"
                assert row.result == {
                    "call_id": str(call_id),
                    "transcript": fake.text,
                    "provider": "fake:test",
                }
                call = await db.get(Call, call_id)
                assert call.transcript == fake.text
                assert call.audio_path.endswith(f"{call_id}.mp3")
            assert fake.calls == 1
        finally:
            await worker.close()

    asyncio.run(check())


def test_local_faster_whisper_provider_calls_transcribe_endpoint(tmp_path):
    calls = []

    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        assert request.url == "http://stt.test/transcribe"
        return httpx.Response(200, json={"text": "выезд на дубнинскую улицу дом один"})

    provider = LocalFasterWhisperSTT(
        base_url="http://stt.test",
        timeout_seconds=1,
        transport=httpx.MockTransport(handle),
    )
    wav = tmp_path / "call.wav"
    wav.write_bytes(wav_bytes())
    text = asyncio.run(provider.transcribe(wav))
    assert text == "выезд на дубнинскую улицу дом один"
    assert len(calls) == 1


def test_local_faster_whisper_provider_falls_back_on_error(tmp_path):
    def handle(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"detail": "model unavailable"})

    provider = LocalFasterWhisperSTT(
        base_url="http://stt.test",
        timeout_seconds=1,
        transport=httpx.MockTransport(handle),
    )
    wav = tmp_path / "call.wav"
    wav.write_bytes(wav_bytes())
    assert asyncio.run(provider.transcribe(wav)) == ""
