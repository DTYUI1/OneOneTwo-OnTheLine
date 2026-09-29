"""Тестовые обучаемые bench001…benchNNN для замеров C-09 на изолированном стенде.

API создания пользователей в контракте нет, поэтому учётки заводятся так же, как
основной seed: напрямую в БД с argon2-хешем. Повторный запуск ничего не меняет.
Запускать только на отдельном Compose-проекте замеров, не на рабочем стенде.
"""

import argparse
import asyncio
from uuid import NAMESPACE_URL, uuid5

from app.core.config import settings
from app.core.db import Database
from app.core.models import User, Workstation
from app.core.security import hash_password
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert


async def main(count: int, password: str) -> None:
    database = Database(settings.database_url)
    try:
        async with database.sessions.begin() as db:
            stations = set(await db.scalars(select(Workstation.number)))
            digest = await hash_password(password)
            for index in range(1, count + 1):
                login = f"bench{index:03d}"
                await db.execute(
                    insert(User)
                    .values(
                        id=uuid5(NAMESPACE_URL, f"arm112:bench:{login}"),
                        login=login,
                        full_name=f"Замер {index:03d}",
                        role="trainee",
                        password_hash=digest,
                        is_active=True,
                        # Рабочих мест 23: остальные учётки — наблюдатели без АРМ.
                        workstation_number=index if index in stations else None,
                        dds_service_id=None,
                    )
                    .on_conflict_do_nothing(index_elements=[User.login])
                )
        print(f"bench-пользователей: {count}")
    finally:
        await database.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=100)
    parser.add_argument("--password", required=True)
    args = parser.parse_args()
    asyncio.run(main(args.count, args.password))
