"""C-07: учебные материалы — проверка файлов, версии, права reference/evaluation, назначение."""

import hashlib
import io
import json
import zipfile
from uuid import uuid4

import pytest
from app.api.database import create_database_app
from app.core.contracts import validate_json
from fastapi.testclient import TestClient
from sqlalchemy import text

from .test_lifecycle import login, run_db

PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def docx(extra: dict[str, bytes] | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", "<w:document/>")
        for name, value in (extra or {}).items():
            archive.writestr(name, value)
    return buffer.getvalue()


def meta(title="Памятка ДДС", purpose="reference", previous=None):
    return {
        "title": title,
        "purpose": purpose,
        "previous_id": previous[0] if previous else None,
        "previous_version": previous[1] if previous else None,
    }


def upload(client, headers, content, media, metadata, expected=201):
    response = client.post(
        "/api/materials",
        files={
            "file": ("upload.bin", content, media),
            "metadata": (None, json.dumps(metadata, ensure_ascii=False), "application/json"),
        },
        headers=headers,
    )
    assert response.status_code == expected, response.text
    if expected == 201:
        validate_json(response.json(), "urn:openapi#/components/schemas/Material")
    return response.json()


@pytest.fixture
def config(database_config, tmp_path):
    return database_config.model_copy(update={"materials_dir": tmp_path})


def draft_session(client, headers, trainee_login="trainee01"):
    users = {u["login"]: u for u in client.get("/api/users").json()}
    return client.post(
        "/api/sessions",
        json={
            "title": "Справка к занятию",
            "participants": [
                {
                    "user_id": users[trainee_login]["id"],
                    "workstation_number": 1,
                    "dds_service_id": users[trainee_login]["dds_service_id"] or "102",
                    "level": 1,
                }
            ],
            "settings_snapshot": client.get("/api/settings").json(),
        },
        headers=headers,
    ).json()


def test_upload_checks_content_type_and_versions(config):
    with TestClient(create_database_app(config)) as client:
        headers = login(client)
        first = upload(client, headers, PDF, "application/pdf", meta())
        assert first["version"] == 1 and first["sha256"] == hashlib.sha256(PDF).hexdigest()
        second = upload(
            client,
            headers,
            docx(),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            meta(previous=(first["id"], 1)),
        )
        assert (second["id"], second["version"]) == (first["id"], 2)
        # Устаревшая версия — конфликт, а не перезапись.
        upload(client, headers, PDF, "application/pdf", meta(previous=(first["id"], 1)), 409)
        upload(client, headers, PDF, "application/pdf", meta(previous=(str(uuid4()), 1)), 404)
        for content, media, code in [
            (b'{"a": 1}', "application/pdf", 415),
            (
                b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>',
                "application/xml",
                415,
            ),
            (
                docx({"word/vbaProject.bin": b"macro"}),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                415,
            ),
            (b"", "application/pdf", 422),
            (b"%PDF-" + b"0" * (10 * 1024 * 1024), "application/pdf", 413),
        ]:
            upload(client, headers, content, media, meta(), code)
        upload(client, headers, b"<root><item/></root>", "application/xml", meta("XML"))
        upload(client, headers, "поле;значение\nадрес;улица\n".encode(), "text/csv", meta("CSV"))
        catalog = client.get("/api/materials").json()
        assert [(m["id"], m["version"]) for m in catalog if m["id"] == first["id"]] == [
            (first["id"], 1),
            (first["id"], 2),
        ]
        admin = login(client, "admin")
        assert client.get("/api/materials").status_code == 403
        assert client.post("/api/materials", headers=admin).status_code in (403, 422)


def test_assignment_and_trainee_access(config, database_url):
    with TestClient(create_database_app(config)) as client:
        headers = login(client)
        reference = upload(client, headers, PDF, "application/pdf", meta("Справка"))
        evaluation = upload(
            client, headers, PDF, "application/pdf", meta("Критерии", purpose="evaluation")
        )
        lesson = draft_session(client, headers)
        body = {
            "request_id": str(uuid4()),
            "materials": [{"material_id": reference["id"], "version": 1}],
        }
        path = f"/api/sessions/{lesson['id']}/materials"
        assigned = client.post(path, json=body, headers=headers)
        assert assigned.status_code == 200, assigned.text
        assert [m["purpose"] for m in assigned.json()] == ["reference"]
        assert client.post(path, json=body, headers=headers).json() == assigned.json()
        other = {**body, "materials": [{"material_id": evaluation["id"], "version": 1}]}
        assert client.post(path, json=other, headers=headers).status_code == 409
        wrong = {**other, "request_id": str(uuid4())}
        assert client.post(path, json=wrong, headers=headers).status_code == 422
        missing = {
            **body,
            "request_id": str(uuid4()),
            "materials": [{"material_id": reference["id"], "version": 7}],
        }
        assert client.post(path, json=missing, headers=headers).status_code == 404

        trainee = login(client, "trainee01")
        catalog = client.get("/api/materials").json()
        assert [(m["id"], m["purpose"]) for m in catalog] == [(reference["id"], "reference")]
        content = client.get(f"/api/materials/{reference['id']}/content", params={"version": 1})
        assert content.status_code == 200 and content.content == PDF
        assert content.headers["cache-control"] == "private, no-store"
        assert content.headers["x-content-type-options"] == "nosniff"
        for material in (evaluation["id"], str(uuid4())):
            url = f"/api/materials/{material}/content"
            assert client.get(url, params={"version": 1}).status_code == 404
        assert trainee

        login(client, "trainee02")
        assert client.get("/api/materials").json() == []
        url = f"/api/materials/{reference['id']}/content"
        assert client.get(url, params={"version": 1}).status_code == 404

        headers = login(client)

        async def run_lesson(db):
            await db.execute(
                text("UPDATE sessions SET status = 'running' WHERE id = :id"),
                {"id": lesson["id"]},
            )

        run_db(database_url, run_lesson)
        late = {**body, "request_id": str(uuid4())}
        # Во время занятия преподаватель может добавить справку.
        assert client.post(path, json=late, headers=headers).status_code == 200

    async def immutable(db):
        with pytest.raises(Exception, match="immutable"):
            await db.execute(text("UPDATE materials SET title = 'x'"))

    run_db(database_url, immutable)


@pytest.mark.parametrize("encoding", ["utf-8", "utf-8-sig"])
def test_plain_text_download_and_assignment(config, encoding):
    content = "Памятка диспетчеру\nУточните адрес и номер телефона.\n".encode(encoding)
    with TestClient(create_database_app(config)) as client:
        headers = login(client)
        material = upload(client, headers, content, "text/plain", meta("Текстовая памятка"))
        path = f"/api/materials/{material['id']}/content?version=1"
        response = client.get(path)
        assert response.content == content
        assert response.headers["content-type"].startswith("text/plain")
        assert ".txt" in response.headers["content-disposition"]
        lesson = draft_session(client, headers)
        response = client.post(
            f"/api/sessions/{lesson['id']}/materials",
            json={
                "request_id": str(uuid4()),
                "materials": [{"material_id": material["id"], "version": 1}],
            },
            headers=headers,
        )
        assert response.status_code == 200
        login(client, "trainee01")
        assert client.get(path).content == content
        assert material in client.get("/api/materials").json()


@pytest.mark.parametrize(
    ("content", "media"),
    [
        ("Памятка".encode("cp1251"), "text/plain"),
        (b"text\x00binary", "text/plain"),
        (PDF, "text/plain"),
        (b"\x89PNG\r\n\x1a\n", "image/png"),
        (b"\xff\xd8\xff", "image/jpeg"),
    ],
)
def test_unsupported_material_explains_formats(config, content, media):
    with TestClient(create_database_app(config)) as client:
        result = upload(client, login(client), content, media, meta(), 415)
        assert "PDF, DOCX, TXT, JSON, XML и CSV" in result["message"]
        assert "UTF-8" in result["message"]


def test_materials_grouped_by_own_current_and_past_lessons(config, database_url):
    with TestClient(create_database_app(config)) as client:
        headers = login(client)
        old_file = upload(client, headers, PDF, "application/pdf", meta("Памятка, прежняя версия"))
        new_file = upload(
            client,
            headers,
            PDF,
            "application/pdf",
            meta("Памятка, новая версия", previous=(old_file["id"], 1)),
        )
        private = upload(
            client, headers, PDF, "application/pdf", meta("Не для обучаемого", "evaluation")
        )
        foreign_file = upload(client, headers, PDF, "application/pdf", meta("Чужая памятка"))
        past = draft_session(client, headers)
        current = draft_session(client, headers)
        foreign = draft_session(client, headers, "trainee02")
        future = draft_session(client, headers)
        for lesson, material in ((past, old_file), (current, new_file), (foreign, foreign_file)):
            response = client.post(
                f"/api/sessions/{lesson['id']}/materials",
                headers=headers,
                json={
                    "request_id": str(uuid4()),
                    "materials": [{"material_id": material["id"], "version": material["version"]}],
                },
            )
            assert response.status_code == 200

        async def prepare(db):
            for lesson, status in ((past, "finished"), (current, "running"), (foreign, "running")):
                await db.execute(
                    text("UPDATE sessions SET status=:status, started_at=now() WHERE id=:id"),
                    {"id": lesson["id"], "status": status},
                )
            # Даже испорченное назначение evaluation не должно попасть в ответ ученику.
            await db.execute(
                text(
                    "INSERT INTO session_materials(session_id,material_id,version) VALUES (:s,:m,1)"
                ),
                {"s": current["id"], "m": private["id"]},
            )

        run_db(database_url, prepare)
        login(client, "trainee01")
        response = client.get("/api/materials/by-session")
        assert response.status_code == 200, response.text
        groups = {item["session_id"]: item for item in response.json()}
        assert current["id"] in groups and past["id"] in groups
        assert foreign["id"] not in groups and future["id"] not in groups
        assert foreign_file["id"] not in response.text
        assert (
            client.get(f"/api/materials/{foreign_file['id']}/content?version=1").status_code == 404
        )
        for group in groups.values():
            validate_json(group, "urn:openapi#/components/schemas/SessionMaterials")
        assert groups[current["id"]]["is_current"] is True
        assert groups[current["id"]]["title"] == current["title"]
        assert groups[current["id"]]["date"]
        assert groups[current["id"]]["materials"] == [new_file]
        assert groups[past["id"]]["is_current"] is False
        assert groups[past["id"]]["materials"] == [old_file]
        assert client.get(f"/api/materials/{private['id']}/content?version=1").status_code == 404
        login(client, "admin")
        assert client.get("/api/materials/by-session").status_code == 403


def test_running_material_assignment_event_and_finished_rejection(
    config, database_url, monkeypatch
):
    from app.api.materials import service

    events = []
    real_notify = service.notify

    async def record(db, kind, entity_id):
        events.append((kind, str(entity_id)))
        await real_notify(db, kind, entity_id)

    monkeypatch.setattr(service, "notify", record)
    with (
        TestClient(create_database_app(config)) as teacher,
        TestClient(create_database_app(config)) as trainee,
    ):
        headers = login(teacher)
        material = upload(
            teacher, headers, PDF, "application/pdf", meta("Добавлено во время занятия")
        )
        lesson = draft_session(teacher, headers)

        async def running(db):
            await db.execute(
                text("UPDATE sessions SET status='running', started_at=now() WHERE id=:id"),
                {"id": lesson["id"]},
            )

        run_db(database_url, running)
        login(trainee, "trainee01")
        groups = trainee.get("/api/materials/by-session").json()
        assert (
            next(item for item in groups if item["session_id"] == lesson["id"])["materials"] == []
        )
        body = {
            "request_id": str(uuid4()),
            "materials": [{"material_id": material["id"], "version": 1}],
        }
        path = f"/api/sessions/{lesson['id']}/materials"
        with trainee.websocket_connect("/ws") as ws:
            while ws.receive_json()["type"] != "snapshot":
                pass
            assert teacher.post(path, json=body, headers=headers).status_code == 200
            while (event := ws.receive_json())["type"] != "session.materials_changed":
                pass
            validate_json(event, "urn:openapi#/components/schemas/WsServerEvent")
            assert event["payload"]["id"] == lesson["id"]
        assert teacher.post(path, json=body, headers=headers).status_code == 200
        assert (
            teacher.post(
                path, json={**body, "request_id": str(uuid4())}, headers=headers
            ).status_code
            == 200
        )
        assert events == [("session.materials_changed", lesson["id"])]

        async def finished(db):
            await db.execute(
                text("UPDATE sessions SET status='finished' WHERE id=:id"), {"id": lesson["id"]}
            )

        run_db(database_url, finished)
        assert (
            teacher.post(
                path, json={**body, "request_id": str(uuid4())}, headers=headers
            ).status_code
            == 409
        )
