"""Модели локального ИИ: каталог, оборудование, выбор администратора (HQ-016).

По умолчанию — Qwen3-4B на процессоре. Администратор меняет модель и режим (процессор или
видеокарта) без перезапуска: сервер модели llama.cpp работает роутером и загружает модель
по имени пресета `<модель>-<режим>` (deploy/llm/models.ini). Видеокарту определяет скрипт
запуска стенда на хосте (scripts/ai/detect_gpu.sh → AI_HARDWARE): из контейнера API драйвер
хоста не виден.
"""

import json
import math
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any, get_args

import httpx
from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.ai_models import schemas
from app.api.system.service import machine
from app.core.config import ROOT, Settings
from app.core.models import Scenario, Setting

SETTING_KEY = "ai_model"
NOTICE_KEY = "ai_gpu_notice"
GPU_REASONS = {
    "none": "Дискретная видеокарта не найдена.",
    "no_driver": (
        "Видеокарта есть, но llama.cpp в контейнере её не видит: нет драйвера "
        "или доступа контейнеров к ней."
    ),
    "no_image": "Нет образа llama.cpp для видеокарты: проверить карту нечем (deploy/README.md).",
    "unknown": "Видеокарту не проверяли: стенд запущен с --gpu off или вручную.",
    "ready": "Сервер модели запущен без доступа к видеокарте: перезапустите стенд.",
}
FORCE_HINT = " Чтобы всё равно попробовать, запустите стенд с --gpu force."


@lru_cache
def catalog() -> dict[str, Any]:
    return json.loads((ROOT / "data/ai-models.json").read_text(encoding="utf-8"))


def alias(choice: dict[str, str]) -> str:
    """Имя пресета роутера llama.cpp."""
    return f"{choice['model']}-{choice['mode']}"


async def active_choice(db: AsyncSession) -> dict[str, str]:
    row = await db.get(Setting, SETTING_KEY)
    known = {model["id"] for model in catalog()["models"]}
    if (
        row is not None
        and row.value.get("model") in known
        and row.value.get("mode")
        in {
            "cpu",
            "gpu",
        }
    ):
        return {"model": row.value["model"], "mode": row.value["mode"]}
    return dict(catalog()["default"])


def hardware(config: Settings) -> dict[str, Any]:
    try:
        found = json.loads(config.ai_hardware) if config.ai_hardware else {}
    except json.JSONDecodeError:
        found = {}
    state = found.get("state") if found.get("state") in get_args(schemas.GpuState) else "unknown"
    backend = found.get("backend") if found.get("backend") in get_args(schemas.Backend) else None
    text = {
        key: found.get(key) if isinstance(found.get(key), str) else None
        for key in ("device", "name")
    }
    stats = machine()
    return {
        "cpu_cores": stats["cores"],
        "memory_total_bytes": stats["memory_total_bytes"],
        "gpu": {
            "state": state,
            "backend": backend,
            **text,
            "vram_mb": found.get("vram_mb") if isinstance(found.get("vram_mb"), int) else None,
        },
        "llm_gpu": found.get("llm_gpu") is True,
        "forced": found.get("forced") is True,
    }


def installed(models_dir: Path, model: dict[str, Any]) -> bool:
    """Файл на месте и целиком: недокопированная модель не загрузится."""
    path = models_dir / model["file"]
    return path.is_file() and path.stat().st_size == model["size_bytes"]


def mode_check(
    model: dict[str, Any], mode: str, found: bool, box: dict[str, Any]
) -> tuple[str | None, bool]:
    """Почему режим недоступен и можно ли «всё равно использовать видеокарту».

    Принудительно — только когда у сервера модели есть доступ к карте (llm_gpu): без него
    модель на видеокарте не загрузится в любом случае, нужен перезапуск с --gpu force.
    """
    if not found:
        return "Файл модели не установлен.", False
    memory = box["memory_total_bytes"]
    if mode == "cpu":
        if memory is not None and memory < model["ram_gb"] * 0.9 * 1024**3:
            return (
                f"Нужно от {model['ram_gb']:g} ГБ оперативной памяти, "
                f"на сервере {memory / 1024**3:.0f} ГБ."
            ), False
        return None, False
    gpu = box["gpu"]
    if not box["llm_gpu"]:
        hint = FORCE_HINT if gpu["state"] in {"no_driver", "unknown"} else ""
        return GPU_REASONS[gpu["state"]] + hint, False
    if gpu["vram_mb"] is not None and gpu["vram_mb"] < model["vram_gb"] * 1024:
        return (
            f"Нужно от {model['vram_gb']:g} ГБ видеопамяти, "
            f"у видеокарты {gpu['vram_mb'] / 1024:.0f} ГБ."
        ), True
    if gpu["state"] != "ready":
        return "Проверка видеокарту не подтвердила: доступ дан вручную (--gpu force).", True
    return None, False


def effective(choice: dict[str, str], statuses: dict[str, str] | None) -> tuple[str, bool]:
    """Пресет, которым ИИ работает на деле: видеокарта не загрузилась — процессор."""
    if choice["mode"] == "gpu" and (statuses or {}).get(alias(choice)) == "failed":
        return alias({**choice, "mode": "cpu"}), True
    return alias(choice), False


def router_url(config: Settings) -> str:
    return config.llm_base_url.rstrip("/").removesuffix("/v1")


async def router_status(config: Settings) -> dict[str, str] | None:
    return await router_statuses(config.llm_base_url)


async def router_statuses(base_url: str) -> dict[str, str] | None:
    """Состояние пресетов роутера; None — сервер модели не отвечает или не роутер."""
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            response = await client.get(f"{base_url.rstrip('/').removesuffix('/v1')}/models")
        response.raise_for_status()
        result: dict[str, str] = {}
        for item in response.json()["data"]:
            status = item.get("status") or {}
            value = "failed" if status.get("failed") else status.get("value", "unknown")
            result[item["id"]] = value if value in get_args(schemas.LoadStatus) else "unknown"
        return result
    except (httpx.HTTPError, KeyError, TypeError, ValueError):
        return None


async def local_generation(db: AsyncSession) -> dict[str, Any]:
    """Средняя длительность попыток локальной модели в сохранённых сценариях за сутки."""
    rows = await db.scalars(
        select(Scenario.generation_metadata).where(
            Scenario.created_at >= datetime.now(UTC) - timedelta(hours=24),
            Scenario.generation_metadata.is_not(None),
        )
    )
    durations = []
    for metadata in rows:
        if not isinstance(metadata, dict) or not str(metadata.get("model", "")).startswith(
            "local:"
        ):
            continue
        for attempt in metadata.get("attempts", []):
            value = attempt.get("duration_seconds")
            if type(value) in (int, float) and math.isfinite(value) and value >= 0:
                durations.append(value)
    return {
        "period_hours": 24,
        "attempts": len(durations),
        "mean_seconds": round(sum(durations) / len(durations), 2) if durations else None,
    }


async def view(request: Request) -> schemas.AIModels:
    config: Settings = request.app.state.config
    db: AsyncSession = request.state.db
    box = hardware(config)
    statuses = await router_status(config) if config.ai_provider == "local" else None
    choice = await active_choice(db)
    models = []
    for model in catalog()["models"]:
        found = installed(config.llm_models_dir, model)
        models.append(
            {
                **{key: model[key] for key in ("id", "title", "file", "size_bytes", "source")},
                **{
                    key: model[key]
                    for key in ("ram_gb", "vram_gb", "summary", "pros", "cons", "choose_when")
                },
                "installed": found,
                "modes": [
                    {
                        "mode": mode,
                        "available": (check := mode_check(model, mode, found, box))[0] is None,
                        "reason": check[0],
                        "can_force": check[1],
                        "status": (statuses or {}).get(f"{model['id']}-{mode}", "unknown"),
                    }
                    for mode in ("cpu", "gpu")
                ],
            }
        )
    notice = await db.get(Setting, NOTICE_KEY)
    dismissed = notice is not None and notice.value.get("dismissed") is True
    gpu_ready = any(
        mode["mode"] == "gpu" and mode["available"] for model in models for mode in model["modes"]
    )
    return schemas.AIModels.model_validate(
        {
            "ai_enabled": config.ai_provider == "local",
            "router": statuses is not None,
            "active": {
                **choice,
                "status": (statuses or {}).get(alias(choice), "unknown"),
                "fallback": effective(choice, statuses)[1],
            },
            "hardware": box,
            "gpu_suggestion": gpu_ready and choice["mode"] == "cpu" and not dismissed,
            "notice_dismissed": dismissed,
            "models": models,
            "benchmarks": catalog()["benchmarks"],
            "local_generation": await local_generation(db),
        }
    )


async def choose(request: Request, body: schemas.AIModelChoice) -> schemas.AIModels:
    request.state.entity = "settings"
    request.state.entity_id = SETTING_KEY
    config: Settings = request.app.state.config
    db: AsyncSession = request.state.db
    model = next((m for m in catalog()["models"] if m["id"] == body.model), None)
    if model is None:
        raise HTTPException(422, "Неизвестная модель.")
    reason, can_force = mode_check(
        model, body.mode, installed(config.llm_models_dir, model), hardware(config)
    )
    if reason is not None and not (body.force and can_force):
        raise HTTPException(409, reason)
    before = await active_choice(db)
    row = await db.get(Setting, SETTING_KEY)
    value = {"model": body.model, "mode": body.mode}
    if row is None:
        db.add(Setting(key=SETTING_KEY, value=value, updated_by=request.state.user.id))
    else:
        row.value, row.updated_by = value, request.state.user.id
    await db.flush()
    request.state.audit_before = before
    request.state.audit_after = value
    if config.ai_provider == "local":
        # Загрузка — заранее, чтобы первая проверка работы не ждала чтения весов.
        # Роутер с --models-max 1 сам выгрузит прежнюю модель.
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                await client.post(f"{router_url(config)}/models/load", json={"model": alias(value)})
        except httpx.HTTPError:
            pass
    return await view(request)


async def set_notice(request: Request, body: schemas.AIGpuNotice) -> schemas.AIModels:
    request.state.entity = "settings"
    request.state.entity_id = NOTICE_KEY
    db: AsyncSession = request.state.db
    row = await db.get(Setting, NOTICE_KEY)
    request.state.audit_before = row.value if row is not None else None
    value = {"dismissed": body.dismissed}
    if row is None:
        db.add(Setting(key=NOTICE_KEY, value=value, updated_by=request.state.user.id))
    else:
        row.value, row.updated_by = value, request.state.user.id
    await db.flush()
    request.state.audit_after = value
    return await view(request)
