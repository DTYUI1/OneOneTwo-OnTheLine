"""Сообщения об ошибках (28.09): отправляет любая роль, читает администратор."""

from uuid import UUID

from app.core.contracts import validate_json
from app.core.models import AuditLog
from sqlalchemy import select

from .test_database import csrf, login, run_db

REPORT = {
    "category": "bug",
    "text": "  Кнопка «Направить выбранные» не нажимается.  ",
    "page": "/app/arm",
}


def test_every_role_reports_and_only_admin_reads(database_client, database_url):
    client = database_client
    sent = {}
    for name in ("trainee01", "teacher", "admin"):
        login(client, name)
        response = client.post("/api/problem-reports", json=REPORT, headers=csrf(client))
        assert response.status_code == 201, response.text
        validate_json(response.json(), "urn:openapi#/components/schemas/ProblemReport")
        sent[name] = response.json()
    # Роль и автор — из сессии, текст — без пробелов по краям.
    assert sent["trainee01"]["author_role"] == "trainee"
    assert sent["teacher"]["author_role"] == "teacher"
    assert sent["trainee01"]["text"] == "Кнопка «Направить выбранные» не нажимается."

    for name in ("trainee01", "teacher"):
        login(client, name)
        assert client.get("/api/problem-reports").status_code == 403

    login(client, "admin")
    listed = client.get("/api/problem-reports")
    assert listed.status_code == 200, listed.text
    ids = [item["id"] for item in listed.json()]
    # Свежие сверху.
    assert ids[:3] == [sent["admin"]["id"], sent["teacher"]["id"], sent["trainee01"]["id"]]
    for item in listed.json():
        validate_json(item, "urn:openapi#/components/schemas/ProblemReport")

    async def audit(db):
        return await db.scalar(
            select(AuditLog).where(AuditLog.entity_id == sent["trainee01"]["id"])
        )

    # В журнал аудита — факт и категория, без текста сообщения.
    record = run_db(database_url, audit)
    assert record.action == "createProblemReport"
    assert record.entity == "problem_report"
    assert record.after == {"category": "bug", "page": "/app/arm"}
    assert UUID(record.entity_id)


def test_report_requires_text_category_and_csrf(database_client):
    client = database_client
    login(client, "trainee01")
    headers = csrf(client)
    for body in (
        {**REPORT, "text": "   "},
        {**REPORT, "text": "а" * 2001},
        {**REPORT, "category": "urgent"},
        {**REPORT, "extra": True},
        {"category": "bug", "page": "/app/arm"},
    ):
        response = client.post("/api/problem-reports", json=body, headers=headers)
        assert response.status_code == 422, (body, response.text)
    assert client.post("/api/problem-reports", json=REPORT).status_code == 403
    client.cookies.clear()
    assert client.post("/api/problem-reports", json=REPORT).status_code == 401
