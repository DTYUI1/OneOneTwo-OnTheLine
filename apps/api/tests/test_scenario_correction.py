"""Замечание преподавателя: строгий выбор пути, замена пакета и сохранность исходника."""

import json
from collections import Counter
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.core.config import settings
from app.core.models import AuditLog, Job, Scenario, ScenarioPack, ScenarioPackItem, User
from app.worker.generators import gameplay, variant_paths
from app.worker.generators.storage import generate_gameplay_one
from app.worker.generators.validation import GenerationRejected, validate_gameplay
from app.worker.runtime import Worker
from fastapi.testclient import TestClient
from sqlalchemy import select

from . import test_generation_themes
from .test_lifecycle import login, run_db
from .test_scenario_generation import ScriptedLLM

theme_teacher = test_generation_themes.theme_teacher


class CorrectionLLM(ScriptedLLM):
    def __init__(self, old_signature, invalid=False):
        super().__init__(invalid)
        self.old_signature = old_signature
        self.selected = None

    async def complete_json(self, prompt):
        facts = json.loads(prompt)
        assert facts["teacher_note"] == "Вопрос бригады позже"
        self.selected = next(v for v in facts["variants"] if v["id"] != self.old_signature)
        return {
            "variant": "invalid" if self.invalid else self.selected["id"],
            **self.gameplay(
                {**facts, "reports": facts["report_sets"][self.selected["report_set"]]}
            ),
        }


@pytest.fixture
def draft(database_url, theme_teacher, monkeypatch):
    monkeypatch.setattr(settings, "generation_coherence", False)

    async def create(db):
        teacher = await db.scalar(select(User).where(User.login == theme_teacher))
        seed = next(
            i
            for i in range(10)
            if variant_paths.pick("GKH", 3, i, Counter(), Counter())[0]["code"] == "pipe-flat-gkh-2"
        )
        row = await generate_gameplay_one(
            db,
            ScriptedLLM(),
            scenario_id=uuid4(),
            author_id=teacher.id,
            service_id="GKH",
            level=3,
            seed=seed,
            auto_admit=False,
        )
        pack = ScenarioPack(title="Коррекция", status="draft", origin="llm", created_by=teacher.id)
        db.add(pack)
        await db.flush()
        db.add(ScenarioPackItem(pack_id=pack.id, scenario_id=row.id, order=4))
        return row.id, pack.id, row.generation_metadata

    return run_db(database_url, create)


def test_correction_variant_enum_is_strict():
    source = next(t for t in gameplay.templates() if t["code"] == "pipe-flat-gkh-2")
    previous = {"phrases": {"reports": gameplay.report_phrase_ids(source)}}
    spec = gameplay.correction_input(source, 3, 2, "Позже", previous)
    assert spec["facts"]["previous_reports"] == {
        r["justifies_state"]: r["line"]["text"] for r in source["plan"]
    }
    key, selected = next(iter(spec["variants"].items()))
    valid = {"variant": key, **gameplay.fallback_response(selected)}
    validate_gameplay(spec["facts"], valid)
    for bad in (
        {**valid, "variant": "invented"},
        {**valid, "choices": {}},
        {**valid, "teacher_note": "injected"},
    ):
        with pytest.raises(GenerationRejected):
            validate_gameplay(spec["facts"], bad)


@pytest.mark.usefixtures("clean_generated_content")
@pytest.mark.parametrize("invalid", [False, True])
def test_correction_replaces_only_after_valid_model_reply(
    database_config, database_url, theme_teacher, draft, invalid
):
    database_config = database_config.model_copy(update={"ai_provider": "local"})
    old_id, pack_id, metadata = draft
    llm = CorrectionLLM(metadata["constructor"]["variant_signature"], invalid)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, theme_teacher)
        url = f"/api/scenarios/{old_id}/regenerate"
        response = client.post(url, headers=headers, json={"note": "Вопрос бригады позже"})
        assert response.status_code == 202, response.text
        job_id = UUID(response.json()["id"])
        assert client.post(url, headers=headers, json={"note": "Вопрос бригады позже"}).json()[
            "id"
        ] == str(job_id)
        assert client.post(url, headers=headers, json={"note": "Другое"}).status_code == 409
        progress = client.get(f"/api/jobs/{job_id}/progress").json()
        assert progress["completed"] == 0 and progress["scenario_ids"] == []

        async def process(db):
            worker = Worker(database_config)
            worker.handlers.llm = llm
            try:
                job = await db.get(Job, job_id)
                result = await worker.handlers.handle_generate(db, job.payload)
                job.result, job.status = result, "done"
                # Повтор доставки не заменяет сценарий второй раз.
                assert await worker.handlers.handle_generate(db, job.payload) == result
            finally:
                await worker.close()

        if invalid:
            with pytest.raises(GenerationRejected):
                run_db(database_url, process)
        else:
            run_db(database_url, process)
            progress = client.get(f"/api/jobs/{job_id}/progress").json()
            assert progress["completed"] == 1 and len(progress["scenario_ids"]) == 1

        async def verify(db):
            old = await db.get(Scenario, old_id)
            member = await db.scalar(
                select(ScenarioPackItem).where(ScenarioPackItem.pack_id == pack_id)
            )
            assert member.order == 4
            if invalid:
                assert old.status == "draft" and member.scenario_id == old_id
                return
            assert old.status == "retired" and member.scenario_id != old_id
            new = await db.get(Scenario, member.scenario_id)
            assert new.status == "draft"
            actual = new.generation_metadata
            assert actual["correction"] == {
                "teacher_note": "Вопрос бригады позже",
                "previous_scenario_id": str(old_id),
            }
            assert actual["constructor"]["variant_signature"] == llm.selected["id"]
            assert actual["constructor"]["variation"] == llm.selected["variation"]
            for key in ("template", "seed", "level"):
                assert actual["constructor"][key] == metadata["constructor"][key]
            audit = await db.scalar(
                select(AuditLog).where(
                    AuditLog.action == "regenerateScenario", AuditLog.entity_id == str(new.id)
                )
            )
            assert audit.after["teacher_note"] == "Вопрос бригады позже"

        run_db(database_url, verify)


@pytest.mark.usefixtures("clean_generated_content")
def test_correction_rejects_foreign_and_approved(
    database_config, database_url, theme_teacher, draft
):
    old_id, _, _ = draft
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        url = f"/api/scenarios/{old_id}/regenerate"
        assert client.post(url, headers=headers, json={"note": "Позже"}).status_code == 403
        headers = login(client, theme_teacher)
        assert client.post(url, headers=headers, json={"note": "  "}).status_code == 422

        async def approve(db):
            row = await db.get(Scenario, old_id)
            row.status = "approved"

        run_db(database_url, approve)
        assert client.post(url, headers=headers, json={"note": "Позже"}).status_code == 409


@pytest.mark.usefixtures("clean_generated_content")
def test_level_change_rejected_before_job_is_created(
    database_config, database_url, theme_teacher, draft
):
    database_config = database_config.model_copy(update={"ai_provider": "local"})
    old_id, _, _ = draft
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, theme_teacher)
        response = client.post(
            f"/api/scenarios/{old_id}/regenerate",
            headers=headers,
            json={"note": "Хочу чтобы карточка была уровня 4"},
        )
        assert response.status_code == 422
        assert "новый пакет с уровнем 4" in response.json()["message"]

    async def verify(db):
        assert (await db.get(Scenario, old_id)).status == "draft"
        assert (
            await db.scalar(
                select(Job).where(Job.payload["previous_scenario_id"].astext == str(old_id))
            )
            is None
        )

    run_db(database_url, verify)


def test_explicit_other_outcome_cannot_repeat_previous_outcome():
    source = next(t for t in gameplay.templates() if t["code"] == "smoke-apartment-101-2")
    previous = {"constructor": {"variation": {"terminal_state": "refused"}}}
    spec = gameplay.correction_input(source, 3, 0, "другой исход", previous)
    assert spec["variants"]
    assert all(s["variation"]["terminal_state"] == "completed" for s in spec["variants"].values())


def test_missing_other_outcome_explains_limits_instead_of_recreating_same_story():
    source = next(t for t in gameplay.templates() if t["code"] == "fire-flat-101-2")
    previous = {"constructor": {"variation": {"terminal_state": "completed"}}}
    with pytest.raises(GenerationRejected, match="нет другого исхода"):
        gameplay.correction_input(source, 3, 0, "Хочу другой исход", previous)


def test_other_outcome_requires_recorded_previous_outcome():
    source = next(t for t in gameplay.templates() if t["code"] == "smoke-apartment-101-2")
    with pytest.raises(GenerationRejected, match="не сохранён исход"):
        gameplay.correction_input(source, 3, 0, "другой исход", {"constructor": {}})
