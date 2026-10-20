"""Повтор карточки gameplay сосуществует с каталогом и повтором по совету ИИ (TC-11)."""

from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.core.models import Assignment
from evalcore.progress import StepAttempt
from fastapi.testclient import TestClient
from sqlalchemy import select

from . import test_c03_sessions as c03
from .test_c04_completion import seed_training
from .test_lifecycle import login, run_db
from .test_practice_catalog import catalog
from .test_progress import T0


@pytest.mark.parametrize("step", [None, 2])
def test_again_keeps_own_scenario_and_rejects_ambiguous_or_foreign_card(
    database_config, database_url, monkeypatch, step
):
    seed_training(database_url)

    async def history(db, user_id):
        return [StepAttempt(1, True, True, T0)]

    monkeypatch.setattr("app.api.progress.service.trainee_attempts", history)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, "trainee03")
        chosen = next(item for item in catalog(client) if item["level"] == 1)
        first = client.post(f"/api/practice?scenario={chosen['id']}", headers=headers)
        assert first.status_code == 200, first.text
        c03.tick(database_url)
        card = next(
            item
            for item in client.get("/api/cards").json()
            if item["session_id"] == first.json()["id"]
        )
        for parameter in ("scenario", "scenario_id"):
            conflict = client.post(
                f"/api/practice?again={card['id']}&{parameter}={chosen['id']}", headers=headers
            )
            assert conflict.status_code == 422, conflict.text
        missing = client.post(f"/api/practice?again={uuid4()}", headers=headers)
        assert missing.status_code == 404
        assert missing.json()["code"] == "card_not_found"

        with TestClient(create_database_app(database_config)) as other:
            foreign = other.post(
                f"/api/practice?again={card['id']}", headers=login(other, "trainee02")
            )
            assert foreign.status_code == 404, foreign.text
            assert foreign.json()["code"] == "card_not_found"

        query = f"again={card['id']}" + (f"&step={step}" if step else "")
        repeated = client.post(f"/api/practice?{query}", headers=headers)
        assert repeated.status_code == 200, repeated.text
        session = repeated.json()
        assert session["participants"][0]["dds_service_id"] == chosen["service_id"]

        async def assignments(db):
            return list(
                await db.scalars(
                    select(Assignment.scenario_id).where(
                        Assignment.session_id == UUID(session["id"])
                    )
                )
            )

        assert run_db(database_url, assignments) == [UUID(chosen["id"])]
        closed = client.post(f"/api/sessions/{session['id']}/finish", headers=headers)
        assert closed.status_code == 200, closed.text
