"""Снятый сценарий, уже назначенный в черновик занятия, не мешает запуску (проверка 19.10)."""

import copy
from uuid import UUID, uuid4

from app.core.models import Assignment
from sqlalchemy import select

from . import test_c03_sessions as c03
from .test_c03_sessions import batch, item, start
from .test_lifecycle import run_db

lesson = c03.lesson


def test_retired_scenario_assignment_is_cancelled_and_lesson_starts(lesson, database_url):
    client, headers = lesson.client, lesson.headers
    # Ещё один сценарий для первого участника — его выдадут и снимут до начала занятия.
    body = copy.deepcopy(lesson.scenarios[0])
    body["id"] = str(uuid4())
    response = client.post("/api/scenarios", json=body, headers=headers)
    assert response.status_code == 201, response.text
    extra = response.json()
    batch(lesson, [item(lesson, 0), item(lesson, 1)])
    _, receipt = batch(
        lesson,
        [
            {
                **item(lesson, 0, order=2, delay=60),
                "scenario_id": extra["id"],
                "scenario_version": extra["version"],
            }
        ],
    )
    extra_assignment = receipt["assignments"][0]["id"]

    response = client.post(f"/api/scenarios/{extra['id']}/retire", headers=headers)
    assert response.status_code == 200, response.text

    async def assignment_state(db):
        row = await db.scalar(select(Assignment).where(Assignment.id == UUID(extra_assignment)))
        return row.status, row.cancelled_at is not None

    assert run_db(database_url, assignment_state) == ("cancelled", True)
    # Раньше: 422 «Запуск требует утверждённых сценариев».
    start(lesson)
