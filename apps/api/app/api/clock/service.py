"""C-02: проверяемая синхронизация часов ws_midpoint_v2 (contracts/I-TIME.md).

Сервер сохраняет момент получения `clock.ping.v2` и отвечает pong с тем же server_ts.
Клиент подтверждает образец POST /clock/samples; сервер проверяет принадлежность, совпадение
с сохранённым pong и формулу midpoint. Только подтверждённый образец можно указать в событии.
"""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from fastapi import HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.c01 import C01Input
from app.core.models import ClockSample

# Допуск формулы midpoint и точность хранения — 1 мс, как в расчёте I-TIME.
FORMULA_TOLERANCE_MS = 1.0


class ClockSampleInput(C01Input):
    contract_name = "ClockSample"


class ClockSampleReceipt(C01Input):
    contract_name = "ClockSampleReceipt"


def parse(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def millis(value: datetime) -> datetime:
    """Точность миллисекунд: браузер (Date.parse) не видит микросекунд."""
    return value.replace(microsecond=value.microsecond // 1000 * 1000)


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


async def record_ping(
    db: AsyncSession, actor_id: UUID, sample_id: UUID, client_ts: datetime
) -> datetime | None:
    """Сохранить pong; повтор того же ping — прежний server_at, чужой/другой — None."""
    await db.execute(
        select(func.pg_advisory_xact_lock(func.hashtextextended(f"clock:{sample_id}", 0)))
    )
    existing = await db.get(ClockSample, sample_id)
    if existing is not None:
        same = existing.actor_id == actor_id and existing.client_sent_at == millis(client_ts)
        return existing.server_at if same else None
    server_at = millis(datetime.now(UTC))
    db.add(
        ClockSample(
            id=sample_id,
            actor_id=actor_id,
            client_sent_at=millis(client_ts),
            server_at=server_at,
            client_received_at=None,
            offset_ms=None,
            confirmed_at=None,
        )
    )
    return server_at


def receipt(sample_id: UUID, accepted: bool, reason: str | None) -> ClockSampleReceipt:
    return ClockSampleReceipt({"sample_id": str(sample_id), "accepted": accepted, "reason": reason})


async def register_sample(request: Request, body: ClockSampleInput) -> ClockSampleReceipt:
    value: dict[str, Any] = body.root
    sample_id = UUID(value["sample_id"])
    request.state.entity, request.state.entity_id = "clock_sample", str(sample_id)
    db: AsyncSession = request.state.db
    row = await db.get(ClockSample, sample_id, with_for_update=True)
    if row is None or row.actor_id != request.state.user.id:
        raise HTTPException(404, "Образец часов не найден.")
    if value["method"] != "ws_midpoint_v2" or value["client_received_at"] is None:
        return receipt(sample_id, False, "Нужен образец ws_midpoint_v2 с временем получения.")
    if value["offset_ms"] is None:
        return receipt(sample_id, False, "Нет поправки часов.")
    sent, server_at = parse(value["client_sent_at"]), parse(value["server_at"])
    received = parse(value["client_received_at"])
    if sent != row.client_sent_at or server_at != row.server_at:
        raise HTTPException(409, "Образец не совпадает с ответом сервера.")
    offset = float(value["offset_ms"])
    if row.confirmed_at is not None:
        if row.client_received_at == received and row.offset_ms == offset:
            return receipt(sample_id, True, None)
        raise HTTPException(409, "Образец уже подтверждён с другими данными.")
    if received < sent:
        return receipt(sample_id, False, "Время получения раньше отправки.")
    midpoint = sent + (received - sent) / 2
    expected = (server_at - midpoint).total_seconds() * 1000
    if abs(expected - offset) > FORMULA_TOLERANCE_MS:
        return receipt(sample_id, False, "Поправка не соответствует формуле midpoint.")
    row.client_received_at, row.offset_ms = received, offset
    row.confirmed_at = datetime.now(UTC)
    request.state.audit_after = {"sample_id": str(sample_id), "offset_ms": offset}
    return receipt(sample_id, True, None)


async def confirmed(db: AsyncSession, actor_id: UUID, sample_id: UUID) -> ClockSample:
    """Подтверждённый образец текущего пользователя для ссылки из события."""
    row = await db.get(ClockSample, sample_id)
    if row is None or row.actor_id != actor_id or row.confirmed_at is None:
        raise HTTPException(
            422,
            {
                "code": "clock_sample_unknown",
                "message": "Образец часов не найден или не подтверждён.",
                "details": {},
            },
        )
    return row


def as_contract(row: ClockSample) -> dict[str, Any]:
    return {
        "sample_id": str(row.id),
        "method": "ws_midpoint_v2",
        "client_sent_at": iso(row.client_sent_at),
        "server_at": iso(row.server_at),
        "client_received_at": iso(row.client_received_at) if row.client_received_at else None,
        "offset_ms": row.offset_ms,
    }
