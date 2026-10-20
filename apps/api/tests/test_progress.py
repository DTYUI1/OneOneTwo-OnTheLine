"""Ступени обучения (29.09): прогресс обучаемого и тренировка по ступени."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

from app.api.database import create_database_app
from app.api.progress.service import is_tutorial, parallel_shift
from app.api.sessions.background import LEVEL_COUNTS, catalog
from app.core.models import Assignment, Card, Evaluation, Participant, Scenario, Session, User
from evalcore.progress import StepAttempt
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

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


def assigned(database_url, session_id: str) -> list[UUID]:
    async def read(db):
        return list(
            await db.scalars(
                select(Assignment.scenario_id)
                .where(Assignment.session_id == UUID(session_id))
                .order_by(Assignment.order)
            )
        )

    return run_db(database_url, read)


def demo_ids() -> set[UUID]:
    from app.api.sessions.practice import audio_scenario_id

    services = ("101", "102", "103", "104")
    return {audio_scenario_id("audio-demo-v3", service) for service in services}


def test_parallel_shift_marks_cards_of_a_shift_with_two_at_once():
    lesson = Session(settings_snapshot={"parallel_cards": 2})
    single = Session(settings_snapshot={"parallel_cards": 1})
    assert parallel_shift(lesson, Participant(level=2), 2)
    # Одна карточка в смене, одна карточка за раз или уровень участника 1 — не параллельная.
    assert not parallel_shift(lesson, Participant(level=2), 1)
    assert not parallel_shift(single, Participant(level=4), 3)
    assert not parallel_shift(lesson, Participant(level=1), 3)


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
        assert [step["unlocked"] for step in own["steps"]] == [True, False, False, False, False]
        locked = client.post("/api/practice?step=2", headers=headers)
        assert locked.status_code == 409
        assert locked.json()["code"] == "step_locked"
        assert client.post("/api/practice?step=6", headers=headers).status_code == 422
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
        # HQ-032: смена из двух разных проработанных сценариев уровней 1–2 одной службы,
        # без демо «Дубнинская, 1».
        assert len(cards) == 2 and all(level in (1, 2) and not tut for level, tut, _ in cards)
        assert len({service for _, _, service in cards}) == 1
        assert own_service is None or cards[0][2] == own_service
        scenario_ids = assigned(database_url, fourth["id"])
        assert len(set(scenario_ids)) == 2
        assert not set(scenario_ids) & demo_ids()
        # Ёмкость смены — parallel_cards (две карточки), а уровень участника — 4: фон и
        # нагрузка ступени 4 как до HQ-032, а не как на ступени 3.
        assert fourth["participants"][0]["level"] == 4
        service = fourth["participants"][0]["dds_service_id"]
        background = client.get(f"/api/sessions/{fourth['id']}/background-cards").json()
        assert len(background) == min(LEVEL_COUNTS[4], len(catalog()[service]))
        sessions = {item["id"]: item for item in client.get("/api/sessions").json()}
        # Новая тренировка закрывает прежнюю.
        assert sessions[second["id"]]["status"] == "finished"

    with TestClient(create_database_app(database_config)) as teacher:
        login(teacher)
        everyone = {item["full_name"]: item for item in teacher.get("/api/progress").json()}
        assert everyone and all(item["current_step"] == 4 for item in everyone.values())


def unlocked_up_to_four(monkeypatch):
    """История, открывающая ступень 4: подменяется только на время запуска тренировки."""

    async def history(db, user_id):
        levels = [(1, True)] + [(1, False)] * 3 + [(2, False)] * 3
        return [
            StepAttempt(level, tutorial, True, T0 + timedelta(minutes=index))
            for index, (level, tutorial) in enumerate(levels)
        ]

    monkeypatch.setattr("app.api.progress.service.trainee_attempts", history)


def test_step_four_pair_is_one_level_one_and_one_level_two(
    database_config, database_url, monkeypatch
):
    """HQ-032 (лист решений 18.10): пара ступени 4 — одна карточка уровня 1 и одна уровня 2
    своей службы; выбор случайный, поэтому несколько смен подряд."""
    from app.api.sessions.practice import step_pool
    from evalcore.progress import STEPS

    seed_training(database_url)
    unlocked_up_to_four(monkeypatch)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        shifts = [practice(client, headers, 4) for _ in range(4)]
    for shift in shifts:
        cards = issued(database_url, shift["id"])
        service = cards[0][2]
        pool = run_db(database_url, lambda db, service=service: step_pool(db, STEPS[3], service))
        assert {item.level for item in pool} == {1, 2}, "в засеве нет пары уровней"
        assert sorted(level for level, _, _ in cards) == [1, 2]


def test_other_levels_first_falls_back_to_same_level():
    from app.api.sessions.practice import other_levels_first

    one, two, three = (Scenario(level=level) for level in (1, 1, 2))
    assert other_levels_first([one, two, three], {1}) == [three, one, two]
    # [ASSUMPTION] другого уровня нет — пара из одного уровня, порядок прежний.
    assert other_levels_first([one, two], {1}) == [one, two]


def test_final_shift_gives_three_catalog_cards_of_one_service(
    database_config, database_url, monkeypatch
):
    """HQ-033: ступень 5 — финальная смена из трёх проработанных сценариев каталога одной
    службы, по возможности разных происшествий; карточки через 20 с, final_shift в снимке."""
    from app.api.sessions.practice import catalog_trains, latest_plans

    seed_training(database_url)

    async def history(db, user_id):
        levels = [(1, True, False)] + [(1, False, False)] * 3 + [(2, False, False)] * 3
        levels += [(1, False, True)] * 3
        return [
            StepAttempt(level, tutorial, True, T0 + timedelta(minutes=index), parallel)
            for index, (level, tutorial, parallel) in enumerate(levels)
        ]

    monkeypatch.setattr("app.api.progress.service.trainee_attempts", history)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        [own] = client.get("/api/progress").json()
        assert own["current_step"] == 5 and own["steps"][4]["unlocked"]
        final = practice(client, headers, 5)
    assert final["title"] == "Тренировка: ступень 5 — Финальная смена"
    assert final["settings_snapshot"]["final_shift"] is True
    assert final["settings_snapshot"]["parallel_cards"] == 3
    assert final["participants"][0]["level"] == 4
    cards = issued(database_url, final["id"])
    assert len(cards) == 3 and len({service for _, _, service in cards}) == 1

    async def read(db):
        rows = list(
            await db.execute(
                select(Assignment.planned_at, Scenario)
                .join(Scenario, Scenario.id == Assignment.scenario_id)
                .where(Assignment.session_id == UUID(final["id"]))
                .order_by(Assignment.order)
            )
        )
        plans = await latest_plans(db, [scenario for _, scenario in rows])
        return rows, plans

    rows, plans = run_db(database_url, read)
    gaps = [(b[0] - a[0]).total_seconds() for a, b in zip(rows, rows[1:], strict=False)]
    assert gaps == [20.0, 20.0]
    # Только проработанные сценарии каталога — с событиями и ветками.
    assert all(catalog_trains(scenario, plans.get(scenario.id)) for _, scenario in rows)
    incidents = {scenario.card.get("incident_class") for _, scenario in rows}
    assert len(incidents) >= 2


def close_first_card(database_url, session_id: str) -> tuple[int, UUID]:
    """Закрытая и оценённая карточка первого назначения тренировки: уровень её сценария
    и id карточки."""

    async def write(db):
        assignment = await db.scalar(
            select(Assignment)
            .where(Assignment.session_id == UUID(session_id))
            .order_by(Assignment.order)
            .limit(1)
        )
        now = datetime.now(UTC)
        card = Card(
            assignment_id=assignment.id,
            number=f"{now.microsecond:08d}",
            state="completed",
            appeared_at=now - timedelta(minutes=3),
            delivered_at=None,
            opened_at=None,
            first_status_at=None,
            closed_at=now,
            interrupted_at=None,
            current={"service_number": "", "comment": ""},
            redirected_to_service_id=None,
        )
        db.add(card)
        await db.flush()
        db.add(
            Evaluation(
                card_id=card.id,
                version=1,
                rules_scores={"flow": 1.0},
                semantic_scores=None,
                llm_scores=None,
                total=0.9,
                critical_flags=[],
                explanation={},
                model_info={},
                status="complete",
            )
        )
        return (await db.get(Scenario, assignment.scenario_id)).level, card.id

    return run_db(database_url, write)


def drop_card(database_url, card_id: UUID) -> None:
    """Убрать карточку close_first_card с оценкой: база общая для всех тестов."""

    async def write(db):
        await db.execute(delete(Evaluation).where(Evaluation.card_id == card_id))
        await db.execute(delete(Card).where(Card.id == card_id))

    run_db(database_url, write)


def set_service(database_url, login_name: str, service_id: str | None) -> None:
    async def write(db):
        user = await db.scalar(select(User).where(User.login == login_name))
        user.dds_service_id = service_id

    run_db(database_url, write)


def cancel_second(database_url, session_id: str) -> None:
    async def write(db):
        assignment = await db.scalar(
            select(Assignment).where(
                Assignment.session_id == UUID(session_id), Assignment.order == 2
            )
        )
        assignment.cancelled_at = datetime.now(UTC)

    run_db(database_url, write)


def test_parallel_shift_card_counts_for_step_four_only(database_config, database_url, monkeypatch):
    """HQ-032: карточка тренировки ступени 4 видна в /api/progress в ступени 4, а не в 2–3;
    отменённое второе назначение снимает признак смены — карточка идёт в ступень своего
    уровня."""
    seed_training(database_url)

    def attempts(client) -> dict[int, int]:
        [own] = client.get("/api/progress").json()
        return {step["number"]: step["attempts"] for step in own["steps"]}

    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        before = attempts(client)
        unlocked_up_to_four(monkeypatch)
        fourth = practice(client, headers, 4)
        monkeypatch.undo()
        level, card_id = close_first_card(database_url, fourth["id"])
        try:
            shift = attempts(client)
            assert shift[4] == before[4] + 1
            assert (shift[2], shift[3]) == (before[2], before[3])
            cancel_second(database_url, fourth["id"])
            single = attempts(client)
            assert single[4] == before[4]
            assert single[level + 1] == before[level + 1] + 1
            # «Пройти ещё раз» у обучаемого без службы: вторая карточка — той же службы, что
            # повторяемая, а не любой из пула всех служб.
            own_service = service_of(database_url, TRAINEE)
            set_service(database_url, TRAINEE, None)
            try:
                unlocked_up_to_four(monkeypatch)
                for _ in range(3):
                    response = client.post(f"/api/practice?step=4&again={card_id}", headers=headers)
                    assert response.status_code == 200, response.text
                    cards = issued(database_url, response.json()["id"])
                    assert len(cards) == 2 and len({service for _, _, service in cards}) == 1
            finally:
                monkeypatch.undo()
                set_service(database_url, TRAINEE, own_service)
        finally:
            drop_card(database_url, card_id)


def test_demo_practice_card_counts_for_no_step(database_config, database_url):
    """HQ-034: «Смотрю» и «Как сделал бы опытный» — показ курсором (`demo`): его зачтённая
    карточка не идёт ни в ступень 1, ни в какую другую; без `demo` — идёт как раньше."""
    seed_training(database_url)

    def attempts(client) -> dict[int, int]:
        [own] = client.get("/api/progress").json()
        return {step["number"]: step["attempts"] for step in own["steps"]}

    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        before = attempts(client)
        response = client.post("/api/practice?demo=expert", headers=headers)
        assert response.status_code == 200, response.text
        shown = response.json()
        assert shown["settings_snapshot"]["demo"] is True
        assert shown["settings_snapshot"]["demo_mode"] == "expert"
        _, card_id = close_first_card(database_url, shown["id"])
        try:
            assert attempts(client) == before
        finally:
            drop_card(database_url, card_id)
        own = practice(client, headers, 1)
        assert own["settings_snapshot"]["demo"] is False
        _, card_id = close_first_card(database_url, own["id"])
        try:
            assert attempts(client)[1] == before[1] + 1
        finally:
            drop_card(database_url, card_id)


def test_taken_over_demo_card_counts_for_step_one(database_config, database_url):
    """HQ-035 (лист решений 18.10): «Беру управление» в показе «Смотрю» — дальше карточку
    ведёт обучаемый, это попытка «Вместе»: после перехвата она идёт в ступень 1. Карточку,
    которую уже довёл курсор, перехватом задним числом не засчитать; показ опытного не
    перехватывают — вид показа хранит сервер."""
    seed_training(database_url)

    def attempts(client) -> dict[int, int]:
        [own] = client.get("/api/progress").json()
        return {step["number"]: step["attempts"] for step in own["steps"]}

    def take_over(client, headers, session_id: str):
        return client.post(f"/api/practice/{session_id}/take-over", headers=headers)

    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        before = attempts(client)
        # Курсор закрыл карточку «Смотрю» → перехват — 409, ступень не засчитана.
        shown = client.post("/api/practice?demo=watch", headers=headers).json()
        assert shown["settings_snapshot"]["demo"] is True
        assert shown["settings_snapshot"]["demo_mode"] == "watch"
        _, card_id = close_first_card(database_url, shown["id"])
        try:
            late = take_over(client, headers, shown["id"])
            assert late.status_code == 409
            assert late.json()["code"] == "demo_card_closed"
            assert attempts(client) == before
        finally:
            drop_card(database_url, card_id)
        # Показ опытного не перехватывают.
        expert = client.post("/api/practice?demo=expert", headers=headers).json()
        refused = take_over(client, headers, expert["id"])
        assert refused.status_code == 409
        assert refused.json()["code"] == "demo_not_watch"
        # Перехват посреди карточки → обучаемый закрывает её сам → засчитано.
        shown = client.post("/api/practice?demo=watch", headers=headers).json()
        response = take_over(client, headers, shown["id"])
        assert response.status_code == 200, response.text
        assert response.json()["settings_snapshot"]["demo"] is False
        # Повторный перехват ничего не меняет.
        again = take_over(client, headers, shown["id"])
        assert again.status_code == 200 and again.json()["settings_snapshot"]["demo"] is False
        _, card_id = close_first_card(database_url, shown["id"])
        try:
            assert attempts(client)[1] == before[1] + 1
        finally:
            drop_card(database_url, card_id)
        # Не своя или несуществующая тренировка — 404; закрытая — 409.
        missing = take_over(client, headers, "00000000-0000-4000-8000-000000000999")
        assert missing.status_code == 404
        assert missing.json()["code"] == "session_not_found"
        practice(client, headers, 1)
        closed = take_over(client, headers, shown["id"])
        assert closed.status_code == 409
        assert closed.json()["code"] == "session_not_running"


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
