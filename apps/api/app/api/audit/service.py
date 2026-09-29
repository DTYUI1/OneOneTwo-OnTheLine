"""C-07, ТЗ «Роль: Администратор системы»: просмотр журнала аудита и системных событий.

Журнал только дописывается (триггер immutable_journal) и хранится в БД бессрочно (FR-7.3).
Подробности «до/после» отдаются только для административных сущностей: учебные записи
(оценки, карточки, сценарии) администратору не раскрываются — только факт действия.
"""

from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import HTTPException, Request
from sqlalchemy import Select, and_, func, not_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.c01 import C01Input
from app.core.models import AuditLog, User, UserDeletion

ADMIN = {
    "createUser",
    "updateUser",
    "resetUserPassword",
    "trashUser",
    "restoreUser",
    "purgeUser",
    "requestBackup",
    "updateService",
    "updateSettings",
}
ACCESS = {"login", "logout"}
TECHNICAL = {"registerClockSample", "unknown"}
# Только здесь «до/после» — данные самого администрирования, без результатов обучаемых.
DETAIL_ENTITIES = {"users", "services", "settings", "backups"}


class AuditPageView(C01Input):
    contract_name = "AuditPage"


def category_of(action: str) -> str:
    if action in ADMIN:
        return "admin"
    if action in ACCESS:
        return "access"
    if action in TECHNICAL:
        return "technical"
    return "training"


def status_code(after: dict[str, Any] | None) -> int | None:
    value = (after or {}).get("status_code")
    return value if isinstance(value, int) else None


def category_filter(category: str) -> Any:
    known = ADMIN | ACCESS | TECHNICAL
    return {
        "admin": AuditLog.action.in_(ADMIN),
        "access": AuditLog.action.in_(ACCESS),
        "technical": AuditLog.action.in_(TECHNICAL),
        "training": AuditLog.action.not_in(known),
    }[category]


def result_filter(result: str) -> Any:
    failed = and_(
        AuditLog.after.has_key("status_code"),
        AuditLog.after["status_code"].as_integer() >= 400,
    )
    return failed if result == "error" else not_(failed)


def parse_cursor(cursor: str) -> tuple[datetime, UUID]:
    try:
        stamp, identifier = cursor.split("|", 1)
        return datetime.fromisoformat(stamp), UUID(identifier)
    except ValueError as exc:
        raise HTTPException(
            422, {"code": "bad_cursor", "message": "Неверная позиция журнала.", "details": {}}
        ) from exc


def payload(value: dict[str, Any] | None) -> dict[str, Any] | None:
    """Служебный код ответа — не содержимое изменения."""
    return None if value is None or set(value) == {"status_code"} else value


def entry(row: AuditLog, actor: User | None, purged: set[str] | None = None) -> dict[str, Any]:
    code = status_code(row.after)
    ok = code is None or code < 400
    # Журнал не переписывается (immutable_journal), но прежние ФИО и логин обезличенного
    # человека администратору больше не показываются.
    shown = row.entity in DETAIL_ENTITIES and ok and row.entity_id not in (purged or set())
    before, after = payload(row.before), payload(row.after)
    return {
        "id": str(row.id),
        "ts": row.ts.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "actor": None
        if actor is None
        else {
            "id": str(actor.id),
            "login": actor.login,
            "full_name": actor.full_name,
            "role": actor.role,
        },
        "action": row.action,
        "category": category_of(row.action),
        "entity": row.entity,
        "entity_id": row.entity_id,
        "ok": ok,
        "status_code": code,
        "before": before if shown else None,
        "after": after if shown else None,
        # Учебное содержимое было записано, но администратору не показывается.
        "details_hidden": not shown and (before is not None or after is not None),
        "ip": row.ip,
    }


async def list_audit(
    request: Request,
    limit: int,
    cursor: str | None,
    category: str,
    result: str,
    actor_id: UUID | None,
    since: datetime | None,
    until: datetime | None,
) -> AuditPageView:
    db: AsyncSession = request.state.db
    conditions: list[Any] = []
    if category != "all":
        conditions.append(category_filter(category))
    if result != "all":
        conditions.append(result_filter(result))
    if actor_id is not None:
        conditions.append(AuditLog.actor_id == actor_id)
    if since is not None:
        conditions.append(AuditLog.ts >= since)
    if until is not None:
        conditions.append(AuditLog.ts < until)
    total = await db.scalar(select(func.count()).select_from(AuditLog).where(*conditions))
    query: Select[tuple[AuditLog, User]] = (
        select(AuditLog, User)
        .outerjoin(User, User.id == AuditLog.actor_id)
        .where(*conditions)
        .order_by(AuditLog.ts.desc(), AuditLog.id.desc())
        .limit(limit + 1)
    )
    if cursor is not None:
        stamp, identifier = parse_cursor(cursor)
        # Строго после последней показанной записи в порядке (ts, id) по убыванию.
        query = query.where(
            or_(AuditLog.ts < stamp, and_(AuditLog.ts == stamp, AuditLog.id < identifier))
        )
    rows = (await db.execute(query)).all()
    page = rows[:limit]
    targets = {row.entity_id for row, _ in page if row.entity == "users" and row.entity_id}
    purged = (
        {
            str(user_id)
            for user_id in await db.scalars(
                select(UserDeletion.user_id).where(
                    UserDeletion.user_id.in_([UUID(value) for value in targets]),
                    UserDeletion.purged_at.is_not(None),
                )
            )
        }
        if targets
        else set()
    )
    oldest = await db.scalar(select(func.min(AuditLog.ts)))
    last = page[-1][0] if page and len(rows) > limit else None
    return AuditPageView(
        {
            "items": [entry(row, actor, purged) for row, actor in page],
            "next_cursor": f"{last.ts.isoformat()}|{last.id}" if last is not None else None,
            "total": int(total or 0),
            "oldest_ts": oldest.isoformat(timespec="milliseconds").replace("+00:00", "Z")
            if oldest is not None
            else None,
        }
    )
