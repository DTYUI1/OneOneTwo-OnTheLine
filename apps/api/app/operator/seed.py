"""Идемпотентная загрузка сценариев модуля «Оператор 112» в БД.

OP-01 (таблицы попыток и своя схема модуля) отложена: миграция 0013 требует правку
SCHEMA_REVISION вне зоны operator (handoff.md). До неё сценарии и опросные карты
хранятся в общей таблице settings — она уже есть в схеме и рассчитана на произвольный
JSON по ключу; переезд на свои таблицы модуля — вместе с OP-01.
"""

import asyncio
import logging
from typing import Any

from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings as app_settings
from app.core.db import Database
from app.core.models import Setting
from app.operator.scenarios import load_questionnaires, load_scenarios

logger = logging.getLogger(__name__)

SCENARIO_KEY_PREFIX = "operator.scenario."
QUESTIONNAIRE_KEY_PREFIX = "operator.questionnaire."


async def seed_operator_scenarios(db: AsyncSession) -> list[str]:
    """Записать сценарии и опросные карты; повторный запуск не создаёт дублей, а сценарии,
    убранные из ротации (data/operator/archive/), удаляет."""
    rows: list[dict[str, Any]] = [
        {"key": f"{QUESTIONNAIRE_KEY_PREFIX}{questionnaire['id']}", "value": questionnaire}
        for questionnaire in load_questionnaires().values()
    ] + [
        {"key": f"{SCENARIO_KEY_PREFIX}{scenario['id']}", "value": scenario}
        for scenario in load_scenarios()
    ]
    loaded: list[str] = []
    for row in rows:
        statement = insert(Setting).values(key=row["key"], value=row["value"], updated_by=None)
        await db.execute(
            statement.on_conflict_do_update(
                index_elements=[Setting.key],
                set_={"value": statement.excluded.value, "updated_by": None},
            )
        )
        loaded.append(row["key"])
    await db.execute(
        delete(Setting).where(
            Setting.key.like(f"{SCENARIO_KEY_PREFIX}%")
            | Setting.key.like(f"{QUESTIONNAIRE_KEY_PREFIX}%"),
            Setting.key.not_in(loaded),
        )
    )
    return loaded


async def main() -> None:
    database = Database(app_settings.database_url)
    try:
        async with database.sessions.begin() as db:
            keys = await seed_operator_scenarios(db)
        logger.info("Загружены сценарии и опросные карты «Оператор 112»: %s", len(keys))
    finally:
        await database.close()


if __name__ == "__main__":
    from app.core.logging import configure_logging

    configure_logging()
    asyncio.run(main())
