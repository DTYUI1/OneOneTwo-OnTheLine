"""Разнообразие между порциями, пакетами и занятиями; сохранение случайного seed."""

import asyncio
from collections import Counter
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.core.models import Assignment, Job, Participant, Scenario, ScenarioPack, Session, User
from app.seed.scenarios import scenario_row, scenario_uuid
from app.worker.generators import gameplay, pairwise, variant_paths
from app.worker.generators.storage import gameplay_history
from app.worker.runtime import Worker
from fastapi.testclient import TestClient
from sqlalchemy import select

from .test_lifecycle import login
from .test_scenario_generation import ScriptedLLM

pytestmark = pytest.mark.usefixtures("clean_generated_content")


def test_studio_cycles_and_history_counts_each_scenario_once(database_config):
    async def check():
        worker = Worker(database_config)
        worker.handlers.llm = ScriptedLLM()
        try:
            async with worker.database.sessions.begin() as db:
                teacher = await db.scalar(select(User).where(User.login == "teacher"))

                async def make(count, seed):
                    pack = ScenarioPack(
                        title="Разнообразие",
                        status="draft",
                        origin="template",
                        created_by=teacher.id,
                    )
                    db.add(pack)
                    await db.flush()
                    payload = dict(
                        pack_id=str(pack.id), count=count, service_id="102", level=1, seed=seed
                    )
                    result = None
                    for _ in range(count):
                        result = await worker.handlers.handle_generate(db, payload)
                    ids = tuple(UUID(s) for s in result["scenario_ids"])
                    return [await db.get(Scenario, sid) for sid in ids]

                first = await make(6, 0)
                codes = [r.generation_metadata["constructor"]["template"] for r in first]
                assert sorted(Counter(codes).values()) == [2, 2, 2]
                assert len(set(codes[:3])) == len(set(codes[3:])) == 3
                history = await gameplay_history(
                    db, author_id=teacher.id, selected_ids=tuple(r.id for r in first)
                )
                assert Counter(r.id for r in history) == Counter(r.id for r in first)
                extra = await make(1, 0)
                next_pack = await make(2, 0)
                available = variant_paths.options("102", 1)
                counts = variant_paths.usage(first + extra, "102", 1)
                covered = set()
                for row in next_pack:
                    gains = {
                        sig: len(pairwise.pairs(pairwise.features(data)) - covered)
                        for sig, (_, data) in available.items()
                    }
                    best = max(gains.values())
                    sig = row.generation_metadata["constructor"]["variant_signature"]
                    assert gains[sig] == best
                    # История разрешает равенство по покрытию, а не запрещает
                    # повтор каркаса, если он даёт больше новых сочетаний.
                    assert counts[sig] == min(counts[s] for s in gains if gains[s] == best)
                    counts[sig] += 1
                    covered.update(pairwise.covered([row]))
                await db.rollback()
        finally:
            await worker.close()

    asyncio.run(check())


@pytest.mark.parametrize("generated", [False, True])
def test_lesson_avoids_previous_template_and_counts_current_choices(database_config, generated):
    async def check():
        worker = Worker(database_config)
        worker.handlers.llm = ScriptedLLM()
        try:
            async with worker.database.sessions.begin() as db:
                teacher = await db.scalar(select(User).where(User.login == "teacher"))
                user = await db.scalar(select(User).where(User.login == "trainee01"))
                template = gameplay.pick("102", 1, 0)
                scenario_id = scenario_uuid(template)
                if not generated and await db.get(Scenario, scenario_id) is None:
                    db.add(Scenario(**scenario_row(template)))
                    await db.flush()
                if generated:
                    from app.worker.generators.storage import generate_one

                    old = await generate_one(
                        db,
                        ScriptedLLM(),
                        scenario_id=uuid4(),
                        author_id=teacher.id,
                        service_id="102",
                        level=1,
                        seed=0,
                        auto_admit=True,
                    )
                    scenario_id = old.id
                lesson = Session(
                    teacher_id=teacher.id,
                    title="Прошлое занятие",
                    kind="lesson",
                    status="finished",
                    started_at=datetime.now(UTC) - timedelta(days=1),
                    settings_snapshot={},
                )
                db.add(lesson)
                await db.flush()
                participant = Participant(
                    session_id=lesson.id,
                    user_id=user.id,
                    workstation_id=1,
                    dds_service_id="102",
                    level=1,
                    rating_at_start=0,
                )
                db.add(participant)
                await db.flush()
                db.add(
                    Assignment(
                        session_id=lesson.id,
                        participant_id=participant.id,
                        scenario_id=scenario_id,
                        order=1,
                        status="completed",
                    )
                )
                await db.flush()
                from app.worker.generators.storage import generate_one

                selected = []
                codes = []
                for _ in range(2):
                    row = await generate_one(
                        db,
                        ScriptedLLM(),
                        scenario_id=uuid4(),
                        author_id=teacher.id,
                        service_id="102",
                        level=1,
                        seed=0,
                        auto_admit=True,
                        session_id=UUID(int=1),
                        participant_id=user.id,
                        selected_ids=tuple(selected),
                    )
                    selected.append(row.id)
                    codes.append(row.generation_metadata["constructor"]["template"])
                assert len(set(codes)) == 2 and template["code"] not in codes
                await db.rollback()
        finally:
            await worker.close()

    asyncio.run(check())


def test_missing_seed_is_saved_and_retry_keeps_it(database_config):
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        body = dict(count=1, service_id="102", level=1, generation_request_id=str(uuid4()))
        response = client.post("/api/packs/generate", headers=headers, json=body)
        assert response.status_code == 202, response.text
        assert (
            client.post("/api/packs/generate", headers=headers, json=body).json()["id"]
            == response.json()["id"]
        )

        async def check():
            worker = Worker(database_config)
            try:
                async with worker.database.sessions() as db:
                    job = await db.get(Job, UUID(response.json()["id"]))
                    seed = job.payload["seed"]
                    assert isinstance(seed, int)
                    pack = await db.get(ScenarioPack, UUID(job.payload["pack_id"]))
                    assert str(seed) in pack.title
            finally:
                await worker.close()

        asyncio.run(check())
        for level in range(1, 5):
            result = client.get(f"/api/packs/generation-variety?service_id=102&level={level}")
            assert result.status_code == 200, result.text
            assert result.json()["count"] == len(gameplay.template_candidates("102", level))


def test_repeated_report_set_is_broken_without_removing_template():
    # Искусственный набор делает проверку независимой от пополнения банка голосов.
    spec = {"template": {"plan": []}, "phrases": {}, "facts": {"reports": []}}
    from unittest.mock import patch

    for state in ("responding", "arrived"):
        options = [{"id": f"{state}-{i}", "text": f"{state} {i}"} for i in range(3)]
        spec["template"]["plan"].append({"justifies_state": state, "line": options[0]})
        spec["phrases"][state] = options
        spec["facts"]["reports"].append({"state": state, "options": [p["text"] for p in options]})
    used = {state: f"{state}-1" for state in spec["phrases"]}
    with patch.object(gameplay, "phrase_of", side_effect=lambda line: line):
        result = gameplay.variety_input(spec, [used, used])
    assert any(
        used[state] not in {p["id"] for p in options}
        for state, options in result["phrases"].items()
    )
    for report in result["facts"]["reports"]:
        state = report["state"]
        assert len(report["options"]) >= 2
        assert f"{state} 0" in report["options"]
        assert report["options"] == [p["text"] for p in result["phrases"][state]]
    assert len(spec["phrases"]["responding"]) == 3


def test_handler_keeps_current_choices_separate_for_each_trainee(database_config, monkeypatch):
    async def progress(*args):
        pass

    monkeypatch.setattr("app.api.sessions.preparation.update_preparation_progress", progress)
    monkeypatch.setattr("app.api.sessions.preparation.finalize_preparation", progress)

    async def check():
        worker = Worker(database_config)
        worker.handlers.llm = ScriptedLLM()
        try:
            async with worker.database.sessions.begin() as db:
                teacher = await db.scalar(select(User).where(User.login == "teacher"))
                pack = ScenarioPack(
                    title="Два обучаемых", status="draft", origin="template", created_by=teacher.id
                )
                db.add(pack)
                await db.flush()
                users = [str(uuid4()), str(uuid4())]
                payload = dict(
                    pack_id=str(pack.id),
                    session_id=str(uuid4()),
                    count=4,
                    service_id="102",
                    level=1,
                    seed=0,
                    items=[
                        dict(participant_id=user, service_id="102", level=1, seed=0)
                        for _ in range(2)
                        for user in users
                    ],
                )
                for _ in range(4):
                    result = await worker.handlers.handle_generate(db, payload)
                rows = [await db.get(Scenario, UUID(sid)) for sid in result["scenario_ids"]]
                codes = [row.generation_metadata["constructor"]["template"] for row in rows]
                assert codes[0] == codes[1] and codes[2] == codes[3] and codes[0] != codes[2]
                await db.rollback()
        finally:
            await worker.close()

    asyncio.run(check())


def test_history_is_limited_to_five_lessons(database_config):
    async def check():
        worker = Worker(database_config)
        try:
            async with worker.database.sessions.begin() as db:
                teacher = await db.scalar(select(User).where(User.login == "teacher"))
                user = await db.scalar(select(User).where(User.login == "trainee02"))
                templates = gameplay.template_candidates("102", 1)[:2]
                ids = [scenario_uuid(t) for t in templates]
                for template, sid in zip(templates, ids, strict=True):
                    if await db.get(Scenario, sid) is None:
                        db.add(Scenario(**scenario_row(template)))
                for age in range(1, 7):
                    lesson = Session(
                        teacher_id=teacher.id,
                        title="История",
                        kind="lesson",
                        status="finished",
                        settings_snapshot={},
                        started_at=datetime.now(UTC) - timedelta(days=age),
                    )
                    db.add(lesson)
                    await db.flush()
                    participant = Participant(
                        session_id=lesson.id,
                        user_id=user.id,
                        workstation_id=2,
                        dds_service_id="102",
                        level=1,
                        rating_at_start=0,
                    )
                    db.add(participant)
                    await db.flush()
                    db.add(
                        Assignment(
                            session_id=lesson.id,
                            participant_id=participant.id,
                            scenario_id=ids[int(age == 6)],
                            order=1,
                            status="completed",
                        )
                    )
                await db.flush()
                history = await gameplay_history(
                    db, author_id=teacher.id, session_id=uuid4(), participant_id=user.id
                )
                assert [row.id for row in history] == [ids[0]] * 5
                await db.rollback()
        finally:
            await worker.close()

    asyncio.run(check())
