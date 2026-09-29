"""Обновление 0003 → 0004 сохраняет абсолютное расписание и исходные evidence."""

import os
import subprocess
import sys
from datetime import UTC, datetime
from uuid import uuid4

from app.core.config import ROOT
from app.core.models import SCHEMA_REVISION, Scenario, Setting, User
from app.seed.loader import seed
from sqlalchemy import MetaData, select, text

from .test_lifecycle import run_db


def migrate(url, revision):
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "apps/api/alembic.ini", "upgrade", revision],
        cwd=ROOT,
        env={**os.environ, "DATABASE_URL": url},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_upgrade_preserves_legacy_history(migration_database_url):
    url = migration_database_url
    migrate(url, "0003")
    now = datetime.now(UTC)
    ids = {
        name: uuid4()
        for name in [
            "sessions",
            "session_participants",
            "assignments",
            "cards",
            "calls",
            "card_events",
            "predictions",
            "audit_log",
        ]
    }

    async def prepare(db):
        await seed(db, "test-password", include_training=False)
        teacher = await db.scalar(select(User).where(User.login == "teacher"))
        trainee = await db.scalar(select(User).where(User.login == "trainee01"))
        scenario = await db.scalar(select(Scenario).where(Scenario.status == "approved").limit(1))
        setting = await db.scalar(select(Setting).where(Setting.key == "global"))
        if setting is None:
            setting = await db.scalar(select(Setting).limit(1))
        metadata = MetaData()
        await (await db.connection()).run_sync(metadata.reflect)
        rows = {
            "sessions": dict(
                teacher_id=teacher.id,
                title="История до C-03",
                status="finished",
                started_at=now,
                finished_at=now,
                settings_snapshot=setting.value,
            ),
            "session_participants": dict(
                session_id=ids["sessions"],
                user_id=trainee.id,
                workstation_id=1,
                dds_service_id=scenario.target_service_id,
                level=1,
                rating_at_start=0.0,
            ),
            "assignments": dict(
                session_id=ids["sessions"],
                participant_id=ids["session_participants"],
                scenario_id=scenario.id,
                order=1,
                planned_at=now,
                status="completed",
            ),
            "cards": dict(
                assignment_id=ids["assignments"],
                number="99000001",
                state="refused",
                appeared_at=now,
                delivered_at=now,
                opened_at=now,
                first_status_at=now,
                closed_at=now,
                current={"service_number": "legacy", "comment": "История"},
                redirected_to_service_id=None,
            ),
            "calls": dict(
                card_id=ids["cards"],
                dialed_ext="102",
                service_id="102",
                started_at=now,
                answered_at=now,
                ended_at=now,
                audio_path="preserved.wav",
                transcript="Отчёт",
            ),
            "card_events": dict(
                card_id=ids["cards"],
                actor_id=trainee.id,
                client_event_id=uuid4(),
                client_ts=now,
                server_ts=now,
                clock_offset_ms=7.5,
                type="status_change",
                payload={"state": "refused", "comment": "Факт"},
            ),
            "predictions": dict(
                card_id=ids["cards"],
                participant_id=ids["session_participants"],
                made_at=now,
                p_success=0.5,
                expected_score=0.5,
                p_timeout=0.1,
                expected_time_s=100,
                theta_before=0,
                b_scenario=0,
                model_version="legacy-test",
                actual_score=0.7,
                actual_time_s=95,
                actual_timeout=False,
            ),
            "audit_log": dict(
                ts=now,
                actor_id=teacher.id,
                action="finishSession",
                entity="session",
                entity_id=str(ids["sessions"]),
                before={"status": "running"},
                after={"status": "finished"},
                ip=None,
            ),
        }
        for name, row in rows.items():
            await db.execute(metadata.tables[name].insert().values(id=ids[name], **row))
        return {
            name: dict(
                (
                    await db.execute(
                        select(metadata.tables[name]).where(metadata.tables[name].c.id == row_id)
                    )
                )
                .mappings()
                .one()
            )
            for name, row_id in ids.items()
        }

    before = run_db(url, prepare)
    migrate(url, "head")

    async def verify(db):
        metadata = MetaData()
        await (await db.connection()).run_sync(metadata.reflect)
        for name, original in before.items():
            table = metadata.tables[name]
            updated = dict(
                (await db.execute(select(table).where(table.c.id == ids[name]))).mappings().one()
            )
            assert {key: updated[key] for key in original} == original
            # Новые столбцы старых строк пусты; вид занятия — lesson (0011),
            # направление звонка — outbound (0012).
            added = {key: value for key, value in updated.items() if key not in original}
            if name == "sessions":
                assert added.pop("kind") == "lesson"
            # Прежние звонки набирал диспетчер (0012).
            if name == "calls":
                assert added.pop("direction") == "outbound"
            assert all(value is None for value in added.values())
        assert await db.scalar(text("SELECT version_num FROM alembic_version")) == SCHEMA_REVISION

    run_db(url, verify)
