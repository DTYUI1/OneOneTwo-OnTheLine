"""PR109: возможности коррекции и отдельная очередь генерации пакетов."""

import json
import os
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.core.models import Job, Scenario, ScenarioPackItem
from fastapi.testclient import TestClient
from sqlalchemy import select

from . import test_scenario_correction as correction_cases
from .test_lifecycle import login, run_db

theme_teacher = correction_cases.theme_teacher
draft = correction_cases.draft


@pytest.mark.usefixtures("clean_generated_content")
@pytest.mark.parametrize("provider, expected", [("off", False), ("mock", False), ("local", True)])
def test_correction_projection_uses_configured_provider(
    database_config, theme_teacher, draft, provider, expected
):
    old_id, _, _ = draft
    config = database_config.model_copy(update={"ai_provider": provider})
    with TestClient(create_database_app(config)) as client:
        login(client, theme_teacher)
        response = client.get(f"/api/scenarios/{old_id}/content")
        assert response.status_code == 200, response.text
        if directory := os.getenv("CAPABILITIES_EVIDENCE"):
            Path(directory, f"content-{provider}.json").write_text(
                json.dumps(response.json(), ensure_ascii=False), encoding="utf-8"
            )
        assert response.json()["can_regenerate"] is expected


@pytest.mark.usefixtures("clean_generated_content")
@pytest.mark.parametrize("provider", ["off", "mock"])
def test_unavailable_correction_rejected_before_enqueue(
    database_config, database_url, theme_teacher, draft, provider
):
    old_id, pack_id, _ = draft
    config = database_config.model_copy(update={"ai_provider": provider})
    with TestClient(create_database_app(config)) as client:
        headers = login(client, theme_teacher)
        response = client.post(
            f"/api/scenarios/{old_id}/regenerate",
            headers=headers,
            json={"note": "Вопрос бригады позже"},
        )
        assert response.status_code == 409, response.text

    async def verify(db):
        assert (
            await db.scalar(
                select(Job).where(Job.payload["previous_scenario_id"].astext == str(old_id))
            )
            is None
        )
        assert (await db.get(Scenario, old_id)).status == "draft"
        member = await db.scalar(
            select(ScenarioPackItem).where(ScenarioPackItem.pack_id == pack_id)
        )
        assert member.scenario_id == old_id

    run_db(database_url, verify)


@pytest.mark.usefixtures("clean_generated_content")
def test_local_correction_can_enqueue(database_config, theme_teacher, draft):
    old_id, _, _ = draft
    config = database_config.model_copy(update={"ai_provider": "local"})
    with TestClient(create_database_app(config)) as client:
        headers = login(client, theme_teacher)
        response = client.post(
            f"/api/scenarios/{old_id}/regenerate",
            headers=headers,
            json={"note": "Вопрос бригады позже"},
        )
        assert response.status_code == 202, response.text
        job_id = UUID(response.json()["id"])
        assert client.get(f"/api/jobs/{job_id}/progress").status_code == 200


@pytest.mark.usefixtures("clean_generated_content")
def test_pack_jobs_exclude_corrections_before_limit_but_keep_stoppable_pack(
    database_config, database_url, theme_teacher, draft
):
    from .test_ai_lessons import users_for_test

    old_id, _, _ = draft
    config = database_config.model_copy(update={"ai_provider": "local"})
    trainee_id = users_for_test(database_url, 1)[0][0]
    with TestClient(create_database_app(config)) as client:
        headers = login(client)
        foreign = client.post(
            "/api/packs/generate",
            headers=headers,
            json={"service_id": "101", "level": 1, "count": 2},
        )
        assert foreign.status_code == 202, foreign.text
        headers = login(client, theme_teacher)
        generated = client.post(
            "/api/packs/generate",
            headers=headers,
            json={"service_id": "101", "level": 1, "count": 2},
        )
        assert generated.status_code == 202, generated.text
        pack_job = generated.json()["id"]
        lesson = client.post(
            "/api/sessions",
            headers=headers,
            json={
                "title": "Собственная подготовка",
                "settings_snapshot": client.get("/api/settings").json(),
                "participants": [
                    {
                        "user_id": trainee_id,
                        "workstation_number": 1,
                        "dds_service_id": "101",
                        "level": 1,
                    }
                ],
                "ai_selection": {"request_id": str(uuid4()), "cards_per_participant": 1},
            },
        )
        assert lesson.status_code == 201, lesson.text
        own_preparation = lesson.json()["ai_preparation"]["job_id"]
        correction = client.post(
            f"/api/scenarios/{old_id}/regenerate",
            headers=headers,
            json={"note": "Вопрос бригады позже"},
        )
        assert correction.status_code == 202, correction.text
        correction_id = correction.json()["id"]

        async def more_corrections(db):
            original = await db.get(Job, UUID(correction_id))
            # Фильтрация должна предшествовать LIMIT: свежие коррекции не вытесняют пакет.
            for _ in range(5):
                db.add(Job(kind="generate", status="pending", payload=dict(original.payload)))

        run_db(database_url, more_corrections)
        listing = client.get("/api/packs/generation-jobs")
        assert listing.status_code == 200, listing.text
        progress = client.get(f"/api/jobs/{pack_job}/progress")
        assert progress.status_code == 200, progress.text
        rejected = client.post(f"/api/jobs/{correction_id}/stop", headers=headers)
        assert rejected.status_code == 409, rejected.text
        stop = client.post(f"/api/jobs/{pack_job}/stop", headers=headers)
        assert stop.status_code == 200, stop.text
        stopped = client.get(f"/api/jobs/{pack_job}/progress")
        assert stopped.json()["generation_state"] == "stopping"
        own = client.get(f"/api/sessions/{lesson.json()['id']}")
        assert own.json()["ai_preparation"]["job_id"] == own_preparation
        assert client.get(f"/api/jobs/{own_preparation}/progress").status_code == 200
        if directory := os.getenv("CAPABILITIES_EVIDENCE"):
            for name, value in {
                "jobs-list": listing.json(),
                "pack-progress": progress.json(),
                "pack-stopped": stopped.json(),
            }.items():
                Path(directory, f"{name}.json").write_text(
                    json.dumps(value, ensure_ascii=False), encoding="utf-8"
                )
        assert [item["job"]["id"] for item in listing.json()] == [pack_job]


@pytest.mark.usefixtures("clean_generated_content")
def test_recommendation_uses_requested_service_and_preserves_legacy_default(
    database_config, database_url
):
    from datetime import UTC, datetime, timedelta

    from app.core.models import Session

    from .test_ai_lessons import users_for_test

    trainee_id, trainee_login = users_for_test(database_url, 1)[0]
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        settings = client.get("/api/settings").json()
        lesson_ids = []
        for service_id, level in [("102", 2), ("GKH", 4)]:
            response = client.post(
                "/api/sessions",
                headers=headers,
                json={
                    "title": "История разных служб",
                    "settings_snapshot": settings,
                    "participants": [
                        {
                            "user_id": trainee_id,
                            "workstation_number": 1,
                            "dds_service_id": service_id,
                            "level": level,
                        }
                    ],
                },
            )
            assert response.status_code == 201, response.text
            lesson_ids.append(UUID(response.json()["id"]))

        async def previous_lessons(db):
            for lesson_id in lesson_ids:
                lesson = await db.get(Session, lesson_id)
                lesson.status = "finished"
                lesson.started_at = datetime.now(UTC) - timedelta(days=1)
                lesson.finished_at = datetime.now(UTC)

        run_db(database_url, previous_lessons)
        results = {}
        for service_id in [None, "102", "GKH", "103"]:
            response = client.get(
                "/api/packs/generation-trainees",
                params={
                    "login": trainee_login,
                    **({"service_id": service_id} if service_id else {}),
                },
            )
            assert response.status_code == 200, response.text
            results[service_id or "legacy"] = response.json()
        if directory := os.getenv("CAPABILITIES_EVIDENCE"):
            users = client.get("/api/users").json()
            values = {
                "recommendations": results,
                "settings": settings,
                "trainee": next(user for user in users if user["id"] == trainee_id),
                "services": [
                    service
                    for service in client.get("/api/services").json()
                    if service["id"] in {"102", "GKH", "103"}
                ],
            }
            for name, value in values.items():
                Path(directory, f"{name}.json").write_text(
                    json.dumps(value, ensure_ascii=False), encoding="utf-8"
                )
        assert results["legacy"][0]["recommended_level"] == 2
        assert results["102"][0]["recommended_level"] == 2
        assert results["GKH"][0]["recommended_level"] == 4
        assert results["103"][0]["recommended_level"] == 1
        assert all(rows[0]["dds_service_id"] == "102" for rows in results.values())


@pytest.mark.parametrize("service_id", ["unknown-service", "112", ""])
def test_recommendation_rejects_invalid_service(database_config, service_id):
    with TestClient(create_database_app(database_config)) as client:
        login(client)
        response = client.get(
            "/api/packs/generation-trainees",
            params={
                "login": "trainee",
                "service_id": service_id,
            },
        )
        assert response.status_code == 422, response.text


def test_recommendation_rejects_inactive_service(database_config, database_url):
    from app.core.models import Service

    async def deactivate(db):
        service = await db.get(Service, "103")
        previous = service.is_active
        service.is_active = False
        return previous

    previous = run_db(database_url, deactivate)
    try:
        with TestClient(create_database_app(database_config)) as client:
            login(client)
            response = client.get(
                "/api/packs/generation-trainees",
                params={
                    "login": "trainee",
                    "service_id": "103",
                },
            )
            assert response.status_code == 422, response.text
    finally:

        async def restore(db):
            (await db.get(Service, "103")).is_active = previous

        run_db(database_url, restore)


@pytest.mark.usefixtures("clean_generated_content")
@pytest.mark.parametrize("provider", ["off", "mock"])
def test_provider_disabled_after_enqueue_fails_without_replacing_draft(
    database_config, database_url, theme_teacher, draft, provider
):
    import asyncio
    from datetime import UTC, datetime

    from app.worker.queue import ClaimedJob
    from app.worker.runtime import Worker

    old_id, pack_id, _ = draft
    local = database_config.model_copy(update={"ai_provider": "local"})
    with TestClient(create_database_app(local)) as client:
        headers = login(client, theme_teacher)
        response = client.post(
            f"/api/scenarios/{old_id}/regenerate",
            headers=headers,
            json={"note": "Вопрос бригады позже"},
        )
        assert response.status_code == 202, response.text
        job_id = UUID(response.json()["id"])

        async def process():
            worker = Worker(database_config.model_copy(update={"ai_provider": provider}))
            try:
                async with worker.database.sessions.begin() as db:
                    job = await db.get(Job, job_id, with_for_update=True)
                    job.status, job.locked_by, job.locked_at = (
                        "running",
                        worker.worker_id,
                        datetime.now(UTC),
                    )
                    job.attempts = 1
                    claimed = ClaimedJob(job.id, job.kind, job.payload, job.attempts)
                assert await worker.process(claimed) is False
                async with worker.database.sessions() as db:
                    job = await db.get(Job, job_id)
                    assert job.status == "failed" and job.error and job.result is None
                    assert job.locked_by is None and job.locked_at is None
                    assert await db.get(Scenario, UUID(job.payload["replacement_id"])) is None
                    old = await db.get(Scenario, old_id)
                    assert old.status == "draft" and old.version == job.payload["previous_version"]
                    member = await db.scalar(
                        select(ScenarioPackItem).where(ScenarioPackItem.pack_id == pack_id)
                    )
                    assert member.scenario_id == old_id
            finally:
                await worker.close()

        asyncio.run(process())
        progress = client.get(f"/api/jobs/{job_id}/progress")
        assert progress.status_code == 200, progress.text
        assert progress.json()["generation_state"] == "failed"
        assert progress.json()["scenario_ids"] == []


@pytest.mark.usefixtures("clean_generated_content")
@pytest.mark.parametrize("invalid", [False, True])
def test_local_correction_preserves_atomic_replacement_semantics(
    database_config, database_url, theme_teacher, draft, invalid
):
    correction_cases.test_correction_replaces_only_after_valid_model_reply(
        database_config.model_copy(update={"ai_provider": "local"}),
        database_url,
        theme_teacher,
        draft,
        invalid,
    )
