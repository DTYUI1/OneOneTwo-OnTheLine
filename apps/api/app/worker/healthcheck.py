"""Проверка доступности БД для Docker; heartbeat worker проверяется через /api/health."""

import asyncio
import os
import sys

import asyncpg  # type: ignore[import-untyped]


async def check_database(database_url: str) -> None:
    """Открыть и закрыть соединение в одном loop, уложившись в Docker timeout 5 с."""
    connection = await asyncpg.connect(
        database_url.replace("postgresql+asyncpg://", "postgresql://", 1), timeout=3
    )
    # После asyncio.run loop уже закрыт: ни terminate(), ни новый run(close()) не подходят.
    await connection.close(timeout=1)


def main() -> int:
    """Вернуть ненулевой код при недоступной БД, не выводя DSN/пароль в Docker health log."""
    try:
        asyncio.run(check_database(os.environ["DATABASE_URL"]))
    except Exception as exc:
        print(f"Worker database healthcheck failed: {type(exc).__name__}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
