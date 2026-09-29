"""Alembic использует тот же env-конфиг, что API и seed."""

import asyncio

from alembic import context
from app.core.config import settings
from app.core.db import Database
from app.core.models import Base
from sqlalchemy import Connection


def migrate(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=Base.metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


async def online() -> None:
    database = Database(settings.database_url)
    try:
        async with database.engine.connect() as connection:
            await connection.run_sync(migrate)
    finally:
        await database.close()


if context.is_offline_mode():
    context.configure(url=settings.database_url, target_metadata=Base.metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    asyncio.run(online())
