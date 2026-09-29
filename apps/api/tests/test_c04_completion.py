"""L-02: доклад о завершении работ и полный ход статусов в аудиосценариях v2."""

import os
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from app.api.database import create_database_app
from app.core.config import ROOT
from app.core.models import Evaluation, Scenario
from fastapi.testclient import TestClient
from sqlalchemy import select

from .test_lifecycle import event, login, run_db


def seed_training(database_url: str) -> None:
    env = {
        **os.environ,
        "DATABASE_URL": database_url,
        "API_MODE": "mock",
        "PYTHONIOENCODING": "utf-8",
    }
    result = subprocess.run(
        [sys.executable, "-m", "app.seed.training"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        encoding="utf-8",
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_audio_demo_v2_has_four_reports_and_full_expected_flow(database_url):
    seed_training(database_url)

    async def check(db):
        scenario = await db.get(Scenario, uuid5(NAMESPACE_URL, "arm112:c04:audio-demo-v2:102"))
        assert scenario is not None
        assert scenario.reference["expected_flow"] == [
            "received",
            "accepted",
            "responding",
            "arrived",
            "working",
            "completed",
        ]
        return scenario

    run_db(database_url, check)


def test_audio_demo_v2_rejects_statuses_without_reports(database_config, database_url):
    seed_training(database_url)
    scenario_id = uuid5(NAMESPACE_URL, "arm112:c04:audio-demo-v2:102")
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        users = {item["login"]: item for item in client.get("/api/users").json()}
        scenario = next(
            item for item in client.get("/api/scenarios").json() if item["id"] == str(scenario_id)
        )
        settings = client.get("/api/settings").json()
        created = client.post(
            "/api/sessions",
            json={
                "title": "Проверка L-02",
                "participants": [
                    {
                        "user_id": users["trainee01"]["id"],
                        "workstation_number": 1,
                        "dds_service_id": scenario["target_service_id"],
                        "level": 1,
                    }
                ],
                "settings_snapshot": settings,
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text
        session_id = created.json()["id"]
        assigned = client.post(
            f"/api/sessions/{session_id}/assignments",
            json={
                "participant_id": users["trainee01"]["id"],
                "scenario_id": scenario["id"],
                "order": 1,
                "planned_at": (datetime.now(UTC) + timedelta(seconds=1)).isoformat(),
            },
            headers=headers,
        )
        assert assigned.status_code == 201, assigned.text
        assignment_id = assigned.json()["id"]
        started = client.post(f"/api/sessions/{session_id}/start", headers=headers)
        assert started.status_code == 200, started.text

        card_id = uuid4()

        async def insert_card(db):
            from app.core.models import Assignment, Card

            assignment = await db.get(Assignment, UUID(assignment_id))
            db.add(
                Card(
                    id=card_id,
                    assignment_id=assignment.id,
                    number=scenario["card"]["number"],
                    state="added",
                    appeared_at=datetime.now(UTC),
                    delivered_at=None,
                    opened_at=None,
                    first_status_at=None,
                    closed_at=None,
                    current={"service_number": scenario["target_service_id"], "comment": ""},
                    redirected_to_service_id=None,
                )
            )

        run_db(database_url, insert_card)

        with TestClient(create_database_app(database_config)) as trainee:
            trainee_headers = login(trainee, "trainee01")
            delivered = trainee.post(
                f"/api/cards/{card_id}/events",
                json=event("deliver", {}),
                headers=trainee_headers,
            )
            assert delivered.status_code == 200, delivered.text
            accepted = trainee.post(
                f"/api/cards/{card_id}/events",
                json=event("status_change", {"state": "accepted", "comment": "Принята"}),
                headers=trainee_headers,
            )
            assert accepted.status_code == 200, accepted.text
            for state in ("responding", "arrived", "working", "completed"):
                response = trainee.post(
                    f"/api/cards/{card_id}/events",
                    json=event("status_change", {"state": state, "comment": "Работы завершены"}),
                    headers=trainee_headers,
                )
                assert response.status_code == 409, response.text
                assert response.json()["code"] == "report_required"
            assert trainee.get(f"/api/cards/{card_id}").json()["state"] == "accepted"

    async def no_evaluation(db):
        return await db.scalar(select(Evaluation).where(Evaluation.card_id == card_id))

    assert run_db(database_url, no_evaluation) is None
