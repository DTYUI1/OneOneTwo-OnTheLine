"""S03: сохранённый вес 0 — не ошибка; реальные нули и legacy остаются оценками."""

import csv
import io
from uuid import uuid4

import pytest
from app.api.database import create_database_app
from app.core.models import Evaluation, Participant, Session, User
from app.worker.runtime import Worker
from fastapi.testclient import TestClient
from sqlalchemy import select

from . import test_evaluations as evaluations_base
from .test_evaluations import login, run_db, terminal_event

evaluation_case = evaluations_base.evaluation_case


@pytest.fixture
def isolated_case(database_url, evaluation_case):
    """Сохраняем владельца занятия и ID участника, но не общую историю trainee01."""

    async def isolate_trainee(db):
        sample = await db.get(User, evaluation_case["trainee_id"])
        trainee = User(
            login=uuid4().hex,
            password_hash=sample.password_hash,
            role=sample.role,
            full_name=sample.full_name,
            is_active=sample.is_active,
            workstation_number=sample.workstation_number,
            dds_service_id=sample.dds_service_id,
        )
        db.add(trainee)
        await db.flush()
        participant = await db.scalar(
            select(Participant).where(
                Participant.session_id == evaluation_case["session_id"],
                Participant.user_id == sample.id,
            )
        )
        participant.user_id = trainee.id
        return trainee.id, trainee.login

    trainee_id, trainee_login = run_db(database_url, isolate_trainee)
    return {**evaluation_case, "trainee_id": trainee_id, "trainee_login": trainee_login}


def close_isolated_card(database_config, case, body=None):
    """Тот же HTTP-путь события и оценки, аутентификация — новым обучаемым."""
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, case["trainee_login"])
        response = client.post(
            f"/api/cards/{case['card_id']}/events",
            json=body or terminal_event(),
            headers=headers,
        )
        assert response.status_code == 200, response.text
        return response


@pytest.fixture
def stored_case(database_config, database_url, isolated_case):
    evaluation_case = isolated_case
    close_isolated_card(database_config, evaluation_case)

    async def store(db):
        row = await db.scalar(
            select(Evaluation).where(Evaluation.card_id == evaluation_case["card_id"])
        )
        row.rules_scores = {"handling_time": 0, "spelling": 0, "routing": 0, "address": 1}
        row.semantic_scores = row.llm_scores = None
        row.explanation = {
            "handling_time": {
                "weight": 0,
                "explanation": "Время обработки не оценивается: раннее закрытие.",
                "evidence": ["Карточка закрыта до завершения работ."],
            },
            "spelling": {
                "weight": 0,
                "explanation": "Грамотность не оценивается: нет слов.",
                "evidence": ["Нет слов для проверки."],
            },
            "routing": {"weight": 1, "explanation": "Неверная служба.", "evidence": []},
            "address": "Старая строка: адрес верен.",
        }
        row.critical_flags = ["routing"]
        row.total = 0.25
        return row.id

    return {**evaluation_case, "evaluation_id": run_db(database_url, store)}


def test_report_and_csv_skip_only_zero_weight(database_config, stored_case):
    with TestClient(create_database_app(database_config)) as client:
        login(client)
        session_id = stored_case["session_id"]
        response = client.get(f"/api/reports/session/{session_id}")
        assert response.status_code == 200, response.text
        report = response.json()
        assert report["trainees"][0]["errors"] == 1
        assert report["weakest_criteria"] == ["routing", "address"]
        exported = client.get(f"/api/reports/session/{session_id}/csv")
        assert exported.status_code == 200, exported.text
        rows = list(
            csv.DictReader(io.StringIO(exported.content.decode("utf-8-sig")), delimiter=";")
        )
        assert rows[0]["Ошибки"] == "1"
        view = client.get(f"/api/evaluations/{stored_case['evaluation_id']}").json()
        by_key = {item["key"]: item for item in view["criteria"]}
        assert by_key["routing"]["score"] == 0 and by_key["routing"]["weight"] == 1
        assert by_key["spelling"]["weight"] == 0
        assert by_key["spelling"]["explanation"] == "Грамотность не оценивается: нет слов."
        assert by_key["spelling"]["evidence"] == ["Нет слов для проверки."]


@pytest.mark.parametrize("consumer", ["analysis", "insights", "review", "advice", "profile"])
def test_stored_consumers_exclude_unscored(database_config, database_url, stored_case, consumer):
    session_id = stored_case["session_id"]
    if consumer in {"analysis", "review"}:
        with TestClient(create_database_app(database_config)) as client:
            login(client)
            if consumer == "analysis":
                response = client.get(f"/api/cards/{stored_case['card_id']}/analysis")
                assert response.status_code == 200, response.text
                result = response.json()["evaluation"]
                assert result["errors"]["grammar"] is None
                assert result["errors"]["routing"] == 1
                layers = {item["layer"]: item for item in result["layers"]}
                assert layers["grammar"]["status"] == "not_applicable"
                assert layers["grammar"]["reason"] == "Грамотность не оценивается: нет слов."
                assert "spelling: 0.00" not in layers["rules"]["evidence"]
            else:
                response = client.get(f"/api/sessions/{session_id}/review")
                assert response.status_code == 200, response.text
                result = response.json()
                assert result["heatmap"]["criteria"] == ["address", "routing"]
                assert "Грамотность" not in str(result)
        return

    async def check(db):
        if consumer == "insights":
            result = await Worker(database_config).handlers.handle_insights(
                db, {"session_id": str(session_id)}
            )
            assert result["weakest_criteria"] == ["routing", "address"]
        elif consumer == "advice":
            from app.api.progress.advice import recent_attempts, recent_scores, weak_spots

            recent = await recent_attempts(db, stored_case["trainee_id"])
            assert recent[0].skipped == {"spelling", "handling_time"}
            assert recent[0].scores == {"routing": 0, "address": 1}
            assert weak_spots(await recent_scores(db, stored_case["trainee_id"])) == ["routing"]
        else:
            from datetime import UTC, datetime

            from app.api.analysis.weak_spots import profile

            lesson = await db.get(Session, session_id)
            lesson.status, lesson.finished_at = "finished", datetime.now(UTC)
            row = await db.get(Evaluation, stored_case["evaluation_id"])
            row.rules_scores = {"reaction_time": 0, "brigade_work": 0}
            row.explanation = {
                key: {"weight": 0, "explanation": "Не применялся.", "evidence": []}
                for key in row.rules_scores
            }
            await db.flush()
            weak = await profile(db, stored_case["trainee_id"])
            assert weak == {}
            from app.worker.generators.personalization import selection

            selected = selection(
                {"events": [{"kind": "alarm"}]}, weak, True, str(stored_case["trainee_id"])
            )
            assert not selected["targeted"] and selected["skills"] == []

    run_db(database_url, check)


@pytest.mark.parametrize("consumer", ["criteria", "progress", "recommendation", "analytics"])
def test_zero_weight_critical_flag_does_not_fail_attempt(
    database_config, database_url, stored_case, consumer
):
    async def flag(db):
        row = await db.get(Evaluation, stored_case["evaluation_id"])
        row.critical_flags = ["spelling"]
        row.total = 1

    run_db(database_url, flag)

    if consumer in {"criteria", "analytics"}:
        with TestClient(create_database_app(database_config)) as client:
            login(client)
            if consumer == "criteria":
                view = client.get(f"/api/evaluations/{stored_case['evaluation_id']}").json()
                spelling = next(item for item in view["criteria"] if item["key"] == "spelling")
                assert spelling["critical"] is False
                assert not any(item["kind"] == "error" for item in spelling["remarks"])
            else:
                response = client.get(f"/api/reports/session/{stored_case['session_id']}/analytics")
                assert response.status_code == 200, response.text
                recommendation = response.json()["trainees"][0]["recommendation"]
                assert "Попыток с критическими ошибками: 0." in recommendation["evidence"]
        return

    async def check(db):
        if consumer == "progress":
            from app.api.progress.service import scored_cards

            cards = await scored_cards(db, stored_case["trainee_id"])
            assert next(item for item in cards if item.card.id == stored_case["card_id"]).passed
        else:
            from app.api.sessions.preparation import recommend_for_user
            from app.core.models import Assignment, Card, Scenario

            card = await db.get(Card, stored_case["card_id"])
            assignment = await db.get(Assignment, card.assignment_id)
            scenario = await db.get(Scenario, assignment.scenario_id)
            result = await recommend_for_user(
                db, stored_case["trainee_id"], scenario.target_service_id
            )
            row = await db.get(Evaluation, stored_case["evaluation_id"])
            row.critical_flags = []
            await db.flush()
            without_flag = await recommend_for_user(
                db, stored_case["trainee_id"], scenario.target_service_id
            )
            assert result == without_flag

    run_db(database_url, check)


def test_unscored_timing_is_not_an_error():
    from app.api.analysis.service import error_counts

    row = Evaluation(
        rules_scores={"handling_time": 0, "reaction_time": 0},
        explanation={"handling_time": {"weight": 0}},
    )
    timing = {"reaction_overdue": True, "handling_overdue": True}
    assert error_counts(row, timing)["timing"] == 1
    row.explanation = {"handling_time": {"weight": 0}, "reaction_time": {"weight": 0}}
    assert error_counts(row, timing)["timing"] is None
    row.explanation = {}
    assert error_counts(row, timing)["timing"] == 2


@pytest.mark.parametrize("metadata", ["string", "without_weight", "absent"])
def test_legacy_missing_weights_keep_real_zero_scores(
    database_config, database_url, stored_case, metadata
):
    async def legacy(db):
        row = await db.get(Evaluation, stored_case["evaluation_id"])
        row.explanation = (
            {}
            if metadata == "absent"
            else {
                key: "Старое пояснение."
                if metadata == "string"
                else {"explanation": "Старое пояснение.", "evidence": []}
                for key in row.rules_scores
            }
        )

    run_db(database_url, legacy)
    with TestClient(create_database_app(database_config)) as client:
        login(client)
        report = client.get(f"/api/reports/session/{stored_case['session_id']}").json()
        assert report["trainees"][0]["errors"] == 3
        assert set(report["weakest_criteria"]) == {"handling_time", "routing", "spelling"}
        analysis = client.get(f"/api/cards/{stored_case['card_id']}/analysis").json()["evaluation"]
        assert analysis["errors"]["grammar"] == analysis["errors"]["routing"] == 1
        view = client.get(f"/api/evaluations/{stored_case['evaluation_id']}").json()
        routing = next(item for item in view["criteria"] if item["key"] == "routing")
        assert routing["score"] == 0 and routing["weight"] > 0 and routing["critical"]


@pytest.mark.parametrize("with_plan", [False, True])
def test_real_api_worker_refresh_preserve_audit_penalty_and_override(
    database_config, database_url, isolated_case, with_plan
):
    from app.api.evaluations.service import evaluate_terminal_card, refresh_terminal_rules
    from app.api.training.content import store_plan
    from app.core.models import Assignment, CallTarget, Card, Prediction, TeacherOverride

    from .test_review2_backend import isolated_scenario

    case = isolated_case

    async def prepare(db):
        card = await db.get(Card, case["card_id"])
        assignment = await db.get(Assignment, card.assignment_id)
        source_id = assignment.scenario_id
        scenario = await isolated_scenario(db, assignment)
        assignment.scenario_id = source_id
        scenario.reference = {
            **scenario.reference,
            "expected_flow": [
                "received",
                "accepted",
                "responding",
                "arrived",
                "working",
                "completed",
            ],
        }
        if with_plan:
            target = await db.scalar(
                select(CallTarget).where(
                    CallTarget.brigade_id.is_not(None),
                    CallTarget.service_id == scenario.target_service_id,
                )
            )
            await store_plan(
                db,
                scenario.id,
                scenario.version,
                case["teacher_id"],
                {
                    "version": 1,
                    "required_brigade_ids": [str(target.brigade_id)],
                    "observable_defects": [],
                    "messages": [
                        {
                            "message": {
                                "id": str(uuid4()),
                                "version": 1,
                                "text": "Прибыли.",
                                "audio": None,
                            },
                            "brigade_id": str(target.brigade_id),
                            "call_target_id": str(target.id),
                            "available_after_s": 0,
                            "expected_comment": "Прибыли.",
                            "justifies_state": "arrived",
                        }
                    ],
                },
            )
        assignment.scenario_id = scenario.id

    run_db(database_url, prepare)
    body = terminal_event()
    body["payload"] = {"state": "refused", "comment": "123"}
    close_isolated_card(database_config, case, body)

    async def read(db):
        row = await db.scalar(select(Evaluation).where(Evaluation.card_id == case["card_id"]))
        assert (
            row.explanation["spelling"]["weight"] == row.explanation["handling_time"]["weight"] == 0
        )
        assert row.rules_scores["spelling"] == row.rules_scores["handling_time"] == 0
        assert row.explanation["spelling"]["explanation"]
        assert row.explanation["handling_time"]["evidence"]
        if with_plan:
            assert row.total == 0 and row.status == "complete"
            assert row.model_info["llm"] == "rule:no-reports"
            assert "не принят ни один" in row.explanation["status_flow"]["explanation"]
        prediction = await db.get(Prediction, case["prediction_id"])
        return row, (prediction.actual_score, prediction.actual_time_s, prediction.actual_timeout)

    initial, prediction_fact = run_db(database_url, read)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        override = client.post(
            "/api/overrides",
            headers=headers,
            json={
                "evaluation_id": str(initial.id),
                "decision": "disagree",
                "new_total": 0.9,
                "reason": "Решение преподавателя.",
                "teacher_comment": "Проверено.",
            },
        )
        assert override.status_code == 201, override.text

        async def process(db):
            worker = Worker(database_config)
            for _ in range(2):
                await worker.handlers.handle_evaluate(
                    db,
                    {
                        "card_id": str(case["card_id"]),
                        "evaluation_id": str(initial.id),
                    },
                )
                await refresh_terminal_rules(db, case["card_id"])
            assert (await evaluate_terminal_card(db, case["card_id"])).id == initial.id

        run_db(database_url, process)
        refreshed, after_fact = run_db(database_url, read)
        assert refreshed.id == initial.id and refreshed.version == initial.version
        assert refreshed.total == initial.total and after_fact == prediction_fact
        view = client.get(f"/api/evaluations/{initial.id}").json()
        assert view["total"] == 0.9 and view["teacher_comment"] == "Проверено."
        report = client.get(f"/api/reports/session/{case['session_id']}").json()
        assert report["trainees"][0]["total"] == 0.9
        assert report["trainees"][0]["errors"] == sum(
            item["weight"] != 0 and item["score"] < 1 for item in view["criteria"]
        )
        assert not {"spelling", "handling_time"} & set(report["weakest_criteria"])
        analysis = client.get(f"/api/cards/{case['card_id']}/analysis").json()["evaluation"]
        assert analysis["effective_total"] == 0.9
        assert analysis["automatic_total"] == initial.total
        assert analysis["errors"]["grammar"] is None
        if with_plan:
            assert analysis["status"] == "complete"
            assert analysis["required_layers"] == ["rules"]

    async def overrides(db):
        return list(
            await db.scalars(
                select(TeacherOverride).where(TeacherOverride.evaluation_id == initial.id)
            )
        )

    assert len(run_db(database_url, overrides)) == 1


def test_coherence_report_does_not_invent_failures(database_url, stored_case):
    from types import SimpleNamespace

    from app.core.db import Database
    from app.tools.coherence.runner import ScenarioRun

    async def check(_db):
        database = Database(database_url)
        try:
            run = SimpleNamespace(
                talk=None,
                app=SimpleNamespace(state=SimpleNamespace(database=database)),
                card={"id": str(stored_case["card_id"])},
                tr=SimpleNamespace(review=[]),
                events={},
                session_id=None,
            )
            await ScenarioRun._finish(run)
            assert run.tr.scores == {"routing": 0, "address": 1}
            assert run.tr.critical == ["routing"]
            assert any("Нет слов" in text for text in run.tr.review)
        finally:
            await database.close()

    run_db(database_url, check)
