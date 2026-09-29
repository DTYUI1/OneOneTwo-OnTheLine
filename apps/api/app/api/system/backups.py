"""C-07/C-08: резервная копия по кнопке администратора.

Браузер не выполняет команд на сервере: API только записывает запрос в таблицу backups,
контейнер backup раз в минуту забирает его (deploy/backup/backup-poll), делает копию тем же
backup-once, что и ночью, и отмечает результат. Ночные и консольные копии пишутся туда же.
"""

from datetime import timedelta

from fastapi import Request
from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.foundation import schemas
from app.api.foundation.users import conflict
from app.core.models import Backup

SHOWN = 20
# Копия, которая «идёт» дольше, считается прерванной: backup-poll отметит её ошибкой.
RUNNING_STALE = timedelta(hours=6)


async def list_backups(request: Request) -> list[schemas.BackupRun]:
    db: AsyncSession = request.state.db
    rows = await db.scalars(select(Backup).order_by(Backup.requested_at.desc()).limit(SHOWN))
    return [schemas.BackupRun.model_validate(row) for row in rows]


async def request_backup(request: Request) -> schemas.BackupRun:
    db: AsyncSession = request.state.db
    request.state.entity = "backups"
    # Два администратора одновременно не должны поставить две копии подряд.
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext('arm112.backup_request'))"))
    busy = await db.scalar(
        select(func.count())
        .select_from(Backup)
        .where(
            or_(
                Backup.status == "pending",
                (Backup.status == "running") & (Backup.started_at > func.now() - RUNNING_STALE),
            )
        )
    )
    if busy:
        raise conflict(
            "backup_in_progress", "Копия уже запрошена или идёт. Дождитесь её завершения."
        )
    row = Backup(status="pending", requested_by=request.state.user.id)
    db.add(row)
    await db.flush()
    await db.refresh(row)
    request.state.entity_id = str(row.id)
    request.state.audit_after = {"status": "pending"}
    return schemas.BackupRun.model_validate(row)
