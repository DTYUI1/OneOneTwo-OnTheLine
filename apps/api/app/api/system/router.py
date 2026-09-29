from collections.abc import Callable
from typing import Any

from fastapi import Request

from app.api.foundation import schemas
from app.api.system import backups, service


async def admin_status(request: Request) -> service.SystemStatusView:
    return await service.system_status(request)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "adminStatus": (admin_status, service.SystemStatusView),
}


async def list_backups(request: Request) -> list[schemas.BackupRun]:
    return await backups.list_backups(request)


async def request_backup(request: Request) -> schemas.BackupRun:
    return await backups.request_backup(request)


# Формы копий экспортируются из Pydantic, а не закрепляются JSON Schema, как SystemStatus.
BACKUP_ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "listBackups": (list_backups, list[schemas.BackupRun]),
    "requestBackup": (request_backup, schemas.BackupRun),
}
