"""Ступени обучения (29.09): прогресс обучаемого и тренировка по ступени."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

from app.api.database import create_database_app
from app.api.progress.service import is_tutorial
from app.core.models import Assignment, Scenario, User
from evalcore.progress import StepAttempt
from fastapi.testclient import TestClient
from sqlalchemy import select

from . import test_evaluations as t9
from .test_c04_completion import seed_training
from .test_lifecycle import login, run_db

evaluation_case = t9.evaluation_case
TRAINEE = "trainee04"
T0 = datetime(2026, 9, 29, 10, tzinfo=UTC)


def practice(client, headers, step: int, expected: int = 200):
    response = client.post(f"/api/practice?step={step}", headers=headers)
    assert response.status_code == expected, response.text
    return response.json()


def issued(database_url, session_id: str) -> list[tuple[int, bool, str]]:
    """Уровень, «упражнение ли» и служба сценариев, выданных в тренировку."""

    async def read(db):
        rows = await db.scalars(
            select(Scenario)
            .join(Assignment, Assignment.scenario_id == Scenario.id)
            .where(Assignment.session_id == UUID(session_id))
            .order_by(Assignment.order)
        )
        return [(item.level, is_tutorial(item), item.target_service_id) for item in rows]

    return run_db(database_url, read)


def service_of(database_url, login_name: str) -> str | None:
    async def read(db):
        return await db.scalar(select(User.dds_service_id).where(User.login == login_name))

    return run_db(database_url, read)


def test_new_trainee_is_on_step_one_and_further_steps_are_locked(database_config, database_url):
    seed_training(database_url)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        [own] = client.get("/api/progress").json()
        assert own["current_step"] == 1
        assert [step["unlocked"] for step in own["steps"]] == [True, False, False, False]
        locked = client.post("/api/practice?step=2", headers=headers)
        assert locked.status_code == 409
        assert locked.json()["code"] == "step_locked"
        assert client.post("/api/practice?step=5", headers=headers).status_code == 422
        tutorial = practice(client, headers, 1)
        assert tutorial["settings_snapshot"]["hints_level"] == 1
        # Разбор попытки («Повторить ступень») берёт номер ступени из этого заголовка.
        assert tutorial["title"].startswith("Тренировка: ступень 1 — ")
    [(level, tutorial_card, _)] = issued(database_url, tutorial["id"])
    assert tutorial_card


def test_open_steps_give_own_service_scenarios_of_their_level(
    database_config, database_url, monkeypatch
):
    seed_training(database_url)

    async def history(db, user_id):
        levels = [(1, True)] + [(1, False)] * 3 + [(2, False)] * 3
        return [
            StepAttempt(level, tutorial, True, T0 + timedelta(minutes=index))
            for index, (level, tutorial) in enumerate(levels)
        ]

    monkeypatch.setattr("app.api.progress.service.trainee_attempts", history)
    own_service = service_of(database_url, TRAINEE)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        second = practice(client, headers, 2)
        assert second["settings_snapshot"]["hints_level"] == 0
        assert second["title"] == "Тренировка: ступень 2 — Своя карточка"
        [(level, tutorial_card, service)] = issued(database_url, second["id"])
        assert (level, tutorial_card) == (1, False)
        assert own_service is None or service == own_service
        fourth = practice(client, headers, 4)
        assert fourth["settings_snapshot"]["parallel_cards"] == 2
        cards = issued(database_url, fourth["id"])
        assert len(cards) == 2 and all(level in (3, 4) for level, _, _ in cards)
        assert fourth["participants"][0]["level"] == 4
        sessions = {item["id"]: item for item in client.get("/api/sessions").json()}
        # Новая тренировка закрывает прежнюю.
        assert sessions[second["id"]]["status"] == "finished"

    with TestClient(create_database_app(database_config)) as teacher:
        login(teacher)
        everyone = {item["full_name"]: item for item in teacher.get("/api/progress").json()}
        assert everyone and all(item["current_step"] == 4 for item in everyone.values())


def test_evaluated_lesson_card_counts_for_its_step(database_config, database_url, evaluation_case):
    def attempts() -> int:
        with TestClient(create_database_app(database_config)) as client:
            login(client, "trainee01")
            [own] = client.get("/api/progress").json()
        return sum(step["attempts"] for step in own["steps"])

    # База общая для всех тестов: у обучаемого могут быть карточки других тестов.
    before = attempts()
    t9.close_card(database_config, evaluation_case["card_id"])
    assert attempts() == before + 1
