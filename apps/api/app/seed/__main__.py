import asyncio
import logging

from jsonschema import ValidationError
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import settings
from app.core.db import Database
from app.core.logging import configure_logging
from app.seed.loader import seed


async def main() -> None:
    database = Database(settings.database_url)
    try:
        async with database.sessions.begin() as session:
            counts = await seed(session, settings.demo_password)
        logging.getLogger(__name__).info("Начальные данные загружены: %s", counts)
    except (SQLAlchemyError, ValidationError, OSError, ValueError):
        # Исключения валидатора/драйвера содержат входные данные и SQL-параметры.
        logging.getLogger(__name__).error(
            "Загрузка отменена: проверьте миграцию, доступность БД и форматы data/."
        )
        raise SystemExit(1) from None
    finally:
        await database.close()


if __name__ == "__main__":
    configure_logging()
    asyncio.run(main())
