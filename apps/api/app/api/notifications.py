"""Транзакционная публикация ссылок на события через PostgreSQL."""

import json
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

CHANNEL = "arm112_events"


async def notify(db: AsyncSession, event_type: str, entity_id: UUID) -> None:
    payload = json.dumps({"type": event_type, "id": str(entity_id)}, separators=(",", ":"))
    await db.execute(select(func.pg_notify(CHANNEL, payload)))
