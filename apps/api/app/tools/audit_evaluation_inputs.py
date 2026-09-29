"""Диагностика старых настроек/эталонов без изменения сохранённых данных."""

import asyncio
import json
import sys

from evalcore.validation import validate_reference
from pydantic import ValidationError
from sqlalchemy import select, text

from app.api.foundation.schemas import Settings as TrainingSettings
from app.core.config import Settings
from app.core.db import Database
from app.core.models import Scenario, Session, Setting


async def audit() -> list[dict[str, str]]:
    """Прочитать только ID и ошибки совместимости в read-only транзакции."""
    database = Database(Settings().database_url)
    issues = []
    try:
        async with database.sessions.begin() as db:
            await db.execute(text("SET TRANSACTION READ ONLY"))
            entries = [
                ("settings", row.key, row.value)
                for row in await db.scalars(select(Setting).where(Setting.key == "training"))
            ]
            entries.extend(
                ("session", str(row.id), row.settings_snapshot)
                for row in await db.scalars(select(Session))
            )
            for entity, identifier, value in entries:
                try:
                    TrainingSettings.model_validate(value)
                except ValidationError as exc:
                    issues.append(
                        {
                            "entity": entity,
                            "id": identifier,
                            "error": "; ".join(
                                error["msg"] for error in exc.errors(include_input=False)
                            ),
                        }
                    )
            for row in await db.scalars(select(Scenario).where(Scenario.status == "approved")):
                try:
                    validate_reference(row.reference)
                except ValueError as exc:
                    issues.append({"entity": "scenario", "id": str(row.id), "error": str(exc)})
    finally:
        await database.close()
    return issues


if __name__ == "__main__":
    found = asyncio.run(audit())
    sys.stdout.write(json.dumps({"issues": found}, ensure_ascii=False, indent=2) + "\n")
    raise SystemExit(bool(found))
