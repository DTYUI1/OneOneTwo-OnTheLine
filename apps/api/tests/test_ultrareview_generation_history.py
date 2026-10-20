"""PR109 G07: окно персональной истории на настоящем PostgreSQL."""

import asyncio
from collections import Counter
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from app.core.db import Database
from app.core.models import Assignment, Participant, Scenario, Session, User
from app.seed.scenarios import scenario_row
from app.worker.generators import gameplay, storage
from sqlalchemy import select


async def isolated_actors(db):
    """История каждого теста принадлежит новым учёткам, не seed-пользователям."""
    actors = []
    for login in ("teacher", "trainee02"):
        sample = await db.scalar(select(User).where(User.login == login))
        actor = User(
            login=uuid4().hex,
            password_hash=sample.password_hash,
            role=sample.role,
            full_name=sample.full_name,
            is_active=sample.is_active,
            workstation_number=sample.workstation_number,
            dds_service_id=sample.dds_service_id,
        )
        db.add(actor)
        actors.append(actor)
    await db.flush()
    return actors


@pytest.mark.usefixtures("clean_generated_content")
def test_personal_history_obeys_lesson_window_and_keeps_recent_unassigned(database_url):
    async def run():
        database = Database(database_url)
        now = datetime.now(UTC)
        try:
            async with database.sessions.begin() as db:
                teacher, user = await isolated_actors(db)
                source = gameplay.pick("102", 1, 0)

                async def personal(age, user_id=None):
                    data = scenario_row(source)
                    data.update(
                        id=uuid4(), author_id=teacher.id, created_at=now - timedelta(days=age)
                    )
                    row = Scenario(
                        **data,
                        generation_metadata={
                            "constructor": {
                                "template": source["code"],
                                "personalization": {"user_id": str(user_id or user.id)},
                            }
                        },
                    )
                    db.add(row)
                    await db.flush()
                    return row

                assigned = []
                for age in range(1, storage.HISTORY_LESSONS + 3):
                    row = await personal(age)
                    assigned.append(row.id)
                    lesson = Session(
                        teacher_id=teacher.id,
                        title="Окно истории G07",
                        kind="lesson",
                        status="finished",
                        started_at=now - timedelta(days=age),
                        settings_snapshot={},
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
                    for order in range(1, 3 if age == 1 else 2):
                        db.add(
                            Assignment(
                                session_id=lesson.id,
                                participant_id=participant.id,
                                scenario_id=row.id,
                                order=order,
                                status="completed",
                            )
                        )
                pending = [
                    await personal(age / 100) for age in range(1, storage.HISTORY_LESSONS + 4)
                ]
                foreign = await personal(0, uuid4())
                await db.flush()
                kwargs = dict(author_id=teacher.id, session_id=uuid4(), participant_id=user.id)
                history = await storage.gameplay_history(db, **kwargs)
                counts = Counter(row.id for row in history)
                assert not (set(assigned[storage.HISTORY_LESSONS :]) & counts.keys())
                assert counts[assigned[0]] == 2  # Повторные прохождения влияют на частоту.
                assert set(assigned[: storage.HISTORY_LESSONS]) <= counts.keys()
                assert {p.id for p in pending[: storage.HISTORY_LESSONS]} <= counts.keys()
                assert not ({p.id for p in pending[storage.HISTORY_LESSONS :]} & counts.keys())
                assert foreign.id not in counts
                assert [r.id for r in await storage.gameplay_history(db, **kwargs)] == [
                    r.id for r in history
                ]
                assert [r.id for r in history[-storage.HISTORY_LESSONS :]] == [
                    p.id for p in pending[: storage.HISTORY_LESSONS]
                ][::-1]
                selected = (assigned[-1], pending[-1].id)
                current = await storage.gameplay_history(db, **kwargs, selected_ids=selected)
                assert [r.id for r in current[-2:]] == list(selected)
                lifetime = await storage.gameplay_history(db, **kwargs, all_lessons=True)
                assert set(assigned) | {p.id for p in pending} <= {r.id for r in lifetime}
                await db.rollback()
        finally:
            await database.close()

    asyncio.run(run())


@pytest.mark.usefixtures("clean_generated_content")
def test_generator_bounds_committed_history_before_provider_and_persists_it(
    database_url, monkeypatch
):
    import json

    from app.core.config import settings
    from app.worker.generators import variant_paths

    from .test_scenario_generation import ScriptedLLM

    monkeypatch.setattr(settings, "generation_coherence", False)

    class RecordingProvider(ScriptedLLM):
        """Управляемый провайдер, не настоящий LLM."""

        def __init__(self):
            super().__init__()
            self.prompts = []

        async def complete_json(self, prompt):
            self.prompts.append(prompt)
            return await super().complete_json(prompt)

    async def run():
        database = Database(database_url)
        llm = RecordingProvider()
        try:
            async with database.sessions.begin() as db:
                teacher, trainee = await isolated_actors(db)
                author_id, user_id = teacher.id, trainee.id
                selected = []
                for source in gameplay.template_candidates("GKH", 3):
                    for _ in range(50):
                        data = scenario_row(source)
                        sid = uuid4()
                        data.update(id=sid, author_id=author_id, level=3)
                        metadata = {
                            "constructor": {
                                "template": source["code"],
                                "variant_signature": variant_paths.signature(
                                    source, source["code"]
                                ),
                                "personalization": {"user_id": str(user_id)},
                            },
                            "phrases": {"reports": gameplay.report_phrase_ids(source)},
                        }
                        db.add(Scenario(**data, generation_metadata=metadata))
                        selected.append(sid)
            scenario_id = uuid4()
            async with database.sessions.begin() as db:
                await storage.generate_one(
                    db,
                    llm,
                    scenario_id=scenario_id,
                    author_id=author_id,
                    service_id="GKH",
                    level=3,
                    seed=42,
                    auto_admit=False,
                    session_id=uuid4(),
                    participant_id=user_id,
                    selected_ids=tuple(selected),
                    weak_spots={},
                )
            assert llm.prompts
            for prompt in llm.prompts:
                facts = json.loads(prompt)
                assert facts.get("used_report_sets")
                assert len(facts["used_report_sets"]) <= storage.HISTORY_LESSONS
                history = {
                    key: facts[key] for key in ("used_report_sets", "rejected") if key in facts
                }
                assert (
                    len(json.dumps(history, ensure_ascii=False, sort_keys=True).encode())
                    <= settings.generation_max_tokens
                )
            async with database.sessions() as db:
                row = await db.get(Scenario, scenario_id)
                assert row.origin == "llm" and row.level == 3 and row.status == "draft"
                assert row.generation_metadata["input"] == json.loads(llm.prompts[-1])
        finally:
            await database.close()

    asyncio.run(run())
