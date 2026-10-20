"""HQ-033: проверка памяти посреди финальной смены (прототип A «Стоп-кадр», без паузы).

Верные ответы сервер фиксирует на момент показа и пишет в журнал первой карточки смены;
ответы сверяются с ними, итог — запись `memory_check_answer` «N из 3».
"""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from app.api.database import create_database_app
from app.api.sessions.memory_check import (
    ALL_MARKED,
    NONE_ON_SCENE,
    ShiftCard,
    build_questions,
    score,
)
from evalcore.models import EvalContext
from evalcore.progress import StepAttempt
from evalcore.scoring import evaluate
from fastapi.testclient import TestClient

from .test_c03_sessions import tick
from .test_c04_completion import seed_training
from .test_lifecycle import login
from .test_progress import T0, TRAINEE, practice

GOLDEN = Path(__file__).parents[3] / "data" / "golden_scenarios"
B1, B2, B3 = uuid4(), uuid4(), uuid4()
ROSTER = [(B1, "Бригада 1"), (B2, "Бригада 2"), (B3, "Бригада 3")]


def answers_of(questions):
    return {question["key"]: question["answer"] for question in questions}


def test_questions_use_numbered_brigade_names_without_extra_words():
    questions = build_questions(
        [(B1, "Бригада 201"), (B2, "Бригада 202")],
        {B1},
        [ShiftCard("11111111 — пожар", "arrived", (("arrived", B1),))],
    )
    assert questions[0]["why"] == "Свободно: 1 — Бригада 202."
    assert questions[1]["options"] == ["Бригада 201", "Бригада 202", NONE_ON_SCENE]
    assert questions[1]["answer"] == ["Бригада 201"]
    assert questions[1]["why"] == "На месте: Бригада 201."


def test_questions_follow_heard_reports_and_statuses():
    cards = [
        # Прибытие услышано, статус ещё «Начало реагирования» — доклад не отмечен.
        ShiftCard("11111111 — пожар", "responding", (("responding", B1), ("arrived", B1))),
        # Работы услышаны и отмечены.
        ShiftCard("22222222 — ДТП", "working", (("arrived", B2), ("working", B2))),
        # Бригада ещё не докладывала.
        ShiftCard("33333333 — газ", "accepted", ()),
    ]
    questions = build_questions(ROSTER, {B1, B2}, cards)
    assert [question["key"] for question in questions] == [
        "free_brigades",
        "on_scene",
        "unreported",
    ]
    assert answers_of(questions) == {
        "free_brigades": ["1"],
        "on_scene": ["Бригада 1", "Бригада 2"],
        "unreported": ["11111111 — пожар"],
    }
    assert questions[0]["options"] == ["0", "1", "2", "3"]
    assert questions[1]["options"][-1] == NONE_ON_SCENE and questions[1]["multiple"]
    assert questions[2]["options"] == [card.label for card in cards] + [ALL_MARKED]
    assert "«Прибытие»" in questions[2]["why"]


def test_finished_brigade_is_not_on_scene_and_nothing_heard_means_all_marked():
    cards = [
        ShiftCard("11111111 — пожар", "completed", (("arrived", B1), ("completed", B1))),
        ShiftCard("22222222 — ДТП", "received", ()),
    ]
    questions = build_questions(ROSTER[:2], set(), cards)
    assert answers_of(questions) == {
        "free_brigades": ["2"],
        "on_scene": [NONE_ON_SCENE],
        "unreported": [ALL_MARKED],
    }


def test_score_needs_exact_set_of_right_options():
    questions = build_questions(
        ROSTER, {B1, B2}, [ShiftCard("1 — x", "responding", (("arrived", B1),))]
    )
    assert score(questions, [["1"], ["Бригада 1"], ["1 — x"]]) == 3
    # Лишний вариант или не все верные — вопрос не засчитан.
    assert score(questions, [["2"], ["Бригада 1", "Бригада 2"], [ALL_MARKED]]) == 0


def final_shift(client, headers, monkeypatch):
    async def history(db, user_id):
        levels = [(1, True, False)] + [(1, False, False)] * 3 + [(2, False, False)] * 3
        levels += [(1, False, True)] * 3
        return [
            StepAttempt(level, tutorial, True, T0 + timedelta(minutes=index), parallel)
            for index, (level, tutorial, parallel) in enumerate(levels)
        ]

    monkeypatch.setattr("app.api.progress.service.trainee_attempts", history)
    return practice(client, headers, 5)


def test_memory_check_is_fixed_at_show_and_answered_once(
    database_config, database_url, monkeypatch
):
    seed_training(database_url)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        shift = final_shift(client, headers, monkeypatch)
        url = f"/api/sessions/{shift['id']}/memory-check"
        early = client.post(url, headers=headers)
        assert early.status_code == 409 and early.json()["code"] == "memory_check_early"
        missing = client.post(f"{url}/answers", json={"answers": [["0"]]}, headers=headers)
        assert missing.status_code == 409 and missing.json()["code"] == "memory_check_missing"
        tick(database_url, datetime.now(UTC) + timedelta(minutes=2))
        shown = client.post(url, headers=headers)
        assert shown.status_code == 200, shown.text
        check = shown.json()
        assert check["result"] is None
        assert [question["key"] for question in check["questions"]] == [
            "free_brigades",
            "on_scene",
            "unreported",
        ]
        # Верных ответов до ответа обучаемый не получает.
        assert all("answer" not in question for question in check["questions"])
        # Журнал карточки до ответа: запись показа есть, верных ответов и пояснений — нет.
        before = client.get(f"/api/cards/{check['card_id']}/events", headers=headers).json()
        [shown_record] = [event for event in before if event["type"] == "memory_check"]
        assert [set(question) for question in shown_record["payload"]["questions"]] == [
            {"key", "text", "options", "multiple"}
        ] * 3
        # Повтор (обновили страницу) — та же проверка, второй записи нет.
        assert client.post(url, headers=headers).json() == check
        wrong = client.post(f"{url}/answers", json={"answers": [["9"], [], []]}, headers=headers)
        assert wrong.status_code == 422
        # Смена только началась: бригады не направлены, никто не докладывал.
        free = check["questions"][0]["options"]
        given = [[free[2]], [NONE_ON_SCENE], [ALL_MARKED]]
        answered = client.post(f"{url}/answers", json={"answers": given}, headers=headers)
        assert answered.status_code == 200, answered.text
        result = answered.json()["result"]
        assert result["score"] == 3 and result["total"] == 3
        assert result["correct"] == given
        again = client.post(
            f"{url}/answers", json={"answers": [["0"], [], []]}, headers=headers
        ).json()
        assert again["result"]["score"] == 3
        events = client.get(f"/api/cards/{check['card_id']}/events").json()
        kinds = [event["type"] for event in events if event["type"].startswith("memory_check")]
        assert kinds == ["memory_check", "memory_check_answer"]
        [record] = [event for event in events if event["type"] == "memory_check_answer"]
        assert record["payload"] == {"answers": given, "score": 3, "total": 3}
        # После ответа верные ответы в журнале открыты (разбор, лента преподавателя).
        [opened] = [event for event in events if event["type"] == "memory_check"]
        assert [question["answer"] for question in opened["payload"]["questions"]] == given


@pytest.mark.parametrize("case", ["case-01.json", "case-02.json"])
def test_memory_check_records_do_not_change_card_score(case):
    """Проверка памяти в оценку не входит: её записи в журнале карточки балл не меняют."""
    fixture = json.loads((GOLDEN / case).read_text(encoding="utf-8"))
    questions = build_questions(ROSTER, {B1}, [ShiftCard("1 — x", "accepted", ())])
    at = fixture["events"][-1]["client_ts"]
    extra = [
        {"type": "memory_check", "client_ts": at, "payload": {"questions": questions}},
        {
            "type": "memory_check_answer",
            "client_ts": at,
            "payload": {"answers": [["0"], ["Бригада 1"], ["1 — x"]], "score": 0, "total": 3},
        },
    ]

    def evaluated(events):
        return evaluate(
            EvalContext(
                fixture["scenario"],
                fixture["current"],
                events,
                fixture["calls"],
                fixture["settings"],
            )
        )

    plain = evaluated(fixture["events"])
    with_check = evaluated([*fixture["events"], *extra])
    assert with_check.total == pytest.approx(plain.total)
    assert [(item.key, item.score, item.critical) for item in with_check.criteria] == [
        (item.key, item.score, item.critical) for item in plain.criteria
    ]
    assert with_check.critical_flags == plain.critical_flags


def test_memory_check_only_in_final_shift(database_config, database_url):
    seed_training(database_url)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        tutorial = practice(client, headers, 1)
        response = client.post(f"/api/sessions/{tutorial['id']}/memory-check", headers=headers)
        assert response.status_code == 409
        assert response.json()["code"] == "memory_check_unavailable"
        other = client.post(f"/api/sessions/{uuid4()}/memory-check", headers=headers)
        assert other.status_code == 404
