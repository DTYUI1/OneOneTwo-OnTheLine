"""Имена сида: roundtrip миграции без PostgreSQL, на SQLite в памяти."""

from importlib import import_module
from uuid import NAMESPACE_URL, uuid4, uuid5

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

migration = import_module("migrations.versions.0029_brigade_names")


@pytest.fixture
def catalog(monkeypatch):
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    services = sa.Table(
        "services",
        metadata,
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String()),
    )
    brigades = sa.Table(
        "brigades",
        metadata,
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("service_id", sa.String()),
        sa.Column("name", sa.String()),
        sa.Column("is_active", sa.Boolean()),
    )
    targets = sa.Table(
        "call_targets",
        metadata,
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("brigade_id", sa.Uuid()),
        sa.Column("name", sa.String()),
        sa.Column("phone_ext", sa.String()),
        sa.Column("is_active", sa.Boolean()),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        monkeypatch.setattr(migration, "op", Operations(MigrationContext.configure(connection)))
        # На 0028 бригады цифровой ДДС — «службы 101», остальных — с названием службы (0025).
        for service, title, exts in (
            ("101", "Пожарная охрана", ("201", "202", "301", "302")),
            ("MOSLIFT", "Мослифт", ("211", "212", "311", "312")),
        ):
            connection.execute(services.insert().values(id=service, name=title))
            tag = service if service.isdigit() else title
            for ordinal, ext in enumerate(exts):
                brigade = uuid5(NAMESPACE_URL, f"arm112:c04:{service}:brigade:{ordinal}")
                connection.execute(
                    brigades.insert().values(
                        id=brigade,
                        service_id=service,
                        name=f"Учебная бригада {ordinal + 1} службы {tag}",
                        is_active=ordinal != 3,
                    )
                )
                connection.execute(
                    targets.insert().values(
                        id=uuid5(NAMESPACE_URL, f"arm112:c04:{service}:target:{ordinal}"),
                        brigade_id=brigade,
                        name=f"Учебный старший бригады {ordinal + 1}",
                        phone_ext=ext,
                        is_active=ordinal != 3,
                    )
                )
        # Абонент службы без бригады не участвует в переименовании.
        connection.execute(
            targets.insert().values(
                id=uuid4(), name="Учебный диспетчер 101", phone_ext="101", is_active=True
            )
        )
        yield connection, brigades, targets
    engine.dispose()


def snapshot(connection, table):
    return {row["id"]: dict(row) for row in connection.execute(sa.select(table)).mappings()}


def test_upgrade_downgrade_preserve_ids_numbers_activity_and_manual_names(catalog):
    connection, brigades, targets = catalog
    brigade_id = uuid5(NAMESPACE_URL, "arm112:c04:101:brigade:0")
    target_id = uuid5(NAMESPACE_URL, "arm112:c04:101:target:1")
    connection.execute(
        brigades.update().where(brigades.c.id == brigade_id).values(name="Расчёт Северный")
    )
    connection.execute(
        targets.update().where(targets.c.id == target_id).values(name="Старший Петров")
    )
    before = {table.name: snapshot(connection, table) for table in (brigades, targets)}
    migration.upgrade()
    after = {table.name: snapshot(connection, table) for table in (brigades, targets)}
    for table in (brigades, targets):
        for record_id, row in after[table.name].items():
            original = before[table.name][record_id]
            assert {key: value for key, value in row.items() if key != "name"} == {
                key: value for key, value in original.items() if key != "name"
            }
            if (
                record_id in (brigade_id, target_id)
                or row.get("brigade_id") is None
                and table is targets
            ):
                assert row == original
            else:
                target = (
                    row
                    if table is targets
                    else next(
                        item
                        for item in after["call_targets"].values()
                        if item["brigade_id"] == record_id
                    )
                )
                prefix = "Старший бригады" if table is targets else "Бригада"
                assert row["name"] == f"{prefix} {target['phone_ext']}"
    assert list(
        connection.scalars(
            sa.select(brigades.c.name)
            .where(brigades.c.service_id == "MOSLIFT")
            .order_by(brigades.c.name)
        )
    ) == ["Бригада 211", "Бригада 212", "Бригада 311", "Бригада 312"]
    migration.upgrade()
    assert {table.name: snapshot(connection, table) for table in (brigades, targets)} == after
    migration.downgrade()
    assert {table.name: snapshot(connection, table) for table in (brigades, targets)} == before


def test_downgrade_keeps_names_changed_after_upgrade(catalog):
    connection, brigades, targets = catalog
    migration.upgrade()
    connection.execute(brigades.update().values(name="Ручное имя бригады"))
    connection.execute(targets.update().values(name="Ручное имя абонента"))
    before = {table.name: snapshot(connection, table) for table in (brigades, targets)}
    migration.downgrade()
    assert {table.name: snapshot(connection, table) for table in (brigades, targets)} == before


def test_upgrade_accepts_name_with_service_id_left_before_0025(catalog):
    # Стенд, где 0025 не нашла запись (имя правили и вернули): имя с идентификатором службы.
    connection, brigades, targets = catalog
    brigade_id = uuid5(NAMESPACE_URL, "arm112:c04:MOSLIFT:brigade:0")
    connection.execute(
        brigades.update()
        .where(brigades.c.id == brigade_id)
        .values(name="Учебная бригада 1 службы MOSLIFT")
    )
    migration.upgrade()
    assert (
        connection.scalar(sa.select(brigades.c.name).where(brigades.c.id == brigade_id))
        == "Бригада 211"
    )
