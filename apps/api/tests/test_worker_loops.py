"""Долгое задание (ИИ-оценка) не останавливает выдачу карточек и сведений."""

import asyncio

import pytest
from app.worker.__main__ import run


class SlowJobWorker:
    def __init__(self) -> None:
        self.scheduled = 0
        self.jobs = 0

    async def schedule(self) -> bool:
        self.scheduled += 1
        return False

    async def work(self) -> bool:
        self.jobs += 1
        # Как вызов модели: секунды, в течение которых планирование должно идти.
        await asyncio.sleep(10)
        return True


def test_scheduling_continues_during_long_job() -> None:
    worker = SlowJobWorker()

    async def scenario() -> None:
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(run(worker, 0.01), timeout=0.3)  # type: ignore[arg-type]

    asyncio.run(scenario())
    assert worker.jobs == 1
    assert worker.scheduled >= 10


class FailingScheduler(SlowJobWorker):
    async def schedule(self) -> bool:
        raise RuntimeError("БД недоступна")


def test_loop_failure_stops_worker_for_restart() -> None:
    with pytest.raises(RuntimeError, match="БД недоступна"):
        asyncio.run(run(FailingScheduler(), 0.01))  # type: ignore[arg-type]
