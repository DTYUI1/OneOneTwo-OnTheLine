"""Номера служб добавляются поверх применённых infra0019/0020 без потери истории."""

import json
from datetime import UTC, datetime
from uuid import uuid4

from app.core.config import ROOT
from app.core.models import LessonFeedback, TeacherMessage, User
from app.seed.loader import seed
from sqlalchemy import MetaData, select

from .test_c03_migration import migrate
from .test_lifecycle import run_db


def test_service_phone_upgrade_preserves_live_lesson_and_feedback(migration_database_url):
    url = migration_database_url
    migrate(url, "0020")
    ids = {name: uuid4() for name in ("session", "message", "feedback")}
    at = datetime(2026, 10, 17, 12, tzinfo=UTC)

    async def prepare(db):
        await seed(db, "test-password", include_training=False)
        teacher = await db.scalar(select(User).where(User.login == "teacher"))
        trainee = await db.scalar(select(User).where(User.login == "trainee01"))
        metadata = MetaData()
        await (await db.connection()).run_sync(metadata.reflect)
        # На 0020 ещё нет новых ИИ-полей Session; используем схему этой ревизии.
        await db.execute(
            metadata.tables["sessions"]
            .insert()
            .values(
                id=ids["session"],
                teacher_id=teacher.id,
                title="Сохранить занятие",
                status="running",
                settings_snapshot={},
                started_at=at,
                paused_at=at,
            )
        )
        await db.flush()
        db.add_all(
            [
                TeacherMessage(
                    id=ids["message"],
                    session_id=ids["session"],
                    user_id=trainee.id,
                    teacher_id=teacher.id,
                    text="Сохранить сообщение",
                    sent_at=at,
                ),
                LessonFeedback(
                    id=ids["feedback"],
                    session_id=ids["session"],
                    user_id=trainee.id,
                    draft="Сохранить черновик",
                    text="Сохранить отзыв",
                    released_at=at,
                ),
            ]
        )

    async def snapshot(db):
        metadata = MetaData()
        await (await db.connection()).run_sync(metadata.reflect)
        return {
            name: [
                dict(row) for row in (await db.execute(select(metadata.tables[name]))).mappings()
            ]
            for name in ("sessions", "teacher_messages", "lesson_feedback")
        }

    run_db(url, prepare)
    before = run_db(url, snapshot)
    migrate(url, "0021")
    assert run_db(url, snapshot) == before

    async def verify(db):
        metadata = MetaData()
        await (await db.connection()).run_sync(metadata.reflect)
        services = metadata.tables["services"]
        assert dict((await db.execute(select(services.c.id, services.c.phone))).all()) == {
            item["id"]: item["phone"]
            for item in json.loads((ROOT / "data/phonebook.json").read_text("utf-8"))
        }
        assert await db.scalar(select(metadata.tables["alembic_version"].c.version_num)) == "0021"

    run_db(url, verify)
