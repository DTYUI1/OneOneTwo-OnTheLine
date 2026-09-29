"""C-06: разбор попытки и аналитика занятия по I-EVAL/I-TIME на PostgreSQL."""

from datetime import datetime, timedelta
from uuid import UUID

from app.api.database import create_database_app
from app.core.contracts import validate_json
from app.core.models import Card
from fastapi.testclient import TestClient

from .test_c03_sessions import batch, item, lesson, start, tick  # noqa: F401
from .test_lifecycle import event, login, run_db


def play(client, headers, card_id, states):
    for kind, payload in [("deliver", {}), ("open", {})] + [
        ("status_change", {"state": state, "comment": "Сведения внесены"}) for state in states
    ]:
        response = client.post(
            f"/api/cards/{card_id}/events", json=event(kind, payload), headers=headers
        )
        assert response.status_code == 200, response.text


def analysis(client, card_id, expected=200):
    response = client.get(f"/api/cards/{card_id}/analysis")
    assert response.status_code == expected, response.text
    if expected == 200:
        validate_json(response.json(), "urn:openapi#/components/schemas/AttemptAnalysis")
    return response.json()


def test_completed_attempt_v3_partial_and_access(lesson, database_config, database_url):  # noqa: F811
    batch(lesson, [item(lesson), item(lesson, participant=1)])
    start(lesson)
    tick(database_url)
    with TestClient(create_database_app(database_config)) as trainee:
        headers = login(trainee, "trainee01")
        card = next(c for c in trainee.get("/api/cards").json() if c["session_id"] == lesson.id)
        play(trainee, headers, card["id"], ["accepted", "responding", "completed"])
        result = analysis(trainee, card["id"])
        assert result["attempt_status"] == "completed"
        timing = result["timing"]
        # Новое занятие получает v3: реакция от направления до первичного статуса.
        assert timing["timing_version"] == 3 and timing["reaction_s"] is not None
        assert timing["evidence"][0]["source"] == "server"
        # Без образцов часов v2 время клиента оценочное: штраф не назначается.
        assert timing["quality"] == "estimated" and timing["reaction_overdue"] is None
        evaluation = result["evaluation"]
        assert evaluation["status"] == "partial"
        assert evaluation["required_layers"] == ["rules", "llm"]
        layers = {layer["layer"]: layer for layer in evaluation["layers"]}
        assert layers["rules"]["status"] == "done" and layers["rules"]["evidence"]
        assert layers["llm"]["status"] == "pending"
        assert layers["information"]["status"] == "not_applicable"
        assert any("llm" in reason for reason in evaluation["partial_reasons"])
        assert evaluation["automatic_total"] == evaluation["effective_total"]
        # 28.09: грамотность проверяется — input = адрес + грамотность (I-EVAL).
        errors = evaluation["errors"]
        assert layers["grammar"]["status"] == "done"
        assert errors["input"] == errors["address"] + errors["grammar"]
        assert errors["timing"] is None
        assert "reference" not in str(result) and "expected_comment" not in str(result)

        other = login(trainee, "trainee02")
        assert other and analysis(trainee, card["id"], expected=404)
    teacher = lesson.client
    login(teacher)
    assert analysis(teacher, card["id"])["card_id"] == card["id"]
    # ТЗ, C-07: администратор не видит результаты обучаемых (минимальные привилегии).
    login(teacher, "admin")
    analysis(teacher, card["id"], expected=403)


def test_reaction_starts_when_card_is_shown(lesson, database_config, database_url):  # noqa: F811
    """Задержка между выдачей и показом (обучаемый ещё входил) в реакцию не входит."""
    batch(lesson, [item(lesson), item(lesson, participant=1)])
    start(lesson)
    tick(database_url)
    with TestClient(create_database_app(database_config)) as trainee:
        headers = login(trainee, "trainee01")
        card = next(c for c in trainee.get("/api/cards").json() if c["session_id"] == lesson.id)

        async def issued_an_hour_ago(db):
            row = await db.get(Card, UUID(card["id"]))
            row.appeared_at -= timedelta(hours=1)

        run_db(database_url, issued_an_hour_ago)
        play(trainee, headers, card["id"], ["accepted", "completed"])
        shown = trainee.get(f"/api/cards/{card['id']}").json()
        timing = analysis(trainee, card["id"])["timing"]
        assert timing["timing_version"] == 3
        # Направление — серверное время показа строки, а не выдачи scheduler'ом.
        direct = datetime.fromisoformat(timing["evidence"][0]["normalized_at"])
        delivered = datetime.fromisoformat(shown["delivered_at"])
        assert abs((direct - delivered).total_seconds()) < 1
        assert timing["reaction_s"] < 60
        assert timing["lifetime_s"] >= 3600


def test_override_and_session_analytics(lesson, database_config, database_url):  # noqa: F811
    batch(lesson, [item(lesson), item(lesson, order=2), item(lesson, participant=1)])
    start(lesson)
    tick(database_url)
    with TestClient(create_database_app(database_config)) as trainee:
        headers = login(trainee, "trainee01")
        cards = [c for c in trainee.get("/api/cards").json() if c["session_id"] == lesson.id]
        play(trainee, headers, cards[0]["id"], ["accepted", "responding", "completed"])
        evaluation_id = analysis(trainee, cards[0]["id"])["evaluation"]["evaluation_id"]
    headers = login(lesson.client)
    response = lesson.client.post(
        "/api/overrides",
        json={
            "evaluation_id": evaluation_id,
            "decision": "disagree",
            "new_total": 0.4,
            "reason": "Комментарий неполный",
            "teacher_comment": "Нет сведений о пострадавших",
        },
        headers=headers,
    )
    assert response.status_code == 201, response.text
    evaluation = analysis(lesson.client, cards[0]["id"])["evaluation"]
    assert evaluation["effective_total"] == 0.4
    assert evaluation["effective_override"]["teacher_comment"] == "Нет сведений о пострадавших"

    response = lesson.client.get(f"/api/reports/session/{lesson.id}/analytics")
    assert response.status_code == 200, response.text
    report = response.json()
    validate_json(report, "urn:openapi#/components/schemas/SessionAnalytics")
    first = next(t for t in report["trainees"] if t["user_id"] == lesson.participants[0]["user_id"])
    assert (first["attempt_count"], first["completed_count"], first["evaluated_count"]) == (2, 1, 1)
    assert first["mean_effective_score"] == 0.4
    # Оценочные измерения не смешиваются со средним проверенных.
    assert first["mean_reaction_s"] is None and first["reaction_sample_count"] == 0
    # V-03: одна оценённая попытка — холодный старт, уровень сохраняется с основанием.
    recommendation = first["recommendation"]
    assert recommendation["direction"] == "keep"
    assert recommendation["based_on_attempts"] == 1
    assert recommendation["level"] == first["current_level"]
    assert "Холодный старт" in recommendation["evidence"][0]
    assert "Холодный старт" in first["explanation"]
    assert len(report["attempts"]) == 3
    # I-SESSION: participant_id попытки — user UUID, как в trainees[].user_id.
    trainee_user_ids = {t["user_id"] for t in report["trainees"]}
    assert trainee_user_ids == {p["user_id"] for p in lesson.participants}
    assert {a["participant_id"] for a in report["attempts"]} <= trainee_user_ids

    with TestClient(create_database_app(database_config)) as trainee:
        login(trainee, "trainee01")
        assert trainee.get(f"/api/reports/session/{lesson.id}/analytics").status_code == 403


def test_legacy_session_keeps_v1_timing(database_client, database_url):
    client = database_client
    headers = login(client)
    users = {u["login"]: u for u in client.get("/api/users").json()}
    scenario = next(
        s
        for s in client.get("/api/scenarios").json()
        if s["status"] == "approved" and s["target_service_id"] == "102"
    )
    participant = {
        "user_id": users["trainee02"]["id"],
        "workstation_number": 2,
        "dds_service_id": "102",
        "level": 1,
    }
    lesson_id = client.post(
        "/api/sessions",
        json={
            "title": "Прежняя методика",
            "participants": [participant],
            "settings_snapshot": client.get("/api/settings").json(),
            "timing_policy": None,
        },
        headers=headers,
    ).json()["id"]
    body = {
        "request_id": "00000000-0000-4000-8000-00000000c060",
        "items": [
            {
                "participant_id": participant["user_id"],
                "scenario_id": scenario["id"],
                "scenario_version": scenario["version"],
                "order": 1,
                "delay_from_start_s": 0,
                "delivery_mode": "profile",
            }
        ],
    }
    path = f"/api/sessions/{lesson_id}/assignments/batch"
    assert client.post(path, json=body, headers=headers).status_code == 201
    assert client.post(f"/api/sessions/{lesson_id}/start", headers=headers).status_code == 200
    tick(database_url)
    trainee_headers = login(client, "trainee02")
    card = next(c for c in client.get("/api/cards").json() if c["session_id"] == lesson_id)
    play(client, trainee_headers, card["id"], ["accepted"])
    timing = analysis(client, card["id"])["timing"]
    assert (timing["timing_version"], timing["quality"]) == (1, "legacy")
    assert timing["reaction_s"] is not None and timing["anomalies"] == ["missing_terminal"]
