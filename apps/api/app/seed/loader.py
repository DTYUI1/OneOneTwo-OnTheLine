"""Начальная загрузка сохраняет изменения преподавателя и пароли при повторном запуске."""

import csv
import gzip
import json
import logging
import unicodedata
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from sqlalchemy import delete, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import ROOT
from app.core.contracts import validate_json
from app.core.models import (
    Base,
    IncidentType,
    RoutingRule,
    Scenario,
    ScenarioPack,
    ScenarioPackItem,
    SeedArtifact,
    Service,
    Setting,
    Street,
    User,
    Workstation,
)
from app.core.security import hash_password

logger = logging.getLogger(__name__)


async def insert_missing(db: AsyncSession, model: type[Base], rows: list[dict[str, Any]]) -> None:
    # Пакеты ограничены по числу параметров asyncpg; seed не перезаписывает рабочие данные.
    for offset in range(0, len(rows), 200):
        await db.execute(insert(model).values(rows[offset : offset + 200]).on_conflict_do_nothing())


async def sync_classifier(db: AsyncSession, classifier: dict[str, Any]) -> None:
    """Привести справочник к артефакту: он собирается только из исходника классификатора.

    При смене редакции (046_11 → 046_24) старые правила маршрутизации удаляются, иначе
    оценщик видел бы объединение двух редакций. Типы обновляются на месте: на них ссылаются
    сценарии, а исправления названий из новой редакции должны дойти до стенда.
    """
    types = [{**row, "raw": row} for row in classifier["incident_types"]]
    for offset in range(0, len(types), 200):
        statement = insert(IncidentType).values(types[offset : offset + 200])
        await db.execute(
            statement.on_conflict_do_update(
                index_elements=[IncidentType.code],
                set_={
                    column: statement.excluded[column] for column in types[0] if column != "code"
                },
            )
        )
    rules = [
        {**row, "id": uuid5(NAMESPACE_URL, json.dumps(row, sort_keys=True, ensure_ascii=False))}
        for row in classifier["routing_rules"]
    ]
    await insert_missing(db, RoutingRule, rules)
    await db.execute(delete(RoutingRule).where(RoutingRule.id.not_in([row["id"] for row in rules])))


async def seed(
    db: AsyncSession,
    password: str,
    data_dir: Path = ROOT / "data",
    *,
    include_training: bool = True,
) -> dict[str, int]:
    # Два одновременных seed должны видеть завершённую загрузку друг друга.
    await db.execute(text("SELECT pg_advisory_xact_lock(112007)"))
    counts: dict[str, int] = {}

    async def artifact(path: Path, value: dict[str, Any], schema: str) -> None:
        validate_json(value, schema)
        await insert_missing(
            db,
            SeedArtifact,
            [
                {
                    "path": path.relative_to(data_dir).as_posix(),
                    "schema_name": schema,
                    "content": value,
                }
            ],
        )

    def read(path: str) -> Any:
        return json.loads((data_dir / path).read_text(encoding="utf-8"))

    classifier = read("classifier.json")
    await artifact(
        data_dir / "classifier.json",
        classifier,
        "https://arm112.local/contracts/storage.schema.json#/$defs/Classifier",
    )
    services = read("phonebook.json")
    for service in services:
        validate_json(service, "urn:openapi#/components/schemas/Service")
    await insert_missing(db, Service, services)
    if include_training:
        from app.seed.training import seed_catalog

        await seed_catalog(db)
    workstations = read("seed/workstations.json")
    validate_json(
        workstations, "https://arm112.local/contracts/storage.schema.json#/$defs/Workstations"
    )
    await insert_missing(db, Workstation, workstations)
    users = read("seed/demo_users.json")
    for account in users:
        validate_json(account, "urn:openapi#/components/schemas/User")
        await insert_missing(
            db,
            User,
            [
                {
                    **account,
                    "id": UUID(account["id"]),
                    "password_hash": await hash_password(password),
                    "is_active": True,
                }
            ],
        )
    await sync_classifier(db, classifier)
    # Golden и template D1 имеют общий UUID при разном весе. Пакет использует golden;
    # исходный шаблон сохраняется отдельно, без потери одной из версий артефакта.
    scenarios: dict[str, dict[str, Any]] = {}
    for path in sorted((data_dir / "templates").glob("*.json")):
        value = json.loads(path.read_text(encoding="utf-8"))
        await artifact(path, value, "https://arm112.local/contracts/scenario.schema.json")
        scenarios[value["id"]] = value
    for path in sorted((data_dir / "golden_scenarios").glob("*.json")):
        value = json.loads(path.read_text(encoding="utf-8"))
        await artifact(path, value, "https://arm112.local/contracts/golden.schema.json")
        scenarios[value["scenario"]["id"]] = value["scenario"]
    # C-05: задания по билетам заказчика; эталон команды остаётся draft до проверки
    # преподавателем. Происхождение каждого — data/ticket_scenarios/manifest.json.
    for path in sorted((data_dir / "ticket_scenarios").glob("ticket-*.json")):
        value = json.loads(path.read_text(encoding="utf-8"))
        await artifact(path, value, "https://arm112.local/contracts/scenario.schema.json")
        scenarios[value["id"]] = value
    await insert_missing(
        db, Scenario, [{**value, "id": UUID(value["id"])} for value in scenarios.values()]
    )
    for path in sorted((data_dir / "packs").glob("*.json")):
        value = json.loads(path.read_text(encoding="utf-8"))
        await artifact(
            path, value, "https://arm112.local/contracts/storage.schema.json#/$defs/Pack"
        )
        pack = {key: value[key] for key in ("title", "status", "origin")}
        await insert_missing(db, ScenarioPack, [{**pack, "id": UUID(value["id"])}])
        await insert_missing(
            db,
            ScenarioPackItem,
            [
                {"pack_id": UUID(value["id"]), "scenario_id": UUID(scenario_id), "order": index}
                for index, scenario_id in enumerate(value["scenario_ids"])
            ],
        )
    config = read("seed/settings.json")
    validate_json(config, "urn:openapi#/components/schemas/Settings")
    await insert_missing(db, Setting, [{"key": "training", "value": config}])
    manifest = read("voices/manifest.json")
    await artifact(
        data_dir / "voices/manifest.json",
        manifest,
        "https://arm112.local/contracts/storage.schema.json#/$defs/VoiceManifest",
    )
    if manifest["status"] == "pending":
        logger.warning("Манифест голосов загружен; аудиофайлы ещё не поставлены (T-005).")
    streets_file = data_dir / "streets.csv.gz"
    if streets_file.exists():
        with gzip.open(streets_file, "rt", encoding="utf-8", newline="") as stream:
            streets = list(csv.DictReader(stream))
        rows = []
        for street in streets:
            validate_json(
                street, "https://arm112.local/contracts/storage.schema.json#/$defs/Street"
            )
            rows.append(
                {
                    **street,
                    "id": uuid5(NAMESPACE_URL, json.dumps(street, sort_keys=True)),
                    "name_norm": unicodedata.normalize("NFKC", street["name"]).casefold(),
                }
            )
        await insert_missing(db, Street, rows)
        counts["streets"] = len(rows)
    else:
        counts["streets"] = 0
        logger.warning("Справочник streets.csv.gz не поставлен (T-005/T-021).")
    counts.update(
        users=len(users),
        services=len(services),
        scenarios=len(scenarios),
        incident_types=len(classifier["incident_types"]),
        routing_rules=len(classifier["routing_rules"]),
    )
    return counts
