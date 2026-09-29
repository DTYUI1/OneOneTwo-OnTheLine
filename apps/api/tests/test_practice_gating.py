"""Тренировка обучаемого и доклады бригады, которые ждут решения диспетчера (requires_state)."""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from app.api.database import create_database_app
from app.api.training.gating import awaiting_state, gate_opened_at
from app.core.contracts import validate_json
from app.core.db import Database
from app.core.models import Call, Card, MessageDelivery, Scenario, ScenarioTrainingPlan
from app.worker.training import TrainingScheduler
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from . import test_c03_sessions as c03
from .test_c04_completion import seed_training
from .test_lifecycle import event, login, run_db

# Отдельный обучаемый: у остальных тестов общей БД могут идти свои занятия.
TRAINEE = "trainee04"


def planned(message_id: str, requires: str | None = None) -> dict:
    item = {"message": {"id": message_id, "version": 1}, "available_after_s": 3}
    if requires:
        item["requires_state"] = requires
    return item


def test_gate_waits_for_status_and_counts_from_it():
    at = datetime(2026, 9, 27, 10, 0, tzinfo=UTC)
    statuses = [("accepted", at), ("arrived", at + timedelta(seconds=40))]
    assert gate_opened_at(planned(str(uuid4())), []) is not None
    assert gate_opened_at(planned(str(uuid4()), "accepted"), []) is None
    assert gate_opened_at(planned(str(uuid4()), "accepted"), statuses) == at
    # «Прибыла» без «Выезда» тоже открывает доклад, ждущий выезда: статус дальше по ходу дела.
    assert gate_opened_at(planned(str(uuid4()), "responding"), statuses) == at + timedelta(
        seconds=40
    )
    assert gate_opened_at(planned(str(uuid4()), "accepted"), [("rejected", at)]) is None


def test_awaiting_state_names_only_the_next_blocked_report():
    at = datetime(2026, 9, 27, 10, 0, tzinfo=UTC)
    first, second = str(uuid4()), str(uuid4())
    plan = [planned(first, "accepted"), planned(second, "responding")]
    assert awaiting_state(plan, set(), []) == "accepted"
    # Статус есть, доклад ещё в паузе available_after_s — подсказывать нечего.
    assert awaiting_state(plan, set(), [("accepted", at)]) is None
    assert awaiting_state(plan, {(UUID(first), 1)}, [("accepted", at)]) == "responding"
    assert awaiting_state(plan, {(UUID(first), 1), (UUID(second), 1)}, []) is None


def practice(client, headers, expected=200):
    response = client.post("/api/practice", headers=headers)
    assert response.status_code == expected, response.text
    return response.json()


def send(client, headers, card_id, kind, payload, expected=200):
    body = event(kind, payload)
    body["client_ts"] = body["client_ts"].replace("+00:00", "Z")
    response = client.post(f"/api/cards/{card_id}/events", json=body, headers=headers)
    assert response.status_code == expected, response.text
    return response


def refusal(url, call_id) -> str | None:
    async def read(db):
        return (await db.get(Call, UUID(call_id))).refusal

    return run_db(url, read)


def deliveries(url, card_id) -> int:
    async def count(db):
        return await db.scalar(
            select(func.count())
            .select_from(MessageDelivery)
            .where(MessageDelivery.card_id == card_id)
        )

    return run_db(url, count)


def worker_tick(url, now):
    async def run():
        database = Database(url)
        try:
            return await TrainingScheduler(database.sessions).tick(now)
        finally:
            await database.close()

    return asyncio.run(run())


def test_practice_reports_follow_dispatcher_decisions(database_config, database_url):
    seed_training(database_url)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        me = client.get("/api/auth/me").json()
        session = practice(client, headers)
        validate_json(session, "urn:openapi#/components/schemas/Session")
        assert session["kind"] == "practice"
        assert session["status"] == "running"
        assert session["settings_snapshot"]["hints_level"] == 1
        assert session["participants"][0]["user_id"] == me["id"]

        with TestClient(create_database_app(database_config)) as teacher:
            login(teacher)
            ids = [s["id"] for s in teacher.get("/api/sessions").json()]
            assert session["id"] not in ids

        assert c03.tick(database_url) >= 1
        card = next(c for c in client.get("/api/cards").json() if c["session_id"] == session["id"])
        service_id = session["participants"][0]["dds_service_id"]
        brigade_id = str(uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:brigade:0"))
        target_id = str(uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:target:0"))
        card_id = card["id"]

        def call_brigade() -> str:
            call_id = str(uuid4())
            send(
                client,
                headers,
                card_id,
                "call_dial_target",
                {"call_id": call_id, "call_target_id": target_id, "brigade_id": brigade_id},
            )
            send(client, headers, card_id, "call_answer", {"call_id": call_id})
            return call_id

        send(client, headers, card_id, "deliver", {})
        # Бригаду направляют после решения реагировать: до «Принята» выбор отклоняется.
        refused = send(
            client, headers, card_id, "brigades_select", {"brigade_ids": [brigade_id]}, 409
        )
        assert refused.json()["code"] == "decision_required"

        # Ошибочная «Не принята» остаётся в журнале, но обучаемый может
        # исправить решение на «Принята» и продолжить доклады без нового занятия.
        send(
            client,
            headers,
            card_id,
            "status_change",
            {"state": "rejected", "comment": "Ошибочно не принята, исправляю решение"},
        )

        # Позвонить бригаде можно и до решения: она ответит, что вызов ей не назначен.
        early_call = call_brigade()
        assert refusal(database_url, early_call) == "not_assigned"
        training = client.get(f"/api/cards/{card_id}/training").json()
        validate_json(training, "urn:openapi#/components/schemas/CardTraining")
        assert training["messages"] == []
        assert training["awaiting_state"] == "accepted"
        assert "Горение" not in str(training) and "expected_comment" not in str(training)

        # Бригада на связи минуту, но на происшествие её не направляли — докладов нет.
        later = datetime.now(UTC) + timedelta(seconds=60)
        assert worker_tick(database_url, later) == 0
        assert deliveries(database_url, UUID(card_id)) == 0

        send(client, headers, card_id, "status_change", {"state": "accepted", "comment": "Принята"})
        send(client, headers, card_id, "brigades_select", {"brigade_ids": [brigade_id]})
        # Направили во время отказного разговора — в нём бригада всё равно не докладывает.
        assert worker_tick(database_url, later) == 0
        send(client, headers, card_id, "call_hangup", {"call_id": early_call})

        call_id = call_brigade()
        assert refusal(database_url, call_id) is None
        later = datetime.now(UTC) + timedelta(seconds=60)
        assert worker_tick(database_url, later) == 1
        assert worker_tick(database_url, later + timedelta(seconds=60)) == 0
        training = client.get(f"/api/cards/{card_id}/training").json()
        assert len(training["messages"]) == 1
        assert training["awaiting_state"] == "responding"
        assert "responding" in training["missing_report_states"]

        blocked = send(
            client,
            headers,
            card_id,
            "status_change",
            {"state": "responding", "comment": "Бригада выехала"},
            409,
        )
        assert blocked.json()["code"] == "report_required"
        first = training["messages"][0]["delivery"]
        send(
            client,
            headers,
            card_id,
            "message_presented",
            {
                "delivery_id": first["delivery_id"],
                "message_version": first["message"]["version"],
                "playback_id": str(uuid4()),
                "channel": "audio",
                "audio_version": first["message"]["audio"]["version"],
            },
        )
        assert (
            "responding"
            not in client.get(f"/api/cards/{card_id}/training").json()["missing_report_states"]
        )

        send(
            client,
            headers,
            card_id,
            "status_change",
            {"state": "responding", "comment": "Бригада выехала"},
        )
        assert worker_tick(database_url, later + timedelta(seconds=70)) == 1
        assert client.get(f"/api/cards/{card_id}/training").json()["awaiting_state"] == "arrived"

        # Повторная тренировка закрывает прежнюю: карточка прервана, звонок завершён.
        again = practice(client, headers)
        assert again["id"] != session["id"]
        assert client.get(f"/api/sessions/{session['id']}").json()["status"] == "finished"

        async def interrupted(db):
            return (await db.get(Card, UUID(card_id))).interrupted_at is not None

        assert run_db(database_url, interrupted)


def test_practice_is_blocked_during_teacher_lesson(database_config, database_url):
    seed_training(database_url)
    with TestClient(create_database_app(database_config)) as teacher:
        teacher_headers = login(teacher)
        users = {u["login"]: u for u in teacher.get("/api/users").json()}
        created = teacher.post(
            "/api/sessions",
            headers=teacher_headers,
            json={
                "title": "Занятие поверх тренировки",
                "participants": [
                    {
                        "user_id": users["trainee05"]["id"],
                        "workstation_number": 5,
                        "dds_service_id": "102",
                        "level": 1,
                    }
                ],
                "settings_snapshot": teacher.get("/api/settings").json(),
            },
        )
        assert created.status_code == 201, created.text
        session_id = created.json()["id"]
        scenario = next(
            s for s in teacher.get("/api/scenarios").json() if s["status"] == "approved"
        )
        assigned = teacher.post(
            f"/api/sessions/{session_id}/assignments",
            headers=teacher_headers,
            json={
                "participant_id": users["trainee05"]["id"],
                "scenario_id": scenario["id"],
                "order": 1,
                "planned_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
            },
        )
        assert assigned.status_code == 201, assigned.text
        assert teacher.post(f"/api/sessions/{session_id}/start", headers=teacher_headers)
        with TestClient(create_database_app(database_config)) as trainee:
            headers = login(trainee, "trainee05")
            blocked = practice(trainee, headers, expected=409)
            assert blocked["code"] == "lesson_running"
            assert trainee.post("/api/sessions", headers=headers, json={}).status_code in {403, 422}
        teacher.post(
            f"/api/sessions/{session_id}/finish",
            headers=teacher_headers,
            json={"contract_version": 2, "request_id": str(uuid4())},
        )


def test_tutorial_plan_gates_every_report(database_url):
    seed_training(database_url)

    async def plans(db):
        rows = await db.scalars(
            select(ScenarioTrainingPlan)
            .join(Scenario, Scenario.id == ScenarioTrainingPlan.scenario_id)
            .where(Scenario.teacher_comment.like("Обучающее упражнение%"))
        )
        return [row.plan for row in rows]

    found = run_db(database_url, plans)
    assert found
    for plan in found:
        assert [m.get("requires_state") for m in plan["messages"]] == [
            "accepted",
            "responding",
            "arrived",
            "working",
        ]
        validate_json(plan, "urn:openapi#/components/schemas/TrainingPlan")


def test_trainee_finishes_only_own_practice(database_config, database_url):
    """Тренировку раньше не закрыть ничем, кроме новой: обучаемый завершает свою сам
    (контракт finishSession — teacher и trainee), чужую тренировку и занятие — нет."""
    seed_training(database_url)
    with TestClient(create_database_app(database_config)) as other:
        other_headers = login(other, "trainee04")
        foreign = practice(other, other_headers)
    with TestClient(create_database_app(database_config)) as trainee:
        headers = login(trainee, "trainee05")
        own = practice(trainee, headers)
        denied = trainee.post(f"/api/sessions/{foreign['id']}/finish", headers=headers)
        assert denied.status_code == 404, denied.text
        # Идемпотентное завершение с телом (C-03) — только у преподавателя.
        body = {"contract_version": 2, "request_id": str(uuid4())}
        extended = trainee.post(f"/api/sessions/{own['id']}/finish", headers=headers, json=body)
        assert extended.status_code == 403, extended.text
        finished = trainee.post(f"/api/sessions/{own['id']}/finish", headers=headers)
        assert finished.status_code == 200, finished.text
        assert finished.json()["status"] == "finished"
    with TestClient(create_database_app(database_config)) as teacher:
        teacher_headers = login(teacher)
        users = {u["login"]: u for u in teacher.get("/api/users").json()}
        created = teacher.post(
            "/api/sessions",
            headers=teacher_headers,
            json={
                "title": "Занятие, которое обучаемый не завершает",
                "participants": [
                    {
                        "user_id": users["trainee05"]["id"],
                        "workstation_number": 5,
                        "dds_service_id": "102",
                        "level": 1,
                    }
                ],
                "settings_snapshot": teacher.get("/api/settings").json(),
            },
        )
        assert created.status_code == 201, created.text
        lesson_id = created.json()["id"]
    with TestClient(create_database_app(database_config)) as trainee:
        headers = login(trainee, "trainee05")
        lesson = trainee.post(f"/api/sessions/{lesson_id}/finish", headers=headers)
        assert lesson.status_code == 404, lesson.text
    # База общая на весь прогон: не оставлять идущей тренировки и занятия другим тестам.
    with TestClient(create_database_app(database_config)) as other:
        other_headers = login(other, "trainee04")
        closed = other.post(f"/api/sessions/{foreign['id']}/finish", headers=other_headers)
        assert closed.status_code == 200, closed.text
    with TestClient(create_database_app(database_config)) as teacher:
        teacher.post(
            f"/api/sessions/{lesson_id}/finish",
            headers=login(teacher),
            json={"contract_version": 2, "request_id": str(uuid4())},
        )
