import asyncio
import logging
from collections.abc import Awaitable, Callable

from app.core.config import settings
from app.worker.runtime import Worker

logger = logging.getLogger(__name__)


async def repeat(step: Callable[[], Awaitable[bool]], pause: float) -> None:
    while True:
        if not await step():
            await asyncio.sleep(pause)


async def run(worker: Worker, pause: float) -> None:
    """Планирование и очередь заданий — независимые циклы.

    ИИ-оценка комментария идёт до минуты; в общем цикле она останавливала выдачу
    карточек и докладов бригад всем обучаемым (замер на i7: появление карточки
    p95 23 с). Сбой любого цикла завершает процесс — Compose его перезапустит.
    """
    await asyncio.gather(repeat(worker.schedule, pause), repeat(worker.work, pause))


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format='{"level":"%(levelname)s","message":"%(message)s"}'
    )
    worker = Worker(settings)
    logger.info("Worker запущен: scheduler и PostgreSQL jobs активны.")
    try:
        await run(worker, settings.worker_poll_interval_seconds)
    finally:
        await worker.close()


if __name__ == "__main__":
    asyncio.run(main())
