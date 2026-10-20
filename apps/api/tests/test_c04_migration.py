"""Миграция C-04 сохраняет результаты C-03 и исторические звонки."""

import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from app.api.sessions.practice import audio_scenario_id
from app.core.config import ROOT
from app.core.contracts import validate_json
from app.core.models import MessageAudioAsset, Scenario, ScenarioTrainingPlan, User
from app.seed.link112 import link_scenario_ids
from app.seed.loader import seed
from app.seed.scenarios import load_catalog, scenario_uuid
from sqlalchemy import MetaData, select

from .test_c03_migration import migrate
from .test_c04_completion import SEED_TIMEOUT_S
from .test_lifecycle import run_db

SERVICES = {item["id"] for item in json.loads((ROOT / "data/phonebook.json").read_text("utf-8"))}


def _voiced_lines(plan):
    """Реплики плана: доклады (`messages[].message`) и реплики событий — всё, где есть текст
    и место для записи (`audio`)."""
    if isinstance(plan, dict):
        if "text" in plan and "audio" in plan:
            yield plan
        for value in plan.values():
            yield from _voiced_lines(value)
    elif isinstance(plan, list):
        for value in plan:
            yield from _voiced_lines(value)


def test_c04_demo_cli_is_repeatable_and_preserves_scenarios(migration_database_url):
    url = migration_database_url
    migrate(url, "head")
    run_db(url, lambda db: seed(db, "test-password"))
    scenario_id = uuid5(NAMESPACE_URL, "arm112:c04:text-demo")
    # Учебные сценарии C-04 с голосами банка (17.10): id — audio_scenario_id; поколение
    # audio-demo в архиве и заново не создаётся.
    audio_v2_ids = {
        audio_scenario_id("audio-demo-v2", service)
        for service in ("101", "102", "103", "104", "GKH", "MOSLIFT")
    }
    audio_v3_ids = {
        audio_scenario_id("audio-demo-v3", service)
        for service in ("101", "102", "103", "104", "GKH", "MOSLIFT")
    }
    tutorial_ids = {
        audio_scenario_id(key, service)
        for key in ("tutorial", "parallel")
        for service in ("101", "102", "103", "104", "GKH", "MOSLIFT")
    }
    # Сценарии самостоятельной тренировки (app.seed.practice) — тоже от seed.training.
    # С GP-03 — файлы data/scenarios (с GP-04 — версия 2).
    practice_ids = {scenario_uuid(data) for data in load_catalog(SERVICES).scenarios}

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
            timeout=SEED_TIMEOUT_S,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert str(scenario_id) in result.stderr
        # Журнал seed: у связки 112 → ДДС нет «докладов без озвучки» (HQ-036).
        assert "докладов и реплик без озвучки" not in result.stderr
        current = run_db(url, scenarios)
        added = set(current) - set(original)
        # Текстовый пример и по сценарию с озвученными докладами на службу с основой.
        assert scenario_id in added
        assert added - {scenario_id}
        assert added - {scenario_id} <= (
            audio_v2_ids
            | audio_v3_ids
            | tutorial_ids
            | practice_ids
            # Связка 112 → ДДС (app.seed.link112) — тоже от seed.training.
            | link_scenario_ids()
        )
        assert {key: current[key] for key in original} == original

    async def plan(db):
        row = await db.get(ScenarioTrainingPlan, (scenario_id, 1))
        validate_json(row.plan, "urn:openapi#/components/schemas/TrainingPlan")
        assert len(row.plan["messages"]) == 2
        assert all(m["message"]["audio"] is None for m in row.plan["messages"])
        assert [m["available_after_s"] for m in row.plan["messages"]] == [0, 2]

    run_db(url, plan)

    async def audio_retired(db):
        # Первое поколение без доклада о завершении выведено в архив (28.09), с голосами банка
        # (17.10) заново не создаётся; прежние сценарии Piper на стендах — тоже в архиве.
        piper = {
            audio_scenario_id(key, service, None)
            for key in ("audio-demo", "audio-demo-v2", "audio-demo-v3", "tutorial", "parallel")
            for service in ("101", "102", "103", "104", "GKH", "MOSLIFT")
        }
        for item in piper:
            scenario = await db.get(Scenario, item)
            if scenario is None:
                continue
            assert scenario.status == "retired"
            assert scenario.version == 1

    run_db(url, audio_retired)

    async def link_plans_voiced_by_bank(db):
        # Связка 112 → ДДС — записи банка, не Piper (HQ-036, bank-v7): в чистой базе у каждого
        # доклада плана и каждой реплики события есть запись bank-v*, текстом не уходит ничего.
        rows = [
            row
            for item in link_scenario_ids()
            if (row := await db.get(ScenarioTrainingPlan, (item, 1))) is not None
        ]
        assert rows
        lines = [line for row in rows for line in _voiced_lines(row.plan)]
        assert len(lines) >= len(rows) * 3
        for line in lines:
            assert line["audio"] is not None, line["text"]
            asset = await db.get(MessageAudioAsset, (UUID(line["audio"]["asset_id"]), 1))
            assert asset.relative_path.startswith("bank-v"), asset.relative_path

    run_db(url, link_plans_voiced_by_bank)

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
        # На 0004 читаем только существовавшие тогда поля, а не современную ORM-строку.
        scenario = (await db.execute(select(Scenario.id).limit(1))).one()
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
