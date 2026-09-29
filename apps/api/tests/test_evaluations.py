"""T-009: мгновенная оценка, приватность, overrides и отчёты."""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.core.contracts import validate_json
from app.core.db import Database
from app.core.models import (
    Assignment,
    AuditLog,
    Card,
    Evaluation,
    Job,
    Participant,
    Prediction,
    TeacherOverride,
)
from app.worker.runtime import Worker
from evalcore.defaults import COMMENT_CRITERIA, CRITERIA
from evalcore.models import CriterionResult
from evalcore.models import Evaluation as CoreEvaluation
from fastapi.testclient import TestClient
from sqlalchemy import select


def run_db(url, action):
    async def run():
        database = Database(url)
        try:
            async with database.sessions.begin() as db:
                return await action(db)
        finally:
            await database.close()

    return asyncio.run(run())


def login(client: TestClient, role: str = "teacher") -> dict[str, str]:
    response = client.post("/api/auth/login", json={"login": role, "password": "test-password"})
    assert response.status_code == 200, response.text
    return {"X-CSRF-Token": client.cookies["csrf"]}


def terminal_event(event_id: UUID | None = None) -> dict:
    return {
        "client_event_id": str(event_id or uuid4()),
        "client_ts": datetime.now(UTC).isoformat(),
        "type": "status_change",
        "payload": {"state": "completed", "comment": "Работа завершена"},
    }


@pytest.fixture
def evaluation_case(database_config, database_url, request):
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        users = {item["login"]: item for item in client.get("/api/users").json()}
        scenario = next(
            item for item in client.get("/api/scenarios").json() if item["status"] == "approved"
        )
        redirect_case = getattr(request, "param", None) == "redirect"
        if redirect_case:
            scenario["id"] = str(uuid4())
            scenario["reference"]["expected_flow"] = ["received", "rejected", "redirected"]
            scenario["reference"]["expected_service_ids"] = ["101"]
            scenario["reference"]["expected_call"]["required"] = False
            created_scenario = client.post("/api/scenarios", json=scenario, headers=headers)
            assert created_scenario.status_code == 201, created_scenario.text
        settings = client.get("/api/settings").json()
        created = client.post(
            "/api/sessions",
            json={
                "title": "Оценка T-009",
                "participants": [
                    {
                        "user_id": users["trainee01"]["id"],
                        "workstation_number": 1,
                        "dds_service_id": "102",
                        "level": 1,
                    }
                ],
                "settings_snapshot": settings,
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text
        session_id = UUID(created.json()["id"])
        assigned = client.post(
            f"/api/sessions/{session_id}/assignments",
            json={
                "participant_id": users["trainee01"]["id"],
                "scenario_id": scenario["id"],
                "order": 1,
                "planned_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
            },
            headers=headers,
        )
        assert assigned.status_code == 201, assigned.text
        assert client.post(f"/api/sessions/{session_id}/start", headers=headers).status_code == 200
    card_id = uuid4()
    prediction_id = uuid4()
    appeared_at = datetime.now(UTC) - timedelta(seconds=75)

    async def insert(db):
        assignment = await db.get(Assignment, UUID(assigned.json()["id"]))
        participant = await db.scalar(
            select(Participant).where(Participant.session_id == session_id)
        )
        db.add(
            Card(
                id=card_id,
                assignment_id=assignment.id,
                number=scenario["card"]["number"],
                state="added" if redirect_case else "responding",
                appeared_at=appeared_at,
                delivered_at=None if redirect_case else appeared_at + timedelta(seconds=2),
                opened_at=None if redirect_case else appeared_at + timedelta(seconds=4),
                first_status_at=None if redirect_case else appeared_at + timedelta(seconds=12),
                closed_at=None,
                current={"service_number": "102", "comment": ""},
                redirected_to_service_id=None,
            )
        )
        await db.flush()
        db.add(
            Prediction(
                id=prediction_id,
                card_id=card_id,
                participant_id=participant.id,
                made_at=appeared_at,
                p_success=0.7,
                expected_score=0.75,
                p_timeout=0.2,
                expected_time_s=90,
                theta_before=0,
                b_scenario=0,
                model_version="test-prediction-v1",
                actual_score=None,
                actual_time_s=None,
                actual_timeout=None,
            )
        )

    run_db(database_url, insert)
    return {
        "session_id": session_id,
        "card_id": card_id,
        "prediction_id": prediction_id,
        "teacher_id": UUID(users["teacher"]["id"]),
        "trainee_id": UUID(users["trainee01"]["id"]),
    }


def close_card(database_config, card_id: UUID, body: dict | None = None):
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, "trainee01")
        response = client.post(
            f"/api/cards/{card_id}/events", json=body or terminal_event(), headers=headers
        )
        assert response.status_code == 200, response.text
        return response


def evaluation_id(database_url, card_id: UUID) -> UUID:
    async def get(db):
        row = await db.scalar(select(Evaluation).where(Evaluation.card_id == card_id))
        return row.id

    return run_db(database_url, get)


@pytest.fixture
def rules_unavailable(monkeypatch):
    def unavailable(_context, **_):
        raise NotImplementedError

    monkeypatch.setattr("app.api.evaluations.service.evaluate", unavailable)


def test_terminal_event_creates_partial_job_ws_and_preserves_unknown_fact(
    database_config, database_url, evaluation_case, rules_unavailable
):
    card_id = evaluation_case["card_id"]
    body = terminal_event()
    with TestClient(create_database_app(database_config)) as teacher:
        login(teacher)
        with teacher.websocket_connect("/ws", headers={"origin": "http://testserver"}) as socket:
            assert socket.receive_json()["type"] == "snapshot"
            completed = close_card(database_config, card_id, body)
            assert completed.json()["card"]["state"] == "completed"
            messages = [socket.receive_json() for _ in range(3)]
            assert {item["type"] for item in messages} >= {
                "evaluation.partial",
                "card.updated",
            }
    repeated = close_card(database_config, card_id, body)
    assert repeated.json()["duplicate"] is True

    async def check(db):
        evaluations = list(
            (await db.scalars(select(Evaluation).where(Evaluation.card_id == card_id))).all()
        )
        assert len(evaluations) == 1
        row = evaluations[0]
        assert row.status == "partial"
        assert row.total == 0
        assert row.rules_scores == {}
        assert row.model_info["rules"] == "unavailable:T-006"
        jobs = list(
            (
                await db.scalars(select(Job).where(Job.idempotency_key == f"evaluate:{row.id}:1"))
            ).all()
        )
        assert len(jobs) == 1
        assert jobs[0].payload == {
            "card_id": str(card_id),
            "evaluation_id": str(row.id),
        }
        prediction = await db.get(Prediction, evaluation_case["prediction_id"])
        assert prediction.actual_score is None
        assert prediction.actual_time_s is None
        assert prediction.actual_timeout is None
        return row.id

    found_id = run_db(database_url, check)
    with TestClient(create_database_app(database_config)) as client:
        login(client, "trainee01")
        own = client.get("/api/evaluations")
        assert own.status_code == 200
        own_case = [item for item in own.json() if item["card_id"] == str(card_id)]
        assert [item["id"] for item in own_case] == [str(found_id)]
        validate_json(own_case[0], "urn:openapi#/components/schemas/Evaluation")
    with TestClient(create_database_app(database_config)) as other:
        login(other, "trainee02")
        assert all(item["id"] != str(found_id) for item in other.get("/api/evaluations").json())
        assert other.get(f"/api/evaluations/{found_id}").status_code == 404


def test_successful_rules_evaluation_records_prediction_fact(
    monkeypatch, database_config, database_url, evaluation_case
):
    result = CoreEvaluation(
        total=0.8,
        criteria=[
            CriterionResult(
                key="routing",
                score=0.8,
                weight=1,
                critical=False,
                evidence=["Служба выбрана верно."],
                explanation="Маршрутизация выполнена.",
            )
        ],
        critical_flags=[],
    )
    monkeypatch.setattr("app.api.evaluations.service.evaluate", lambda context, **_: result)
    with TestClient(create_database_app(database_config)) as teacher:
        login(teacher)
        with teacher.websocket_connect("/ws", headers={"origin": "http://testserver"}) as socket:
            assert socket.receive_json()["type"] == "snapshot"
            close_card(database_config, evaluation_case["card_id"])
            messages = [socket.receive_json() for _ in range(3)]
            published = next(item for item in messages if item["type"] == "evaluation.partial")
            assert published["payload"]["criteria"][0]["evidence"] == ["Служба выбрана верно."]

    async def check(db):
        evaluation = await db.scalar(
            select(Evaluation).where(Evaluation.card_id == evaluation_case["card_id"])
        )
        assert evaluation.total == 0.8
        assert evaluation.rules_scores == {"routing": 0.8}
        assert evaluation.explanation == {
            "routing": {
                "explanation": "Маршрутизация выполнена.",
                "evidence": ["Служба выбрана верно."],
            }
        }
        validate_json(
            evaluation.explanation,
            "https://arm112.local/contracts/storage.schema.json#/$defs/Explanations",
        )
        prediction = await db.get(Prediction, evaluation_case["prediction_id"])
        assert prediction.actual_score == 0.8
        # Факт — от показа на АРМ (выдача −75 с, показ на 2 с позже), как в отчёте.
        assert prediction.actual_time_s >= 73
        assert prediction.actual_timeout is False
        return evaluation.id

    found_id = run_db(database_url, check)
    with TestClient(create_database_app(database_config)) as teacher:
        headers = login(teacher)
        loaded = teacher.get(f"/api/evaluations/{found_id}").json()
        assert loaded["criteria"][0]["evidence"] == ["Служба выбрана верно."]
        assert loaded["criteria"][0]["explanation"] == "Маршрутизация выполнена."
        listed = next(
            item for item in teacher.get("/api/evaluations").json() if item["id"] == str(found_id)
        )
        assert listed == loaded
        with teacher.websocket_connect("/ws", headers={"origin": "http://testserver"}) as socket:
            snapshot = socket.receive_json()
            restored = next(
                item for item in snapshot["payload"]["evaluations"] if item["id"] == str(found_id)
            )
            assert restored["criteria"] == loaded["criteria"]
        override = teacher.post(
            "/api/overrides",
            json={
                "evaluation_id": str(found_id),
                "decision": "disagree",
                "new_total": 0.9,
                "reason": "Проверено преподавателем",
                "teacher_comment": "Основания сохранены",
            },
            headers=headers,
        )
        assert override.status_code == 201, override.text
        assert override.json()["criteria"] == loaded["criteria"]


@pytest.mark.parametrize("evidence", [["Позвонено в 102", "Есть завершение звонка"], []])
def test_worker_preserves_evidence_in_persistent_evaluation(
    monkeypatch, database_config, database_url, evaluation_case, evidence
):
    close_card(database_config, evaluation_case["card_id"])
    found_id = evaluation_id(database_url, evaluation_case["card_id"])
    result = CoreEvaluation(
        total=0.6,
        criteria=[
            CriterionResult(
                key="call",
                score=0.6,
                weight=1,
                critical=False,
                evidence=evidence,
                explanation="Телефон проверен.",
            )
        ],
        critical_flags=[],
    )
    monkeypatch.setattr("app.worker.jobs.handlers.evaluate", lambda context, **_: result)

    async def process(db):
        worker = Worker(database_config)
        try:
            payload = {"card_id": str(evaluation_case["card_id"]), "evaluation_id": str(found_id)}
            # Retry rewrites the same result, it must not append duplicate evidence.
            await worker.handlers.handle_evaluate(db, payload)
            await worker.handlers.handle_evaluate(db, payload)
        finally:
            await worker.close()

    run_db(database_url, process)
    with TestClient(create_database_app(database_config)) as teacher:
        login(teacher)
        response = teacher.get(f"/api/evaluations/{found_id}")
        assert response.status_code == 200, response.text
        validate_json(response.json(), "urn:openapi#/components/schemas/Evaluation")
        assert response.json()["criteria"][0]["evidence"] == evidence
        assert response.json()["criteria"][0]["explanation"] == "Телефон проверен."


@pytest.mark.parametrize("provider", ["off", "mock", "local"])
def test_real_evalcore_survives_api_worker_and_database_reload(
    database_config, database_url, evaluation_case, provider, monkeypatch
):
    """Без подмены evaluate: оба адаптера должны передать одинаковый контекст T-006."""
    close_card(database_config, evaluation_case["card_id"])
    found_id = evaluation_id(database_url, evaluation_case["card_id"])
    with TestClient(create_database_app(database_config)) as teacher:
        login(teacher)
        initial = teacher.get(f"/api/evaluations/{found_id}").json()
    assert initial["model_info"]["rules"] == "evalcore"
    # Критерии комментария (28.09) считаются, когда их вес есть в настройках занятия.
    assert {item["key"] for item in initial["criteria"]} == {*CRITERIA, *COMMENT_CRITERIA}
    assert all(item["evidence"] and item["explanation"] for item in initial["criteria"])

    async def process(db):
        worker = Worker(database_config.model_copy(update={"ai_provider": provider}))
        try:

            async def unexpected_judge(*args, **kwargs):
                pytest.fail("Narrative-провайдер не должен подменять проверку ответа")

            monkeypatch.setattr(worker.handlers.llm, "complete_json", unexpected_judge)
            await worker.handlers.handle_evaluate(
                db, {"card_id": str(evaluation_case["card_id"]), "evaluation_id": str(found_id)}
            )
        finally:
            await worker.close()

    run_db(database_url, process)
    with TestClient(create_database_app(database_config)) as teacher:
        login(teacher)
        final = teacher.get(f"/api/evaluations/{found_id}").json()
    assert final["criteria"] == initial["criteria"]
    assert final["total"] == initial["total"]
    assert final["model_info"]["embeddings"] == "off"
    assert final["status"] == "partial"


def test_override_returns_effective_view_and_is_atomically_audited(
    database_config, database_url, evaluation_case, rules_unavailable
):
    close_card(database_config, evaluation_case["card_id"])
    found_id = evaluation_id(database_url, evaluation_case["card_id"])
    body = {
        "evaluation_id": str(found_id),
        "decision": "disagree",
        "new_total": 0.8,
        "reason": "Учтено корректное решение преподавателем",
        "teacher_comment": "Обратите внимание на порядок действий.",
    }
    with TestClient(create_database_app(database_config)) as trainee:
        headers = login(trainee, "trainee01")
        assert trainee.post("/api/overrides", json=body, headers=headers).status_code == 403
    with TestClient(create_database_app(database_config)) as teacher:
        headers = login(teacher)
        assert teacher.post("/api/overrides", json=body).status_code == 403
        invalid = teacher.post(
            "/api/overrides",
            json={**body, "decision": "agree", "new_total": 0.8},
            headers=headers,
        )
        assert invalid.status_code == 422
        response = teacher.post("/api/overrides", json=body, headers=headers)
        assert response.status_code == 201, response.text
        assert response.json()["total"] == 0.8
        assert response.json()["teacher_comment"] == body["teacher_comment"]
        assert teacher.get(f"/api/evaluations/{found_id}").json() == response.json()

    async def check(db):
        evaluation = await db.get(Evaluation, found_id)
        assert evaluation.total == 0
        override = await db.scalar(
            select(TeacherOverride).where(TeacherOverride.evaluation_id == found_id)
        )
        assert override.new_total == 0.8
        audit = await db.scalar(
            select(AuditLog)
            .where(AuditLog.action == "createOverride", AuditLog.entity_id == str(override.id))
            .order_by(AuditLog.ts.desc())
        )
        assert audit.before["total"] == 0
        assert audit.after["total"] == 0.8
        validate_json(
            audit.after,
            "https://arm112.local/contracts/storage.schema.json#/$defs/AuditSnapshot",
        )

    run_db(database_url, check)


def test_reports_include_effective_totals_weakest_criteria_prediction_and_csv(
    database_config, database_url, evaluation_case, rules_unavailable
):
    close_card(database_config, evaluation_case["card_id"])
    found_id = evaluation_id(database_url, evaluation_case["card_id"])

    async def enrich(db):
        evaluation = await db.get(Evaluation, found_id)
        evaluation.rules_scores = {"routing": 0.25, "address": 0.75}
        evaluation.explanation = {"routing": "Ошибка службы.", "address": "Адрес неполный."}
        evaluation.total = 0.5
        prediction = await db.get(Prediction, evaluation_case["prediction_id"])
        prediction.actual_score = 0.5
        prediction.actual_time_s = 75
        prediction.actual_timeout = False

    run_db(database_url, enrich)
    with TestClient(create_database_app(database_config)) as teacher:
        headers = login(teacher)
        legacy = teacher.get(f"/api/evaluations/{found_id}").json()
        assert all(item["evidence"] == [] for item in legacy["criteria"])
        assert {item["key"]: item["explanation"] for item in legacy["criteria"]} == {
            "routing": "Ошибка службы.",
            "address": "Адрес неполный.",
        }
        override = teacher.post(
            "/api/overrides",
            json={
                "evaluation_id": str(found_id),
                "decision": "disagree",
                "new_total": 0.8,
                "reason": "Проверено преподавателем",
                "teacher_comment": "Исправление принято.",
            },
            headers=headers,
        )
        assert override.status_code == 201
        report = teacher.get(f"/api/reports/session/{evaluation_case['session_id']}")
        assert report.status_code == 200, report.text
        validate_json(report.json(), "urn:openapi#/components/schemas/Report")
        assert report.json()["trainees"][0]["total"] == 0.8
        assert report.json()["trainees"][0]["errors"] == 2
        assert report.json()["weakest_criteria"] == ["routing", "address"]
        assert report.json()["predictions"][0]["expected_score"] == 0.75
        assert report.json()["predictions"][0]["actual_score"] == 0.5
        exported = teacher.get(f"/api/reports/session/{evaluation_case['session_id']}/csv")
        assert exported.status_code == 200
        assert exported.content.startswith(b"\xef\xbb\xbf")
        assert "ФИО;АРМ;Балл;" in exported.text.lstrip("\ufeff")
        assert "Обучаемый 01;1;0.8;" in exported.text
        assert teacher.get(f"/api/reports/session/{uuid4()}").status_code == 404
    with TestClient(create_database_app(database_config)) as trainee:
        login(trainee, "trainee01")
        assert (
            trainee.get(f"/api/reports/session/{evaluation_case['session_id']}").status_code == 403
        )
    with TestClient(create_database_app(database_config)) as admin:
        login(admin, "admin")
        # Отчёт об успеваемости — дело преподавателя, не администратора (ТЗ, C-07).
        assert admin.get(f"/api/reports/session/{evaluation_case['session_id']}").status_code == 403


@pytest.mark.parametrize("evaluation_case", ["redirect"], indirect=True)
@pytest.mark.parametrize("recipient,score", [("101", 1), ("102", 0)])
def test_redirect_uses_real_backend_flow_and_preserves_override(
    database_config, database_url, evaluation_case, recipient, score
):
    card_id = evaluation_case["card_id"]
    with TestClient(create_database_app(database_config)) as trainee:
        headers = login(trainee, "trainee01")
        for kind, payload in [
            ("deliver", {}),
            ("open", {}),
            ("status_change", {"state": "rejected", "comment": "Передать в 101"}),
            ("redirect", {"service_id": recipient, "comment": "Передать в 101"}),
        ]:
            response = trainee.post(
                f"/api/cards/{card_id}/events",
                headers=headers,
                json={
                    "client_event_id": str(uuid4()),
                    "client_ts": datetime.now(UTC).isoformat(),
                    "type": kind,
                    "payload": payload,
                },
            )
            assert response.status_code == 200, response.text
        initial = next(
            row for row in trainee.get("/api/evaluations").json() if row["card_id"] == str(card_id)
        )
        routing = next(row for row in initial["criteria"] if row["key"] == "routing")
        assert routing["score"] == score
        assert routing["critical"] is (score == 0)
        assert "101" in routing["evidence"][-1] and recipient in routing["evidence"][-1]
    found_id = UUID(initial["id"])
    with TestClient(create_database_app(database_config)) as teacher:
        headers = login(teacher)
        response = teacher.post(
            "/api/overrides",
            headers=headers,
            json={
                "evaluation_id": str(found_id),
                "decision": "disagree",
                "new_total": 0.8,
                "reason": "Проверка сохранения решения",
                "teacher_comment": "Разобрано",
            },
        )
        assert response.status_code == 201, response.text

    async def process(db):
        worker = Worker(database_config)
        try:
            for _ in range(2):
                await worker.handlers.handle_evaluate(
                    db, {"card_id": str(card_id), "evaluation_id": str(found_id)}
                )
        finally:
            await worker.close()

    run_db(database_url, process)
    with TestClient(create_database_app(database_config)) as trainee:
        login(trainee, "trainee01")
        final = trainee.get(f"/api/evaluations/{found_id}").json()
        assert final["criteria"] == initial["criteria"]
        assert final["total"] == 0.8
        assert final["teacher_comment"] == "Разобрано"
        assert final["status"] == "partial"
