"""ИИ-подбор ограничен занятием преподавателя, учитывает историю и весь состав класса."""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.api.sessions.preparation import recommend_for_participant
from app.core.db import Database
from app.core.models import (
    Assignment,
    Card,
    Evaluation,
    Job,
    Participant,
    Scenario,
    Session,
    TeacherOverride,
    User,
)
from app.worker.generators import pairwise, variant_paths
from app.worker.generators.storage import generate_one
from app.worker.runtime import Worker
from evalcore.defaults import CRITERIA
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from .test_lifecycle import event, login, run_db
from .test_scenario_generation import ScriptedLLM

pytestmark = pytest.mark.usefixtures("clean_generated_content")


def users_for_test(database_url, count):
    async def insert(db):
        sample = await db.scalar(select(User).where(User.login == "trainee01"))
        rows = [
            User(
                login="ai-" + uuid4().hex,
                password_hash=sample.password_hash,
                role="trainee",
                full_name=f"Учебный участник {index + 1}",
                is_active=True,
                workstation_number=None,
                dds_service_id="102",
            )
            for index in range(count)
        ]
        db.add_all(rows)
        await db.flush()
        return [(str(row.id), row.login) for row in rows]

    return run_db(database_url, insert)


def prepare(database_config, job_id):
    async def process():
        worker = Worker(database_config)
        worker.handlers.llm = ScriptedLLM()
        try:
            for _ in range(100):
                async with worker.database.sessions.begin() as db:
                    job = await db.get(Job, UUID(job_id), with_for_update=True)
                    result = await worker.handlers.handle_generate(db, job.payload)
                    job.result = result
                    job.status = "done" if result["complete"] else "pending"
                if result["complete"]:
                    return
            raise AssertionError("Подготовка не завершилась за ограниченное число порций")
        finally:
            await worker.close()

    asyncio.run(process())


@pytest.mark.parametrize(("count", "cards_each"), [(1, 2), (3, 1), (23, 4)])
def test_ai_lesson_prepares_entire_group_and_assigns_versions(
    database_config, database_url, count, cards_each, monkeypatch
):
    selections = []
    pick = variant_paths.pick

    def record(*args, **kwargs):
        source, data = pick(*args, **kwargs)
        selections.append((kwargs.get("covered_pairs"), pairwise.pairs(pairwise.features(data))))
        return source, data

    monkeypatch.setattr(variant_paths, "pick", record)
    config = database_config.model_copy(update={"ai_provider": "local"})
    trainees = users_for_test(database_url, count)
    with TestClient(create_database_app(config)) as client:
        headers = login(client)
        body = {
            "title": "Автоматическое занятие",
            "settings_snapshot": client.get("/api/settings").json(),
            "participants": [
                {
                    "user_id": user_id,
                    "workstation_number": index + 1,
                    "dds_service_id": "GKH"
                    if count < 4
                    else ["101", "102", "103", "104", "GKH", "MOSLIFT"][index % 6],
                    "level": 1,
                }
                for index, (user_id, _) in enumerate(trainees)
            ],
            "ai_selection": {"request_id": str(uuid4()), "cards_per_participant": cards_each},
        }
        response = client.post("/api/sessions", json=body, headers=headers)
        assert response.status_code == 201, response.text
        lesson = response.json()
        lesson_id = lesson["id"]
        preparation = lesson["ai_preparation"]
        assert preparation["total"] == count * cards_each and preparation["state"] == "queued"
        assert all(
            r["based_on_attempts"] == 0 and r["level"] == 1 for r in preparation["recommendations"]
        )
        assert client.post("/api/sessions", json=body, headers=headers).json()["id"] == lesson_id
        changed = {**body, "title": "Другое занятие"}
        assert client.post("/api/sessions", json=changed, headers=headers).status_code == 409
        if count == 23:
            overflow = {
                **body,
                "ai_selection": {**body["ai_selection"], "request_id": str(uuid4())},
                "participants": [
                    *body["participants"],
                    {**body["participants"][0], "workstation_number": 24},
                ],
            }
            assert client.post("/api/sessions", json=overflow, headers=headers).status_code == 422
        assert client.post(f"/api/sessions/{lesson_id}/start", headers=headers).status_code == 409
        assert client.get(f"/api/sessions/{lesson_id}/assignment-batches").json() == []
        prepare(config, preparation["job_id"])
        assert len(selections) == count * cards_each
        for start in range(0, len(selections), cards_each):
            covered = set()
            for previous, selected in selections[start : start + cards_each]:
                assert previous == covered
                covered.update(selected)
        ready = client.get(f"/api/sessions/{lesson_id}").json()
        assert ready["status"] == "draft" and ready["started_at"] is None
        assert ready["ai_preparation"]["state"] == "ready"
        assert ready["ai_preparation"]["completed"] == count * cards_each
        batches = client.get(f"/api/sessions/{lesson_id}/assignment-batches").json()
        assignments = [a for b in batches for a in b["assignments"]]
        assert len(assignments) == count * cards_each
        assert len({a["scenario_id"] for a in assignments}) == len(assignments)
        assert all(a["due_at"] is None and a["scenario_version"] == 1 for a in assignments)
        scenarios = {s["id"]: s for s in client.get("/api/scenarios").json()}
        services = {p["user_id"]: p["dds_service_id"] for p in body["participants"]}
        for assignment in assignments:
            scenario = scenarios[assignment["scenario_id"]]
            assert scenario["status"] == "approved" and scenario["origin"] == "llm"
            assert scenario["target_service_id"] == services[assignment["participant_id"]]
        if count == 3:
            # У ЖКХ в каталоге один каркас: задания разнятся заявителем, номером и докладами.
            cards = [scenarios[a["scenario_id"]]["card"] for a in assignments]
            assert len({(c["caller_name"], c["number"]) for c in cards}) == 3
        before = datetime.now(UTC)
        started = client.post(f"/api/sessions/{lesson_id}/start", headers=headers)
        assert started.status_code == 200, started.text
        assert datetime.fromisoformat(started.json()["started_at"]) >= before
        assert client.post(f"/api/sessions/{lesson_id}/finish", headers=headers).status_code == 200
    with TestClient(create_database_app(config)) as trainee:
        login(trainee, trainees[0][1])
        own = trainee.get(f"/api/sessions/{lesson_id}")
        assert own.status_code == 200 and own.json()["ai_preparation"] is None


def test_ai_off_and_trainee_cannot_trigger_generation(database_config, database_url):
    trainees = users_for_test(database_url, 1)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        body = {
            "title": "ИИ выключен",
            "settings_snapshot": client.get("/api/settings").json(),
            "participants": [
                {
                    "user_id": trainees[0][0],
                    "workstation_number": 1,
                    "dds_service_id": "102",
                    "level": 1,
                }
            ],
            "ai_selection": {"request_id": str(uuid4()), "cards_per_participant": 1},
        }
        response = client.post("/api/sessions", json=body, headers=headers)
        assert response.status_code == 503 and response.json()["code"] == "ai_unavailable"
        manual = client.post(
            "/api/sessions",
            json={k: v for k, v in body.items() if k != "ai_selection"},
            headers=headers,
        )
        assert manual.status_code == 201 and manual.json()["ai_preparation"] is None
        student = login(client, trainees[0][1])
        assert client.post("/api/sessions", json=body, headers=student).status_code == 403
        assert (
            client.post(
                "/api/packs/generate",
                json={"count": 1, "service_id": "102", "level": 1, "seed": 1},
                headers=student,
            ).status_code
            == 403
        )


def test_practice_start_and_completion_never_enqueue_generation(
    database_config, database_url, monkeypatch
):
    trainees = users_for_test(database_url, 1)

    async def ready_scenario(request, service_id):
        # Изолируем именно учебный цикл от длительности докладов упражнения:
        # источник остаётся готовым сценарием из настоящей БД, без вызова генератора.
        return await request.state.db.scalar(
            select(Scenario)
            .where(
                Scenario.status == "approved",
                Scenario.target_service_id == "102",
                Scenario.generation_metadata.is_(None),
            )
            .order_by(Scenario.id)
            .limit(1)
        )

    monkeypatch.setattr("app.api.sessions.practice.tutorial_scenario", ready_scenario)

    def generation_count():
        async def count(db):
            return await db.scalar(
                select(func.count()).select_from(Job).where(Job.kind == "generate")
            )

        return run_db(database_url, count)

    before = generation_count()
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, trainees[0][1])
        practice = client.post("/api/practice", headers=headers)
        assert practice.status_code == 200, practice.text
        assert practice.json()["ai_preparation"] is None

        async def issue():
            worker = Worker(database_config)
            try:
                await worker.scheduler.tick()
            finally:
                await worker.close()

        asyncio.run(issue())
        card = next(
            c for c in client.get("/api/cards").json() if c["session_id"] == practice.json()["id"]
        )
        for kind, payload in [
            ("deliver", {}),
            ("open", {}),
            *[
                ("status_change", {"state": state, "comment": "Учебная карточка отработана"})
                for state in ["accepted", "responding", "completed"]
            ],
        ]:
            response = client.post(
                f"/api/cards/{card['id']}/events", json=event(kind, payload), headers=headers
            )
            assert response.status_code == 200, response.text
        assert client.get(f"/api/cards/{card['id']}").json()["closed_at"] is not None
    assert generation_count() == before


@pytest.mark.parametrize(
    ("score", "critical", "override", "expected"),
    [(0.95, False, None, 3), (0.3, False, None, 1), (0.95, True, None, 1), (0.95, False, 0.2, 1)],
)
def test_level_uses_completed_scored_history_and_teacher_overrides(
    database_config, database_url, score, critical, override, expected
):
    async def check():
        database = Database(database_url)
        try:
            async with database.sessions.begin() as db:
                teacher = await db.scalar(select(User).where(User.role == "teacher"))
                sample = await db.scalar(select(User).where(User.login == "trainee01"))
                user = User(
                    login="history-" + uuid4().hex,
                    password_hash=sample.password_hash,
                    role="trainee",
                    full_name="Учебная история",
                    is_active=True,
                    workstation_number=None,
                    dds_service_id="GKH",
                )
                db.add(user)
                await db.flush()
                scenario = await generate_one(
                    db,
                    ScriptedLLM(),
                    scenario_id=uuid4(),
                    author_id=teacher.id,
                    service_id="GKH",
                    level=2,
                    seed=0,
                    auto_admit=True,
                )
                now = datetime.now(UTC)
                lesson = Session(
                    teacher_id=teacher.id,
                    title="Завершённая история",
                    status="finished",
                    started_at=now - timedelta(hours=2),
                    finished_at=now,
                    settings_snapshot={
                        "reaction_normative_s": 30,
                        "handling_normative_s": 180,
                        "weights": {key: int(key == "status_flow") for key in CRITERIA},
                        "critical_cap": 0.5,
                        "parallel_cards": 1,
                        "hints_level": 1,
                    },
                    timing_policy=None,
                )
                db.add(lesson)
                await db.flush()
                participant = Participant(
                    session_id=lesson.id,
                    user_id=user.id,
                    workstation_id=1,
                    dds_service_id="GKH",
                    level=2,
                    rating_at_start=0,
                )
                db.add(participant)
                await db.flush()
                assert (await recommend_for_participant(db, participant)).level == 2
                for index in range(4):
                    assignment = Assignment(
                        session_id=lesson.id,
                        participant_id=participant.id,
                        scenario_id=scenario.id,
                        scenario_version=1,
                        order=index + 1,
                        status="completed",
                        planned_at=now - timedelta(minutes=5),
                    )
                    db.add(assignment)
                    await db.flush()
                    at = now - timedelta(minutes=4 - index)
                    card = Card(
                        assignment_id=assignment.id,
                        number=str(index + 10_000_000),
                        state="refused" if index < 3 else "arrived",
                        appeared_at=at - timedelta(seconds=60),
                        delivered_at=at - timedelta(seconds=55),
                        opened_at=at - timedelta(seconds=50),
                        first_status_at=at - timedelta(seconds=45),
                        closed_at=at if index < 3 else None,
                        current={"service_number": "1", "comment": "Готово"},
                        redirected_to_service_id=None,
                    )
                    db.add(card)
                    await db.flush()
                    evaluation = Evaluation(
                        card_id=card.id,
                        version=1,
                        rules_scores={"status_flow": score},
                        semantic_scores=None,
                        llm_scores=None,
                        total=score,
                        critical_flags=["test-critical"] if critical else [],
                        explanation={},
                        model_info={},
                        status="partial",
                    )
                    db.add(evaluation)
                    await db.flush()
                    db.add(
                        Evaluation(
                            card_id=card.id,
                            version=2,
                            rules_scores={},
                            semantic_scores=None,
                            llm_scores=None,
                            total=0,
                            critical_flags=[],
                            explanation={},
                            model_info={},
                            status="partial",
                        )
                    )
                    if override is not None:
                        db.add(
                            TeacherOverride(
                                evaluation_id=evaluation.id,
                                teacher_id=teacher.id,
                                decision="disagree",
                                new_total=override,
                                criterion_patches={},
                                reason="Учебная корректировка",
                                teacher_comment="Исправлено преподавателем",
                            )
                        )
                await db.flush()
                result = await recommend_for_participant(db, participant)
                assert result.based_on_attempts == 3 and result.level == expected
                participant.dds_service_id = "101"
                unrelated = await recommend_for_participant(db, participant)
                assert unrelated.based_on_attempts == 0 and unrelated.level == 2
        finally:
            await database.close()

    asyncio.run(check())
