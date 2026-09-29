"""Грамотность и ключевые сведения комментария (28.09): словарь, оценка, подсказки в АРМ."""

from uuid import UUID

from app.api.database import create_database_app
from app.core.models import AuditLog, Session
from app.core.spelling import RussianChecker
from evalcore.defaults import COMMENT_CRITERIA, CRITERIA
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from . import test_evaluations as t9

evaluation_case = t9.evaluation_case
COMMENT = "ДТП на Дубнинской улце д.1, пострадвших двое, направлна бригада. Иванов на месте."


def test_checker_finds_typos_and_skips_names_abbreviations_and_places():
    checker = RussianChecker(["Дубнинская улица"])
    issues = checker.check(COMMENT)
    assert [(item.word, item.suggestions[0]) for item in issues] == [
        ("улце", "улице"),
        ("пострадвших", "пострадавших"),
        ("направлна", "направлена"),
    ]
    assert issues[0].start == COMMENT.index("улце")
    # Улица сценария, сокращения, словарь 112 и слитное написание.
    assert checker.check("на дубнинской ул. ГИБДД, Росгвардия, спецтранспорта нет") == []
    assert checker.check("Мужчина отказалсяот помощи")[0].suggestions[0] == "отказался от"
    # Похожая улица не подсказывается вместо улицы сценария.
    assert RussianChecker().check("дубнинская")[0].word == "дубнинская"


def close_with_comment(database_config, card_id: UUID, comment: str) -> None:
    event = t9.terminal_event()
    event["payload"]["comment"] = comment
    t9.close_card(database_config, card_id, event)


def test_evaluation_scores_spelling_and_key_facts(database_config, database_url, evaluation_case):
    close_with_comment(database_config, evaluation_case["card_id"], COMMENT)
    found_id = t9.evaluation_id(database_url, evaluation_case["card_id"])
    with TestClient(create_database_app(database_config)) as teacher:
        t9.login(teacher)
        evaluation = teacher.get(f"/api/evaluations/{found_id}").json()
        analysis = teacher.get(f"/api/cards/{evaluation_case['card_id']}/analysis").json()
    criteria = {item["key"]: item for item in evaluation["criteria"]}
    assert set(criteria) == {*CRITERIA, *COMMENT_CRITERIA}
    spelling = criteria["spelling"]
    assert spelling["score"] == 0.25
    assert "«улце» → «улице»" in spelling["evidence"]
    keywords = criteria["comment_keywords"]
    assert keywords["evidence"][1] == "Не хватает: нет", keywords["evidence"]
    grammar = next(item for item in analysis["evaluation"]["layers"] if item["layer"] == "grammar")
    assert grammar["status"] == "done"
    errors = analysis["evaluation"]["errors"]
    assert errors["grammar"] == 3
    assert errors["input"] == errors["address"] + 3


def test_hints_only_in_lessons_with_the_checkbox(database_config, database_url, evaluation_case):
    card_id = str(evaluation_case["card_id"])
    with TestClient(create_database_app(database_config)) as trainee:
        headers = t9.login(trainee, "trainee01")
        off = trainee.post(
            "/api/spelling/check", json={"text": "улца", "card_id": card_id}, headers=headers
        )
        assert off.status_code == 409
        assert off.json()["code"] == "spelling_hints_off"
        assert (
            trainee.post("/api/spelling/check", json={"text": "улца"}, headers=headers).status_code
            == 409
        )

    async def enable(db):
        lesson = await db.get(Session, evaluation_case["session_id"])
        lesson.settings_snapshot = {**lesson.settings_snapshot, "spelling_hints": True}

    t9.run_db(database_url, enable)
    text = "🚑 ДТП на Дубнинской улце"
    with TestClient(create_database_app(database_config)) as trainee:
        headers = t9.login(trainee, "trainee01")
        response = trainee.post(
            "/api/spelling/check", json={"text": text, "card_id": card_id}, headers=headers
        )
        other = t9.login(trainee, "trainee02")
        foreign = trainee.post(
            "/api/spelling/check", json={"text": text, "card_id": card_id}, headers=other
        )
    assert response.status_code == 200, response.text
    [issue] = response.json()["issues"]
    # Позиции — в единицах UTF-16, как их считает JavaScript (эмодзи — две единицы).
    assert (issue["start"], issue["end"], issue["word"]) == (21, 25, "улце")
    assert issue["suggestions"][0] == "улице"
    assert text.encode("utf-16-le")[42:50].decode("utf-16-le") == "улце"
    assert foreign.status_code == 404

    with TestClient(create_database_app(database_config)) as teacher:
        headers = t9.login(teacher)
        studio = teacher.post("/api/spelling/check", json={"text": "бригда"}, headers=headers)
    assert studio.json()["issues"][0]["suggestions"][0] == "бригада"

    async def audited(db):
        return await db.scalar(
            select(func.count()).select_from(AuditLog).where(AuditLog.action == "checkSpelling")
        )

    assert t9.run_db(database_url, audited) == 0
