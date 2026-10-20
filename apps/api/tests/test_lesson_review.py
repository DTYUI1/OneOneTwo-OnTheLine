"""TC-13: итоги занятия — обоснование правки оценки, CSV для Excel, отзыв и выдача отчёта."""
# ruff: noqa: F401, F811

import csv
import io
from uuid import uuid4

from app.api.database import create_database_app
from app.core.models import Evaluation, TeacherOverride
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from .test_evaluations import (
    close_card,
    evaluation_case,
    evaluation_id,
    login,
    rules_unavailable,
    run_db,
)


def enrich(database_url, found_id):
    async def action(db):
        evaluation = await db.get(Evaluation, found_id)
        evaluation.rules_scores = {"routing": 0.25, "address": 0.75}
        evaluation.explanation = {"routing": "Ошибка службы.", "address": "Адрес неполный."}
        evaluation.total = 0.5

    run_db(database_url, action)


def test_override_without_reason_is_not_saved(
    database_config, database_url, evaluation_case, rules_unavailable
):
    close_card(database_config, evaluation_case["card_id"])
    found_id = evaluation_id(database_url, evaluation_case["card_id"])
    body = {
        "evaluation_id": str(found_id),
        "decision": "disagree",
        "new_total": 0.75,
        "teacher_comment": "",
    }
    with TestClient(create_database_app(database_config)) as teacher:
        headers = login(teacher)
        for reason in ("", "   ", "\n\t"):
            response = teacher.post(
                "/api/overrides", json={**body, "reason": reason}, headers=headers
            )
            assert response.status_code == 422, response.text
        assert teacher.post("/api/overrides", json=body, headers=headers).status_code == 422
        assert teacher.get(f"/api/evaluations/{found_id}").json()["total"] == 0

        async def count(db):
            return await db.scalar(
                select(func.count())
                .select_from(TeacherOverride)
                .where(TeacherOverride.evaluation_id == found_id)
            )

        assert run_db(database_url, count) == 0
        ok = teacher.post(
            "/api/overrides", json={**body, "reason": "  Решение верное  "}, headers=headers
        )
        assert ok.status_code == 201, ok.text
        assert ok.json()["total"] == 0.75


def test_csv_opens_in_excel_with_cyrillic(
    database_config, database_url, evaluation_case, rules_unavailable
):
    close_card(database_config, evaluation_case["card_id"])
    enrich(database_url, evaluation_id(database_url, evaluation_case["card_id"]))
    with TestClient(create_database_app(database_config)) as teacher:
        login(teacher)
        exported = teacher.get(f"/api/reports/session/{evaluation_case['session_id']}/csv")
    assert exported.status_code == 200
    assert exported.headers["content-type"].startswith("text/csv")
    raw = exported.content
    # Excel узнаёт UTF-8 только по BOM, а русскую локаль — по «;» как разделителю.
    assert raw.startswith(b"\xef\xbb\xbf")
    assert b"\r\n" in raw
    rows = list(csv.reader(io.StringIO(raw.decode("utf-8-sig")), delimiter=";"))
    assert rows[0] == [
        "ФИО",
        "АРМ",
        "Балл",
        "Время реакции, с",
        "Время обработки, с",
        "Ошибки",
        "Уровень",
    ]
    assert rows[1][0] == "Иванов Дмитрий Сергеевич"
    assert all(len(row) == 7 for row in rows)


def test_review_draft_edit_release(
    database_config, database_url, evaluation_case, rules_unavailable
):
    close_card(database_config, evaluation_case["card_id"])
    found_id = evaluation_id(database_url, evaluation_case["card_id"])
    enrich(database_url, found_id)
    session_id = evaluation_case["session_id"]
    with TestClient(create_database_app(database_config)) as teacher:
        headers = login(teacher)
        assert (
            teacher.post(
                "/api/overrides",
                json={
                    "evaluation_id": str(found_id),
                    "decision": "disagree",
                    "new_total": 0.75,
                    "reason": "Проверено",
                    "teacher_comment": "",
                },
                headers=headers,
            ).status_code
            == 201
        )
        review = teacher.get(f"/api/sessions/{session_id}/review")
        assert review.status_code == 200, review.text
        item = review.json()["trainees"][0]
        assert (item["ai_total"], item["final_total"]) == (0.5, 0.75)
        assert "маршрутизация по службам" in item["draft"]
        assert item["text"] is None and item["released_at"] is None
        # Провал у единственного ученика — это 100 % группы, больше порога в 30 %.
        heat = review.json()["heatmap"]
        assert heat["criteria"] == ["address", "routing"]
        assert heat["rows"][0]["cells"] == {"address": 0.75, "routing": 0.25}
        assert len(heat["advice"]) == 1 and "маршрутизация по службам" in heat["advice"][0]
        user_id = item["user_id"]
        # Черновик «было» не меняется от повторного чтения.
        again = teacher.get(f"/api/sessions/{session_id}/review").json()["trainees"][0]
        assert again["draft"] == item["draft"]
        assert (
            teacher.put(
                f"/api/sessions/{session_id}/feedback/{user_id}",
                json={"text": "  "},
                headers=headers,
            ).status_code
            == 422
        )
        assert (
            teacher.put(
                f"/api/sessions/{session_id}/feedback/{uuid4()}",
                json={"text": "Текст"},
                headers=headers,
            ).status_code
            == 422
        )
        edited = teacher.put(
            f"/api/sessions/{session_id}/feedback/{user_id}",
            json={"text": "Хорошая работа, повторите маршрутизацию."},
            headers=headers,
        )
        assert edited.status_code == 200, edited.text
        assert edited.json()["draft"] == item["draft"]
    with TestClient(create_database_app(database_config)) as trainee:
        login(trainee, "trainee01")
        assert trainee.get("/api/feedback").json() == []
        assert trainee.get(f"/api/sessions/{session_id}/review").status_code == 403
    with TestClient(create_database_app(database_config)) as teacher:
        headers = login(teacher)
        released = teacher.post(f"/api/sessions/{session_id}/feedback/release", headers=headers)
        assert released.json() == {"released": 1}
        assert teacher.post(
            f"/api/sessions/{session_id}/feedback/release", headers=headers
        ).json() == {"released": 0}
        assert (
            teacher.put(
                f"/api/sessions/{session_id}/feedback/{user_id}",
                json={"text": "Поздно"},
                headers=headers,
            ).status_code
            == 409
        )
    with TestClient(create_database_app(database_config)) as trainee:
        login(trainee, "trainee01")
        own = trainee.get("/api/feedback").json()
        assert [row["text"] for row in own] == ["Хорошая работа, повторите маршрутизацию."]
        assert own[0]["session_id"] == str(session_id)
    with TestClient(create_database_app(database_config)) as other:
        headers = login(other, "teacher")
        assert other.get(f"/api/sessions/{uuid4()}/review").status_code == 404
