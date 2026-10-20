"""Повторные чтения в одной транзакции: пока сессия ничего не записала, ответ тот же.

Тик worker и запрос API собирают мир карточки из многих функций, и каждая перечитывает одно
и то же: вводные бригад, план сценария, историю статусов, звонки (до 30 одинаковых запросов
за тик). `remembered` отдаёт прочитанное раньше в этой транзакции, пока сессия не писала:
любая запись (flush, DML), commit или rollback кэш сбрасывают. Несохранённые изменения перед
чтением сбрасываются в БД, как сделал бы autoflush перед запросом.
"""

from collections.abc import Awaitable, Callable, Hashable
from typing import Any

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import ORMExecuteState, Session

KEY = "read_cache"


async def remembered[T](db: AsyncSession, key: Hashable, load: Callable[[], Awaitable[T]]) -> T:
    """Значение `load()` для `key` в этой транзакции; списки отдавать копией — дело вызывающего."""
    if db.new or db.dirty or db.deleted:
        await db.flush()
    cache: dict[Hashable, Any] | None = db.info.get(KEY)
    if cache is not None and key in cache:
        return cache[key]  # type: ignore[no-any-return]
    value = await load()
    db.info.setdefault(KEY, {})[key] = value
    return value


def _forget(session: Session, *_: Any) -> None:
    session.info.pop(KEY, None)


for _name in (
    "after_begin",
    "after_flush",
    "after_commit",
    "after_rollback",
    "after_soft_rollback",
):
    event.listen(Session, _name, _forget)


@event.listens_for(Session, "do_orm_execute")
def _on_write(state: ORMExecuteState) -> None:
    if not state.is_select:
        _forget(state.session)
