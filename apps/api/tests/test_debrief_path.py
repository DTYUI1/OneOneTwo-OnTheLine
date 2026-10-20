"""TC-11: прошлая рекомендация отмечается новой попыткой, незачтённый сценарий возвращается
в «Мой путь» повтором с «было → стало». Реальный PostgreSQL: у каждого теста свой новый
обучаемый, чтобы карточки других тестов общей базы не смешивались с его историей.
"""

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from app.api.database import create_database_app
from app.api.foundation.repo import training_settings
from app.api.sessions.practice import step_pool, tutorial_scenario_id
from app.core.models import Assignment, Card, Evaluation, Participant, Scenario, Session, User
from evalcore.progress import step_by_number
from fastapi.testclient import TestClient
from sqlalchemy import select

from .test_c04_completion import seed_training
from .test_lifecycle import login, run_db

PASSWORD = "class-2026-pass"
SERVICE = "101"
T0 = datetime(2026, 10, 16, 9, tzinfo=UTC)
NOT_REQUIRED_CALL = {
    "explanation": "Звонок оценён",
    "evidence": ["Обязательный звонок не предусмотрен эталоном"],
    "remarks": [],
}


def new_trainee(database_config) -> str:
    with TestClient(create_database_app(database_config)) as admin:
        headers = login(admin, "admin")
        body = {
            "login": f"t{uuid4().hex[:10]}",
            "full_name": "Сидоров Семён",
            "role": "trainee",
            "password": PASSWORD,
            "workstation_number": 5,
            "dds_service_id": SERVICE,
        }
        response = admin.post("/api/users", json=body, headers=headers)
        assert response.status_code == 201, response.text
    return body["login"]


def enter(client: TestClient, name: str) -> dict[str, str]:
    response = client.post("/api/auth/login", json={"login": name, "password": PASSWORD})
    assert response.status_code == 200, response.text
    return {"X-CSRF-Token": client.cookies["csrf"]}


def progress(database_config, name: str) -> dict[str, Any]:
    with TestClient(create_database_app(database_config)) as client:
        enter(client, name)
        [own] = client.get("/api/progress").json()
    return own


def attempt(
    database_url: str,
    name: str,
    scenario_id: UUID,
    at: datetime,
    *,
    total: float,
    scores: dict[str, float],
    explanation: dict[str, Any] | None = None,
) -> UUID:
    """Закрытая оценённая карточка обучаемого: тренировка, участник, назначение, оценка."""
    card_id = uuid4()

    async def insert(db):
        user = await db.scalar(select(User).where(User.login == name))
        scenario = await db.get(Scenario, scenario_id)
        settings = await training_settings(db)
        session = Session(
            teacher_id=user.id,
            title="Тренировка TC-11",
            status="finished",
            kind="practice",
            started_at=at,
            finished_at=at + timedelta(minutes=5),
            settings_snapshot=settings.value,
            timing_policy=None,
        )
        db.add(session)
        await db.flush()
        participant = Participant(
            session_id=session.id,
            user_id=user.id,
            workstation_id=1,
            dds_service_id=scenario.target_service_id,
            level=1,
            rating_at_start=0.0,
        )
        db.add(participant)
        await db.flush()
        assignment = Assignment(
            session_id=session.id,
            participant_id=participant.id,
            scenario_id=scenario.id,
            scenario_version=scenario.version,
            order=1,
            planned_at=at,
            status="completed",
        )
        db.add(assignment)
        await db.flush()
        db.add(
            Card(
                id=card_id,
                assignment_id=assignment.id,
                number=scenario.card["number"],
                state="completed",
                appeared_at=at,
                delivered_at=at,
                opened_at=at,
                first_status_at=at,
                closed_at=at + timedelta(minutes=3),
                current={"service_number": "1", "comment": "Работы завершены"},
                redirected_to_service_id=None,
            )
        )
        await db.flush()
        db.add(
            Evaluation(
                card_id=card_id,
                version=1,
                rules_scores=scores,
                semantic_scores=None,
                llm_scores=None,
                total=total,
                critical_flags=[],
                explanation=explanation or {},
                model_info={"rules": "test"},
                status="complete",
            )
        )

    run_db(database_url, insert)
    return card_id


def test_previous_advice_is_marked_done_by_next_attempt(database_config, database_url):
    seed_training(database_url)
    name = new_trainee(database_config)
    scenario = tutorial_scenario_id(SERVICE)

    attempt(
        database_url,
        name,
        scenario,
        T0,
        total=0.6,
        scores={"address": 0.2, "call": 0.4, "status_flow": 1.0},
    )
    advice = progress(database_config, name)["advice"]
    assert [item["criterion"] for item in advice["focus"]] == ["address", "call"]
    # Одна попытка — сверять прошлую рекомендацию не с чем.
    assert advice["previous"] is None

    second = attempt(
        database_url,
        name,
        scenario,
        T0 + timedelta(hours=1),
        total=0.8,
        scores={"address": 1.0, "call": 0.4, "status_flow": 1.0},
    )
    previous = progress(database_config, name)["advice"]["previous"]
    assert previous["card_id"] == str(second)
    assert {item["criterion"]: item["status"] for item in previous["focus"]} == {
        "address": "done",
        "call": "not_done",
    }
    assert all(item["label"] and item["text"] for item in previous["focus"])

    # Прошлая рекомендация — по двум первым карточкам: звонок 0,4, адрес 0,6 в среднем.
    # В новой попытке звонок «не предусмотрен» — его 100 % не значит, что совет выполнен.
    third = attempt(
        database_url,
        name,
        scenario,
        T0 + timedelta(hours=2),
        total=0.7,
        scores={"address": 0.5, "call": 1.0, "status_flow": 1.0},
        explanation={"call": NOT_REQUIRED_CALL},
    )
    previous = progress(database_config, name)["advice"]["previous"]
    assert previous["card_id"] == str(third)
    assert [(item["criterion"], item["status"]) for item in previous["focus"]] == [
        ("call", "unchecked"),
        ("address", "not_done"),
    ]


def test_failed_scenario_returns_as_repeat_in_my_path(database_config, database_url):
    seed_training(database_url)
    name = new_trainee(database_config)

    async def pick(db):
        return [item.id for item in await step_pool(db, step_by_number(2), SERVICE)]

    scenario_id = run_db(database_url, pick)[0]
    full = {"status_flow": 1.0, "address": 1.0}
    # Упражнение зачтено — ступень 2 открыта; упражнение в повтор не идёт.
    attempt(database_url, name, tutorial_scenario_id(SERVICE), T0, total=0.95, scores=full)
    assert progress(database_config, name)["repeats"] == []

    failed = attempt(
        database_url,
        name,
        scenario_id,
        T0 + timedelta(hours=1),
        total=0.45,
        scores={"status_flow": 0.5, "address": 0.4},
    )
    [repeat] = progress(database_config, name)["repeats"]
    assert repeat["scenario_id"] == str(scenario_id)
    assert (repeat["step"], repeat["was"], repeat["now"], repeat["passed"]) == (
        2,
        0.45,
        None,
        False,
    )
    assert repeat["last_card_id"] == str(failed)
    assert repeat["number"] and repeat["incident_class"]

    with TestClient(create_database_app(database_config)) as client:
        headers = enter(client, name)
        other = client.post(f"/api/practice?scenario_id={uuid4()}", headers=headers)
        assert other.status_code == 409, other.text
        assert other.json()["code"] == "repeat_unavailable"
        mismatch = client.post(f"/api/practice?scenario_id={scenario_id}&step=3", headers=headers)
        assert mismatch.status_code == 422, mismatch.text
        started = client.post(f"/api/practice?scenario_id={scenario_id}", headers=headers)
        assert started.status_code == 200, started.text
        session = started.json()
        # Заголовок — как у тренировки ступени: разбор берёт из него номер ступени.
        assert session["title"] == "Тренировка: ступень 2 — Своя карточка"

    async def issued(db):
        return list(
            await db.scalars(
                select(Assignment.scenario_id).where(Assignment.session_id == UUID(session["id"]))
            )
        )

    assert run_db(database_url, issued) == [scenario_id]

    fixed = attempt(
        database_url, name, scenario_id, T0 + timedelta(hours=2), total=0.82, scores=full
    )
    [repeat] = progress(database_config, name)["repeats"]
    assert (repeat["was"], repeat["now"], repeat["passed"]) == (0.45, 0.82, True)
    assert repeat["last_card_id"] == str(fixed)
