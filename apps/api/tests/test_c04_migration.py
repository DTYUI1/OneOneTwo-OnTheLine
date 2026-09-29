"""Миграция C-04 сохраняет результаты C-03 и исторические звонки."""

import os
import subprocess
import sys
from datetime import UTC, datetime
from uuid import NAMESPACE_URL, uuid4, uuid5

from app.core.config import ROOT
from app.core.contracts import validate_json
from app.core.models import Scenario, ScenarioTrainingPlan, User
from app.seed.loader import seed
from app.seed.practice import load_incidents, variants
from app.seed.practice import scenario_id as practice_scenario_id
from sqlalchemy import MetaData, select

from .test_c03_migration import migrate
from .test_lifecycle import run_db


def test_c04_demo_cli_is_repeatable_and_preserves_scenarios(migration_database_url):
    url = migration_database_url
    migrate(url, "head")
    run_db(url, lambda db: seed(db, "test-password"))
    scenario_id = uuid5(NAMESPACE_URL, "arm112:c04:text-demo")
    audio_ids = {
        uuid5(NAMESPACE_URL, f"arm112:c04:audio-demo:{service}")
        for service in ("101", "102", "103", "104", "GKH", "MOSLIFT")
    }
    audio_v2_ids = {
        uuid5(NAMESPACE_URL, f"arm112:c04:audio-demo-v2:{service}")
        for service in ("101", "102", "103", "104", "GKH", "MOSLIFT")
    }
    audio_v3_ids = {
        uuid5(NAMESPACE_URL, f"arm112:c04:audio-demo-v3:{service}")
        for service in ("101", "102", "103", "104", "GKH", "MOSLIFT")
    }
    tutorial_ids = {
        uuid5(NAMESPACE_URL, f"arm112:c04:{key}:{service}")
        for key in ("tutorial", "parallel")
        for service in ("101", "102", "103", "104", "GKH", "MOSLIFT")
    }
    # Сценарии самостоятельной тренировки (app.seed.practice) — тоже от seed.training.
    practice_ids = {
        practice_scenario_id(item["key"], service, level)
        for item in load_incidents()
        for service, level in variants(item)
    }

    async def scenarios(db):
        return {
            s.id: {column.name: getattr(s, column.name) for column in Scenario.__table__.columns}
            for s in await db.scalars(select(Scenario).order_by(Scenario.id))
        }

    original = run_db(url, scenarios)
    env = {**os.environ, "DATABASE_URL": url, "API_MODE": "mock", "PYTHONIOENCODING": "utf-8"}
    for _ in range(2):
        result = subprocess.run(
            [sys.executable, "-m", "app.seed.training"],
            cwd=ROOT,
            env=env,
            capture_output=True,
            encoding="utf-8",
            timeout=30,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert str(scenario_id) in result.stderr
        current = run_db(url, scenarios)
        added = set(current) - set(original)
        # Текстовый пример и по сценарию с озвученными докладами на службу с основой.
        assert scenario_id in added
        assert added - {scenario_id}
        assert added - {scenario_id} <= (
            audio_ids | audio_v2_ids | audio_v3_ids | tutorial_ids | practice_ids
        )
        assert {key: current[key] for key in original} == original

    async def plan(db):
        row = await db.get(ScenarioTrainingPlan, (scenario_id, 1))
        validate_json(row.plan, "urn:openapi#/components/schemas/TrainingPlan")
        assert len(row.plan["messages"]) == 2
        assert all(m["message"]["audio"] is None for m in row.plan["messages"])
        assert [m["available_after_s"] for m in row.plan["messages"]] == [0, 2]

    run_db(url, plan)

    async def audio_plans(db):
        rows = [await db.get(ScenarioTrainingPlan, (item, 1)) for item in audio_ids]
        rows = [row for row in rows if row is not None]
        assert rows
        for row in rows:
            validate_json(row.plan, "urn:openapi#/components/schemas/TrainingPlan")
            assert [m["available_after_s"] for m in row.plan["messages"]] == [3, 10, 18]
            assert all(m["message"]["audio"] is not None for m in row.plan["messages"])

    run_db(url, audio_plans)

    async def audio_retired(db):
        # Первое поколение без доклада о завершении выведено в архив: не раздаётся, но
        # содержимое, версия и выданные планы на месте (28.09).
        for item in audio_ids:
            scenario = await db.get(Scenario, item)
            if scenario is None:
                continue
            assert scenario.status == "retired"
            assert scenario.version == 1
            assert "completed" in scenario.reference["expected_flow"]

    run_db(url, audio_retired)

    async def audio_v2_plans(db):
        rows = [await db.get(ScenarioTrainingPlan, (item, 1)) for item in audio_v2_ids]
        rows = [row for row in rows if row is not None]
        assert rows
        for row in rows:
            validate_json(row.plan, "urn:openapi#/components/schemas/TrainingPlan")
            assert [m["available_after_s"] for m in row.plan["messages"]] == [3, 10, 18, 26]
            assert all(m["message"]["audio"] is not None for m in row.plan["messages"])

    async def audio_v2_scenarios(db):
        for item in audio_v2_ids:
            scenario = await db.get(Scenario, item)
            if scenario is None:
                continue
            assert scenario.reference["expected_flow"] == [
                "received",
                "accepted",
                "responding",
                "arrived",
                "working",
                "completed",
            ]

    async def audio_v3_plans(db):
        rows = [await db.get(ScenarioTrainingPlan, (item, 1)) for item in audio_v3_ids]
        rows = [row for row in rows if row is not None]
        assert rows
        for row in rows:
            validate_json(row.plan, "urn:openapi#/components/schemas/TrainingPlan")
            assert [m["available_after_s"] for m in row.plan["messages"]] == [3, 10, 18, 22]
            assert all(m["message"]["audio"] is not None for m in row.plan["messages"])
            assert row.plan["messages"][-1]["justifies_state"] == "refused"

    async def audio_v3_scenarios(db):
        for item in audio_v3_ids:
            scenario = await db.get(Scenario, item)
            if scenario is None:
                continue
            assert scenario.level == 3
            assert scenario.reference["expected_flow"] == [
                "received",
                "accepted",
                "responding",
                "arrived",
                "working",
                "refused",
            ]

    run_db(url, audio_v2_plans)
    run_db(url, audio_v2_scenarios)
    run_db(url, audio_v3_plans)
    run_db(url, audio_v3_scenarios)
    downgrade = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "apps/api/alembic.ini", "downgrade", "0004"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        encoding="utf-8",
        timeout=30,
    )
    assert downgrade.returncode != 0
    assert "backup/restore" in downgrade.stderr
    run_db(url, plan)


def test_c04_upgrade_preserves_c03_receipts_and_calls(migration_database_url):
    url = migration_database_url
    migrate(url, "0004")
    ids = {
        key: uuid4()
        for key in [
            "sessions",
            "session_participants",
            "assignment_batches",
            "assignments",
            "cards",
            "calls",
            "card_events",
            "session_finishes",
        ]
    }
    now = datetime.now(UTC)

    async def prepare(db):
        await seed(db, "test-password", include_training=False)
        teacher = await db.scalar(select(User).where(User.login == "teacher"))
        trainee = await db.scalar(select(User).where(User.login == "trainee01"))
        scenario = await db.scalar(select(Scenario).limit(1))
        metadata = MetaData()
        await (await db.connection()).run_sync(metadata.reflect)
        rows = {
            "sessions": dict(
                teacher_id=teacher.id,
                title="C-03 до C-04",
                status="finished",
                started_at=now,
                finished_at=now,
                settings_snapshot={},
            ),
            "session_participants": dict(
                session_id=ids["sessions"],
                user_id=trainee.id,
                workstation_id=1,
                dds_service_id="102",
                level=1,
                rating_at_start=0.0,
            ),
            "assignment_batches": dict(
                teacher_id=teacher.id,
                session_id=ids["sessions"],
                request_id=uuid4(),
                canonical_request='{"items":[]}',
                receipt={"before": "C-04"},
            ),
            "assignments": dict(
                session_id=ids["sessions"],
                participant_id=ids["session_participants"],
                scenario_id=scenario.id,
                order=1,
                status="delivered",
                planned_at=None,
                batch_id=ids["assignment_batches"],
                scenario_version=1,
                delay_from_start_s=0,
                delivery_mode="profile",
                due_at=now,
            ),
            "cards": dict(
                assignment_id=ids["assignments"],
                number="99004001",
                state="received",
                appeared_at=now,
                delivered_at=now,
                opened_at=now,
                current={"comment": "История"},
                interrupted_at=now,
            ),
            "calls": dict(
                card_id=ids["cards"],
                dialed_ext="102",
                service_id="102",
                started_at=now,
                answered_at=now,
                ended_at=now,
                end_reason="session_finished",
                audio_path="saved.wav",
                transcript="Доклад сохранён",
            ),
            "card_events": dict(
                card_id=ids["cards"],
                actor_id=trainee.id,
                client_event_id=uuid4(),
                client_ts=now,
                server_ts=now,
                clock_offset_ms=0,
                type="open",
                payload={},
            ),
            "session_finishes": dict(
                session_id=ids["sessions"],
                teacher_id=teacher.id,
                request_id=uuid4(),
                receipt={"finished": True},
            ),
        }
        for name, row in rows.items():
            await db.execute(metadata.tables[name].insert().values(id=ids[name], **row))
        await db.execute(
            metadata.tables["card_event_receipts"]
            .insert()
            .values(event_id=ids["card_events"], receipt={"duplicate": False})
        )
        return {
            name: [
                dict(row) for row in (await db.execute(select(metadata.tables[name]))).mappings()
            ]
            for name in [*rows, "card_event_receipts"]
        }

    before = run_db(url, prepare)
    migrate(url, "head")

    async def verify(db):
        metadata = MetaData()
        await (await db.connection()).run_sync(metadata.reflect)
        for name, original_rows in before.items():
            updated = [
                dict(row) for row in (await db.execute(select(metadata.tables[name]))).mappings()
            ]
            assert [{key: row[key] for key in original_rows[0]} for row in updated] == original_rows
            if name == "calls":
                assert updated[0]["target_id"] is None and updated[0]["brigade_id"] is None
        assert list(await db.scalars(select(metadata.tables["message_deliveries"]))) == []

    run_db(url, verify)
