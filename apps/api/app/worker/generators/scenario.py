"""Явная граница с будущим публичным `evalcore.scenario.build` (T-026)."""

import inspect
from importlib import import_module
from typing import Any


async def build_scenario(
    *, level: int, service_id: str, seed: int, template: dict[str, Any]
) -> dict[str, Any] | None:
    """Вызвать evalcore-конструктор, если T-026 установлен.

    Пока модуля нет, возвращается None: handler применяет явно помеченный template fallback.
    Это не считается полноценной генерацией и удаляется после контрактного PR T-026.
    """
    try:
        module = import_module("evalcore.scenario")
    except ModuleNotFoundError as exc:
        if exc.name != "evalcore.scenario":
            raise
        return None
    builder = getattr(module, "build", None)
    if builder is None:
        return None
    # The C-05 preview builder needs a classifier snapshot and a constructor.
    # Keep legacy pack generation on its explicit template fallback until its
    # payload and source loading are integrated.
    if "template" not in inspect.signature(builder).parameters:
        return None
    value = builder(level=level, service_id=service_id, seed=seed, template=template)
    if inspect.isawaitable(value):
        value = await value
    if not isinstance(value, dict):
        raise TypeError("evalcore.scenario.build должен вернуть dict по scenario.schema.json")
    return value
