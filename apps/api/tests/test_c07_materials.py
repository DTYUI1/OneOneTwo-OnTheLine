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
        # Назначение материалов — только до начала занятия.
        assert client.post(path, json=late, headers=headers).status_code == 409

    async def immutable(db):
        with pytest.raises(Exception, match="immutable"):
            await db.execute(text("UPDATE materials SET title = 'x'"))

    run_db(database_url, immutable)
