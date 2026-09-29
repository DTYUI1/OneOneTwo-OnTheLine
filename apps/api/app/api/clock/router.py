from collections.abc import Callable
from typing import Any

from fastapi import Request

from app.api.clock import service


async def register_clock_sample(
    request: Request, body: service.ClockSampleInput
) -> service.ClockSampleReceipt:
    return await service.register_sample(request, body)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "registerClockSample": (register_clock_sample, service.ClockSampleReceipt),
}
