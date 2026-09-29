"""C-07, ТЗ «Роль: Администратор системы»: состояние компонентов, нагрузка, копии, оповещения.

Только чтение и только технические сведения: никаких команд на сервере из браузера (C-07)
и никаких результатов обучаемых. Оповещения собирает сервер — интерфейс показывает их
полосой на всех страницах администрирования.
"""

import os
import re
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import Request
from sqlalchemy import func, select, text
from sqlalchemy.exc import SQLAlchemyError

from app.api.c01 import C01Input
from app.api.foundation import repo
from app.core.config import Settings
from app.core.models import SCHEMA_REVISION, Job, Session, WorkerHeartbeat

BACKUP_NAME = re.compile(r"^backup-(\d{8}T\d{6}Z)$")
# Копия раз в сутки в 02:00 UTC; запас на долгую копию и перезапуск контейнера.
BACKUP_STALE = timedelta(hours=26)
DISK_WARNING = 0.10


class SystemStatusView(C01Input):
    contract_name = "SystemStatus"


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def backups(folder: Path, now: datetime) -> dict[str, Any]:
    """Копии — каталоги backup-<время>; каталог появляется целиком после проверки сумм."""
    try:
        names = [entry.name for entry in os.scandir(folder)]
    except OSError:
        return {"status": "unknown", "last_at": None, "count": 0, "in_progress": False}
    stamps = sorted(
        datetime.strptime(match.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
        for name in names
        if (match := BACKUP_NAME.match(name))
    )
    last = stamps[-1] if stamps else None
    status = "missing" if last is None else "stale" if now - last > BACKUP_STALE else "ok"
    return {
        "status": status,
        "last_at": iso(last),
        "count": len(stamps),
        "in_progress": ".backup.lock" in names,
    }


def disk(path: Path) -> dict[str, Any] | None:
    # Папки записей может ещё не быть (свежая установка): считаем диск ближайшей существующей.
    probe = path
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    try:
        usage = shutil.disk_usage(probe)
    except OSError:
        return None
    return {"total_bytes": usage.total, "free_bytes": usage.free}


def machine() -> dict[str, Any]:
    """Нагрузка сервера: средняя загрузка процессора и доступная память (Linux)."""
    cores = os.cpu_count() or 1
    # На Windows os.getloadavg нет: getattr — и для работы, и для mypy на любой платформе.
    getloadavg = getattr(os, "getloadavg", None)
    try:
        load = getloadavg()[0] if getloadavg is not None else None
    except OSError:
        load = None
    memory: dict[str, int] = {}
    try:
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            key, value = line.split(":", 1)
            if key in {"MemTotal", "MemAvailable"}:
                memory[key] = int(value.split()[0]) * 1024
    except (OSError, ValueError):
        memory = {}
    return {
        "cores": cores,
        "load_1m": round(load, 2) if load is not None else None,
        "memory_total_bytes": memory.get("MemTotal"),
        "memory_available_bytes": memory.get("MemAvailable"),
    }


def alerts(status: dict[str, Any]) -> list[dict[str, str]]:
    found: list[dict[str, str]] = []

    def add(level: str, message: str) -> None:
        found.append({"level": level, "message": message})

    if status["database"]["status"] != "ok":
        add("error", "База данных недоступна или схема не обновлена: занятия не работают.")
    if status["worker"]["status"] != "ok":
        add("error", "Фоновый обработчик не отвечает: карточки не выдаются, оценка не идёт.")
    if status["realtime"]["status"] != "ok":
        add("error", "Канал обновлений не работает: экраны не получают события без перезагрузки.")
    backup = status["backup"]
    if backup["status"] == "missing":
        add("warning", "Резервных копий нет. Проверьте контейнер резервного копирования.")
    elif backup["status"] == "stale":
        add(
            "warning",
            "Последней резервной копии больше суток. Проверьте контейнер резервного копирования.",
        )
    elif backup["status"] == "unknown":
        add("warning", "Папка резервных копий не подключена: состояние копий неизвестно.")
    space = status["disk"]
    if space is not None and space["free_bytes"] < space["total_bytes"] * DISK_WARNING:
        add("warning", "На диске сервера осталось меньше 10 % места.")
    if status["queue"]["failed"] > 0:
        add("warning", f"Заданий с ошибкой в очереди: {status['queue']['failed']}.")
    load = status["machine"]["load_1m"]
    if load is not None and load > status["machine"]["cores"] * 2:
        add("warning", "Сервер перегружен: загрузка процессора выше двойного числа ядер.")
    return found


async def system_status(request: Request) -> SystemStatusView:
    config: Settings = request.app.state.config
    hub = request.app.state.realtime
    now = datetime.now(UTC)
    database: dict[str, Any] = {"status": "error", "size_bytes": None}
    worker: dict[str, Any] = {"status": "error", "last_heartbeat_at": None}
    queue = {"pending": 0, "running": 0, "failed": 0}
    running_sessions = 0
    try:
        async with request.app.state.database.sessions() as db:
            revision = await db.scalar(text("SELECT version_num FROM alembic_version"))
            seeded = await repo.training_settings(db)
            database = {
                "status": "ok" if revision == SCHEMA_REVISION and seeded is not None else "error",
                "size_bytes": await db.scalar(text("SELECT pg_database_size(current_database())")),
            }
            heartbeat = await db.scalar(select(func.max(WorkerHeartbeat.updated_at)))
            fresh = heartbeat is not None and heartbeat >= now - timedelta(
                seconds=config.worker_lease_seconds * 2
            )
            worker = {"status": "ok" if fresh else "error", "last_heartbeat_at": iso(heartbeat)}
            for status_name, count in (
                await db.execute(select(Job.status, func.count()).group_by(Job.status))
            ).all():
                if status_name in queue:
                    queue[status_name] = int(count)
            running_sessions = int(
                await db.scalar(
                    select(func.count()).select_from(Session).where(Session.status == "running")
                )
                or 0
            )
    except (SQLAlchemyError, OSError, TimeoutError):
        pass
    clients = list(hub.clients.values())
    status: dict[str, Any] = {
        "checked_at": iso(now),
        "database": database,
        "worker": worker,
        "realtime": {
            "status": "ok" if hub.healthy else "error",
            "connections": len(clients),
            "users_online": len({client.user_id for client in clients}),
        },
        "queue": queue,
        "running_sessions": running_sessions,
        "machine": machine(),
        "disk": disk(config.audio_dir),
        "backup": backups(config.backup_status_dir, now),
    }
    status["alerts"] = alerts(status)
    return SystemStatusView(status)
