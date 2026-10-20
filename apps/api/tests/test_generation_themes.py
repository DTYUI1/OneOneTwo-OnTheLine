"""Темы проходят от публичного API до выбранных каркасов и предупреждений прогресса."""

from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.core.config import settings
from app.core.models import Scenario, User
from app.worker.generators import gameplay, themes, variant_paths
from fastapi.testclient import TestClient
from sqlalchemy import select

from .test_ai_lessons import prepare, users_for_test
from .test_lifecycle import login, run_db


@pytest.fixture
def theme_teacher(database_url):
    async def create(db):
        sample = await db.scalar(select(User).where(User.login == "teacher"))
        user = User(
            login="theme-teacher-" + uuid4().hex,
            password_hash=sample.password_hash,
            role="teacher",
            full_name="Преподаватель тем",
            is_active=True,
        )
        db.add(user)
        await db.flush()
        return user.login

    return run_db(database_url, create)


def template_codes(database_url, ids):
    async def read(db):
        return {
            sid: (await db.get(Scenario, UUID(sid))).generation_metadata["constructor"]["template"]
            for sid in ids
        }

    return run_db(database_url, read)


def test_every_template_has_exactly_one_known_category():
    for template in gameplay.templates():
        assert themes.category(template) in themes.CATEGORIES
    assert set(themes.CATEGORIES) == set(themes.Category.__args__)


def test_multiple_themes_and_missing_theme_use_common_candidates():
    selected = gameplay.template_candidates("101", 1, ["fire", "traffic"])
    assert {themes.category(t) for t in selected} == {"fire", "traffic"}
    assert gameplay.template_candidates("101", 1, ["animals"]) == gameplay.template_candidates(
        "101", 1
    )
    assert themes.warning("101", 1, ["animals"])
    assert themes.warning("101", 1, ["fire", "animals"]) is None
    assert themes.warning("101", 1, []) is None


@pytest.mark.usefixtures("clean_generated_content")
@pytest.mark.parametrize("category", ["fire", "animals"])
def test_studio_theme_generation_and_variety(
    database_config, database_url, monkeypatch, category, theme_teacher
):
    monkeypatch.setattr(settings, "generation_coherence", False)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, theme_teacher)
        dictionary = client.get("/api/packs/generation-categories")
        assert dictionary.status_code == 200 and dictionary.json() == themes.CATEGORIES
        query = {"service_id": "101", "level": 1, "categories": [category]}
        before = client.get("/api/packs/generation-variety", params=query)
        assert before.status_code == 200, before.text
        assert before.json()["count"] == len(gameplay.template_candidates("101", 1, [category]))
        assert before.json()["variants_total"] == len(variant_paths.options("101", 1, [category]))
        generated = client.post(
            "/api/packs/generate",
            headers=headers,
            json={**query, "count": 3, "seed": 0},
        )
        assert generated.status_code == 202, generated.text
        job_id = generated.json()["id"]
        prepare(database_config, job_id)
        progress = client.get(f"/api/jobs/{job_id}/progress").json()
        assert progress["completed"] == 3
        expected = themes.warning("101", 1, [category])
        coverage = [w for w in progress["warnings"] if w.startswith("Покрыто пар:")]
        assert len(coverage) == 1
        assert progress["warnings"] == ([expected] if expected else []) + coverage
        codes = template_codes(database_url, progress["scenario_ids"])
        templates = {t["code"]: t for t in gameplay.templates()}
        for sid in progress["scenario_ids"]:
            code = codes[sid]
            if category == "fire":
                assert themes.category(templates[code]) == "fire"
            else:
                assert templates[code] in gameplay.template_candidates("101", 1)
        after = client.get("/api/packs/generation-variety", params=query).json()
        assert after["variants_left"] == max(0, before.json()["variants_left"] - 3)
        assert (
            client.get(
                "/api/packs/generation-variety", params={**query, "categories": ["invalid"]}
            ).status_code
            == 422
        )
        assert (
            client.post(
                "/api/packs/generate",
                headers=headers,
                json={**query, "count": 1, "categories": ["invalid"]},
            ).status_code
            == 422
        )


@pytest.mark.usefixtures("clean_generated_content")
@pytest.mark.parametrize("category", ["fire", "animals"])
def test_lesson_theme_survives_preparation(
    database_config, database_url, monkeypatch, category, theme_teacher
):
    monkeypatch.setattr(settings, "generation_coherence", False)
    config = database_config.model_copy(update={"ai_provider": "local"})
    trainee = users_for_test(database_url, 1)[0][0]
    with TestClient(create_database_app(config)) as client:
        headers = login(client, theme_teacher)
        response = client.post(
            "/api/sessions",
            headers=headers,
            json={
                "title": "Занятие по теме",
                "settings_snapshot": client.get("/api/settings").json(),
                "participants": [
                    {
                        "user_id": trainee,
                        "workstation_number": 1,
                        "dds_service_id": "101",
                        "level": 1,
                    }
                ],
                "ai_selection": {
                    "request_id": str(uuid4()),
                    "cards_per_participant": 1,
                    "categories": [category],
                },
            },
        )
        assert response.status_code == 201, response.text
        lesson = response.json()
        expected = themes.warning("101", 1, [category])
        assert lesson["ai_preparation"]["warnings"] == ([expected] if expected else [])
        prepare(config, lesson["ai_preparation"]["job_id"])
        ready = client.get(f"/api/sessions/{lesson['id']}").json()
        assert ready["ai_preparation"]["state"] == "ready"
        assert ready["ai_preparation"]["warnings"] == ([expected] if expected else [])
        progress = client.get(f"/api/jobs/{lesson['ai_preparation']['job_id']}/progress").json()
        codes = template_codes(database_url, progress["scenario_ids"])
        code = codes[progress["scenario_ids"][0]]
        template = next(t for t in gameplay.templates() if t["code"] == code)
        if category == "fire":
            assert themes.category(template) == "fire"
