"""T-008: занятие, назначения, карточная state machine, звонки и realtime."""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from app.api.database import create_database_app
from app.core.contracts import validate_json
from app.core.db import Database
from app.core.models import Assignment, AuditLog, Card, Job, Participant
from fastapi.testclient import TestClient
from sqlalchemy import func, select


def login(client: TestClient, name: str = "teacher") -> dict[str, str]:
    response = client.post("/api/auth/login", json={"login": name, "password": "test-password"})
    assert response.status_code == 200, response.text
    return {"X-CSRF-Token": client.cookies["csrf"]}


def run_db(url: str, action):
    async def run():
        database = Database(url)
        try:
            async with database.sessions.begin() as db:
                return await action(db)
        finally:
            await database.close()

    return asyncio.run(run())


def event(kind: str, payload: dict, event_id: UUID | None = None) -> dict:
    return {
        "client_event_id": str(event_id or uuid4()),
        "client_ts": datetime.now(UTC).isoformat(),
        "type": kind,
        "payload": payload,
    }


def test_pack_job_validation_persistence_and_access(database_config):
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        body = {"count": 10, "level": 2, "service_id": "102", "seed": 42}
        assert client.post("/api/packs/generate", json=body).status_code == 403
        invalid = client.post(
            "/api/packs/generate", json={**body, "service_id": "unknown"}, headers=headers
        )
        assert invalid.status_code == 422
        response = client.post("/api/packs/generate", json=body, headers=headers)
        assert response.status_code == 202, response.text
        validate_json(response.json(), "urn:openapi#/components/schemas/Job")
        job_id = response.json()["id"]
        assert client.get(f"/api/jobs/{job_id}").json() == response.json()
        assert client.get(f"/api/jobs/{uuid4()}").status_code == 404

    async def verify_legacy_payload(db):
        job = await db.get(Job, UUID(job_id))
        pack_id = job.payload["pack_id"]
        assert UUID(pack_id)
        assert job.payload == {"pack_id": pack_id, **body}
        assert job.idempotency_key == f"generate:{pack_id}:1"

    run_db(database_config.database_url, verify_legacy_payload)

    with TestClient(create_database_app(database_config)) as restarted:
        login(restarted)
        assert restarted.get(f"/api/jobs/{job_id}").status_code == 200


def test_complete_session_card_call_ws_and_audio(database_config, database_url, tmp_path):
    config = database_config.model_copy(update={"audio_dir": tmp_path})
    with TestClient(create_database_app(config)) as client:
        headers = login(client)
        users = {item["login"]: item for item in client.get("/api/users").json()}
        trainee = users["trainee01"]
        settings = client.get("/api/settings").json()
        scenario = next(
            item for item in client.get("/api/scenarios").json() if item["status"] == "approved"
        )
        participant = {
            "user_id": trainee["id"],
            "workstation_number": 1,
            "dds_service_id": "102",
            "level": 1,
        }
        session_body = {
            "title": "Интеграционное занятие T-008",
            "participants": [participant],
            "settings_snapshot": settings,
        }
        duplicate_participants = client.post(
            "/api/sessions",
            json={**session_body, "participants": [participant, participant]},
            headers=headers,
        )
        assert duplicate_participants.status_code == 409
        invalid_level = client.post(
            "/api/sessions",
            json={**session_body, "participants": [{**participant, "level": 5}]},
            headers=headers,
        )
        assert invalid_level.status_code == 422
        errors = invalid_level.json()["details"]["errors"]
        assert any("level" in error["field"] for error in errors)
        created = client.post("/api/sessions", json=session_body, headers=headers)
        assert created.status_code == 201, created.text
        validate_json(created.json(), "urn:openapi#/components/schemas/Session")
        session_id = created.json()["id"]
        assert created.json()["teacher_id"] == users["teacher"]["id"]
        assert client.post(f"/api/sessions/{session_id}/start", headers=headers).status_code == 409

        assignment_body = {
            "participant_id": trainee["id"],
            "scenario_id": scenario["id"],
            "order": 1,
            "planned_at": (datetime.now(UTC) + timedelta(seconds=1)).isoformat(),
        }
        assigned = client.post(
            f"/api/sessions/{session_id}/assignments",
            json=assignment_body,
            headers=headers,
        )
        assert assigned.status_code == 201, assigned.text
        validate_json(assigned.json(), "urn:openapi#/components/schemas/Assignment")
        assignment_id = assigned.json()["id"]

        async def pinned(db):
            return (await db.get(Assignment, UUID(assignment_id))).scenario_version

        # Версия сценария закреплена сразу, как в пакетной раздаче (28.09).
        assert run_db(database_url, pinned) == scenario["version"]
        assert (
            client.post(
                f"/api/sessions/{session_id}/assignments",
                json={**assignment_body, "scenario_id": scenario["id"]},
                headers=headers,
            ).status_code
            == 409
        )
        started = client.post(f"/api/sessions/{session_id}/start", headers=headers)
        assert started.status_code == 200, started.text
        assert started.json()["status"] == "running"
        assert client.post(f"/api/sessions/{session_id}/start", headers=headers).status_code == 409

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

        with TestClient(create_database_app(config)) as trainee_client:
            trainee_headers = login(trainee_client, "trainee01")
            cards = trainee_client.get("/api/cards")
            assert cards.status_code == 200
            target_card = next(item for item in cards.json() if item["id"] == str(card_id))
            validate_json(target_card, "urn:openapi#/components/schemas/Card")
            with trainee_client.websocket_connect(
                "/ws", headers={"origin": "http://testserver"}
            ) as socket:
                snapshot = socket.receive_json()
                assert snapshot["type"] == "snapshot"
                assert str(card_id) in {item["id"] for item in snapshot["payload"]["cards"]}
                socket.send_json({"type": "clock.ping", "client_ts": datetime.now(UTC).isoformat()})
                messages = [socket.receive_json(), socket.receive_json()]
                assert "clock.pong" in {message["type"] for message in messages}
                deliver_id = uuid4()
                delivered_body = event("deliver", {}, deliver_id)
                delivered = trainee_client.post(
                    f"/api/cards/{card_id}/events",
                    json=delivered_body,
                    headers=trainee_headers,
                )
                assert delivered.status_code == 200, delivered.text
                assert delivered.json()["card"]["state"] == "received"
                pushed = socket.receive_json()
                assert pushed["type"] == "card.updated"
                assert pushed["payload"]["state"] == "received"

            repeated = trainee_client.post(
                f"/api/cards/{card_id}/events", json=delivered_body, headers=trainee_headers
            )
            assert repeated.status_code == 200 and repeated.json()["duplicate"] is True
            conflict = trainee_client.post(
                f"/api/cards/{card_id}/events",
                json={**delivered_body, "type": "open"},
                headers=trainee_headers,
            )
            assert conflict.status_code == 409
            assert (
                trainee_client.post(
                    f"/api/cards/{card_id}/events",
                    json=event("status_change", {"state": "completed", "comment": "рано"}),
                    headers=trainee_headers,
                ).status_code
                == 409
            )
            for body in [
                event("open", {}),
                event("field_change", {"field": "service_number", "value": "77-01"}),
                event("status_change", {"state": "accepted", "comment": "Принято"}),
            ]:
                response = trainee_client.post(
                    f"/api/cards/{card_id}/events", json=body, headers=trainee_headers
                )
                assert response.status_code == 200, response.text

            call_id = uuid4()
            for body, expected in [
                (event("call_dial", {"call_id": str(call_id), "phone_ext": "102"}), "dialing"),
                (event("call_answer", {"call_id": str(call_id)}), "talking"),
                (event("call_hangup", {"call_id": str(call_id)}), "ended"),
            ]:
                response = trainee_client.post(
                    f"/api/cards/{card_id}/events", json=body, headers=trainee_headers
                )
                assert response.status_code == 200, response.text
                assert trainee_client.get(f"/api/calls/{call_id}").json()["state"] == expected
            # MediaRecorder в браузере отдаёт media type с параметрами (T-014).
            for browser_type in ["audio/webm;codecs=opus", "audio/ogg; codecs=opus"]:
                browser_upload = trainee_client.post(
                    f"/api/calls/{call_id}/audio",
                    files={"audio": ("report", b"\x1aE\xdf\xa3-test", browser_type)},
                    headers=trainee_headers,
                )
                assert browser_upload.status_code == 200, browser_upload.text
            unsupported = trainee_client.post(
                f"/api/calls/{call_id}/audio",
                files={"audio": ("report.mp3", b"ID3-test", "audio/mpeg")},
                headers=trainee_headers,
            )
            assert unsupported.status_code == 422, unsupported.text
            uploaded = trainee_client.post(
                f"/api/calls/{call_id}/audio",
                files={"audio": ("report.wav", b"RIFF-test-audio", "audio/wav")},
                headers=trainee_headers,
            )
            assert uploaded.status_code == 200, uploaded.text
            assert uploaded.json()["audio_url"] == f"/api/calls/{call_id}/audio"
            assert (tmp_path / f"{call_id}.wav").read_bytes() == b"RIFF-test-audio"
            downloaded = trainee_client.get(uploaded.json()["audio_url"])
            assert downloaded.status_code == 200
            assert downloaded.content == b"RIFF-test-audio"
            assert downloaded.headers["content-type"] == "audio/wav"

            for body in [
                event("status_change", {"state": "responding", "comment": "Реагирование"}),
                event("status_change", {"state": "completed", "comment": "Завершено"}),
            ]:
                response = trainee_client.post(
                    f"/api/cards/{card_id}/events", json=body, headers=trainee_headers
                )
                assert response.status_code == 200, response.text
            final_card = trainee_client.get(f"/api/cards/{card_id}").json()
            assert final_card["state"] == "completed"
            assert final_card["current"]["service_number"] == "77-01"
            assert len(trainee_client.get(f"/api/cards/{card_id}/events").json()) == 9

        with TestClient(create_database_app(config)) as other_client:
            login(other_client, "trainee02")
            assert other_client.get(f"/api/cards/{card_id}").status_code == 404
            lessons = other_client.get("/api/sessions").json()
            assert all(item["id"] != session_id for item in lessons)

        finished = client.post(f"/api/sessions/{session_id}/finish", headers=headers)
        assert finished.status_code == 200 and finished.json()["status"] == "finished"
        assert client.post(f"/api/sessions/{session_id}/finish", headers=headers).status_code == 409

    async def verify(db):
        participant_id = await db.scalar(
            select(Participant.id).where(Participant.session_id == UUID(session_id))
        )
        assignment = await db.get(Assignment, UUID(assignment_id))
        assert assignment.participant_id == participant_id
        assert assignment.status == "completed"
        assert (
            await db.scalar(
                select(func.count()).select_from(AuditLog).where(AuditLog.entity_id == session_id)
            )
            >= 3
        )

    run_db(database_url, verify)
