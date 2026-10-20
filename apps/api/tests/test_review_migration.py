"""PR1-05: обновление старых карточек не теряет момент отправки бригады."""

import os
import subprocess
import sys
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from app.api.training.briefing import dispatched
from app.api.training.brigades import card_crew
from app.api.training.gating import schedule_reports
from app.api.training.scenario_events import dispatched_at, load_journal
from app.core.config import ROOT
from app.core.models import Card, Scenario, User
from app.seed.loader import seed
from sqlalchemy import MetaData, select, text

from .test_c03_migration import migrate
from .test_lifecycle import run_db


@pytest.fixture
def published_alembic_config(tmp_path):
    # Фиксированный dev до review: настоящая 0018 без legacy-снимка и опубликованная 0025.
    # Не подменяем историю удалением таблицы после запуска переписанной 0018.
    revision = "98744c706163b63ca5f7af29a2dd3186fe173c9e"
    paths = subprocess.check_output(
        [
            "git",
            "ls-tree",
            "-r",
            "--name-only",
            revision,
            "apps/api/migrations",
            "apps/api/alembic.ini",
        ],
        cwd=ROOT,
        text=True,
    ).splitlines()
    assert "apps/api/migrations/versions/0025_russian_service_names.py" in paths
    for name in paths:
        destination = tmp_path / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(
            subprocess.check_output(["git", "show", f"{revision}:{name}"], cwd=ROOT)
        )
    return tmp_path / "apps/api/alembic.ini"


def upgrade(
    url: str, revision: str, *, config: Path | None = None, cutoff: str | None = None
) -> subprocess.CompletedProcess[str]:
    command = [sys.executable, "-m", "alembic", "-c", str(config or ROOT / "apps/api/alembic.ini")]
    if cutoff is not None:
        command.extend(["-x", f"brigade_briefing_cutover={cutoff}"])
    return subprocess.run(
        [*command, "upgrade", revision],
        cwd=ROOT,
        env={**os.environ, "DATABASE_URL": url},
        capture_output=True,
        text=True,
    )


@pytest.mark.parametrize(
    "source_revision,explicit_cutoff",
    [("0017", False), ("0024", True), ("0024", False), ("0025", True), ("0025", False)],
)
def test_upgrade_preserves_legacy_dispatch_without_inventing_briefing(
    migration_database_url, source_revision, explicit_cutoff, published_alembic_config
):
    url = migration_database_url
    if source_revision == "0025":
        result = upgrade(url, source_revision, config=published_alembic_config)
        assert result.returncode == 0, result.stdout + result.stderr
    else:
        migrate(url, source_revision)
    now = datetime(2026, 9, 30, 10, tzinfo=UTC)
    ids = {
        key: uuid4()
        for key in ("session", "participant", "assignment", "card", "brigade", "target")
    }

    async def prepare(db):
        if source_revision == "0025":
            assert await db.scalar(text("SELECT version_num FROM alembic_version")) == "0025"
            assert await db.scalar(text("SELECT to_regclass('legacy_brigade_dispatches')")) is None
        await seed(db, "test-password", include_training=False)
        teacher = await db.scalar(select(User.id).where(User.login == "teacher"))
        trainee = await db.scalar(select(User.id).where(User.login == "trainee01"))
        scenario = await db.scalar(select(Scenario.id).limit(1))
        metadata = MetaData()
        await (await db.connection()).run_sync(metadata.reflect)
        rows = [
            (
                "sessions",
                dict(
                    id=ids["session"],
                    teacher_id=teacher,
                    title="До вводных",
                    status="running",
                    started_at=now,
                    settings_snapshot={},
                ),
            ),
            (
                "session_participants",
                dict(
                    id=ids["participant"],
                    session_id=ids["session"],
                    user_id=trainee,
                    workstation_id=1,
                    dds_service_id="101",
                    level=1,
                    rating_at_start=0.0,
                ),
            ),
            (
                "assignments",
                dict(
                    id=ids["assignment"],
                    session_id=ids["session"],
                    participant_id=ids["participant"],
                    scenario_id=scenario,
                    scenario_version=1,
                    order=1,
                    status="delivered",
                    delay_from_start_s=0,
                    delivery_mode="profile",
                    due_at=now,
                ),
            ),
            (
                "cards",
                dict(
                    id=ids["card"],
                    assignment_id=ids["assignment"],
                    number="99018001",
                    state="accepted",
                    appeared_at=now,
                    current={},
                ),
            ),
            (
                "brigades",
                dict(
                    id=ids["brigade"], service_id="101", name="Историческая бригада", is_active=True
                ),
            ),
            (
                "call_targets",
                dict(
                    id=ids["target"],
                    service_id="101",
                    brigade_id=ids["brigade"],
                    name="Старший",
                    phone_ext="291",
                    voice_profile="default",
                    is_active=True,
                ),
            ),
            ("card_brigades", dict(card_id=ids["card"], brigade_id=ids["brigade"])),
        ]
        for table, values in rows:
            await db.execute(metadata.tables[table].insert().values(**values))
        for seconds, refusal in ((1, "not_assigned"), (3, None), (5, None)):
            await db.execute(
                metadata.tables["calls"]
                .insert()
                .values(
                    id=uuid4(),
                    card_id=ids["card"],
                    service_id="101",
                    dialed_ext="291",
                    brigade_id=ids["brigade"],
                    target_id=ids["target"],
                    started_at=now,
                    answered_at=now + timedelta(seconds=seconds),
                    refusal=refusal,
                )
            )

        if source_revision == "0024":
            # Исходная 0018 не сохраняла снимок. Имитируем уже обновлённую базу и задаём
            # подтверждённую границу развёртывания явно, а не угадываем её по пустой вводной.
            await db.execute(text("DROP TABLE legacy_brigade_dispatches"))

    run_db(url, prepare)
    if not explicit_cutoff:
        migrate(url, "head")
    else:
        cutoff = (now + timedelta(seconds=4)).astimezone(timezone(timedelta(hours=3)))
        result = upgrade(url, "head", cutoff=cutoff.isoformat())
        assert result.returncode == 0, result.stdout + result.stderr

    async def verify(db):
        from app.core.models import SCHEMA_REVISION, BrigadeBriefing

        card = await db.get(Card, ids["card"])
        sent = await dispatched(db, card.id)
        assert await db.scalar(text("SELECT version_num FROM alembic_version")) == SCHEMA_REVISION
        if source_revision in {"0024", "0025"} and not explicit_cutoff:
            assert sent == {}
            return
        assert sent == {ids["brigade"]: now + timedelta(seconds=3)}
        assert (
            await db.scalar(select(BrigadeBriefing.id).where(BrigadeBriefing.card_id == card.id))
            is None
        )
        journal = await load_journal(db, card)
        assert dispatched_at(ids["brigade"], journal) == sent[ids["brigade"]]
        planned = [
            {
                "brigade_id": str(uuid4()),
                "call_target_id": str(uuid4()),
                "message": {"id": str(uuid4()), "version": 1},
                "requires_state": "accepted",
                "available_after_s": 8,
            }
        ]
        crew = await card_crew(db, card, planned)
        assert list(crew.values()) == [(ids["brigade"], ids["target"])]
        [report] = schedule_reports(planned, sent, [("accepted", now)], set(), crew)
        assert report.waiting_started_at == now + timedelta(seconds=3)
        assert report.ready_at is not None
        assert await db.scalar(text("SELECT version_num FROM alembic_version")) == SCHEMA_REVISION

    run_db(url, verify)


def test_fresh_upgrade_reaches_current_head(migration_database_url):
    migrate(migration_database_url, "head")

    async def verify(db):
        from app.core.models import SCHEMA_REVISION

        assert await db.scalar(text("SELECT version_num FROM alembic_version")) == SCHEMA_REVISION
        assert SCHEMA_REVISION == "0030"
        assert await db.scalar(text("SELECT to_regclass('legacy_brigade_dispatches')")) is not None
        assert await db.scalar(text("SELECT count(*) FROM legacy_brigade_dispatches")) == 0

    run_db(migration_database_url, verify)


def test_upgrade_from_published_0025_rejects_cutover_without_timezone(
    migration_database_url, published_alembic_config
):
    url = migration_database_url
    result = upgrade(url, "0025", config=published_alembic_config)
    assert result.returncode == 0, result.stdout + result.stderr
    result = upgrade(url, "head", cutoff="2026-09-30T10:00:04")
    assert result.returncode != 0
    assert "brigade_briefing_cutover должен содержать часовой пояс" in result.stderr

    async def verify(db):
        assert await db.scalar(text("SELECT version_num FROM alembic_version")) == "0025"
        assert await db.scalar(text("SELECT to_regclass('legacy_brigade_dispatches')")) is None

    run_db(url, verify)


def test_published_0025_and_0026_preserve_user_renamed_names(
    migration_database_url, published_alembic_config
):
    url = migration_database_url
    result = upgrade(url, "0024", config=published_alembic_config)
    assert result.returncode == 0, result.stdout + result.stderr
    brigade_ids = [uuid4(), uuid4()]
    target_ids = [uuid4(), uuid4()]

    async def prepare(db):
        await seed(db, "test-password", include_training=False)
        metadata = MetaData()
        await (await db.connection()).run_sync(metadata.reflect)
        service_name = await db.scalar(text("SELECT name FROM services WHERE id = 'GKH'"))
        assert service_name is not None
        for index, name in enumerate(["Учебная бригада 99 службы GKH", "Бригада преподавателя"]):
            await db.execute(
                metadata.tables["brigades"]
                .insert()
                .values(id=brigade_ids[index], service_id="GKH", name=name, is_active=True)
            )
        for index, name in enumerate(["Учебный диспетчер GKH", "Диспетчер преподавателя"]):
            await db.execute(
                metadata.tables["call_targets"]
                .insert()
                .values(
                    id=target_ids[index],
                    service_id="GKH",
                    brigade_id=brigade_ids[index],
                    name=name,
                    phone_ext=str(991 + index),
                    voice_profile="default",
                    is_active=True,
                )
            )
        return service_name, await snapshot(db)

    async def snapshot(db):
        metadata = MetaData()
        await (await db.connection()).run_sync(metadata.reflect)
        rows = {}
        for table, ids in [("brigades", brigade_ids), ("call_targets", target_ids)]:
            model = metadata.tables[table]
            rows[table] = {
                row["id"]: dict(row)
                for row in (await db.execute(select(model).where(model.c.id.in_(ids)))).mappings()
            }
        return rows

    service_name, before = run_db(url, prepare)
    expected = {
        "brigades": {
            brigade_ids[0]: f"Учебная бригада 99 службы {service_name}",
            brigade_ids[1]: "Бригада преподавателя",
        },
        "call_targets": {
            target_ids[0]: f"Учебный диспетчер {service_name}",
            target_ids[1]: "Диспетчер преподавателя",
        },
    }
    for revision, config in [("0025", published_alembic_config), ("head", None)]:
        result = upgrade(url, revision, config=config)
        assert result.returncode == 0, result.stdout + result.stderr
        after = run_db(url, snapshot)
        for table, rows in before.items():
            for row_id, row in rows.items():
                assert after[table][row_id] == {**row, "name": expected[table][row_id]}
