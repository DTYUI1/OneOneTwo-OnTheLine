import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast
from uuid import UUID

from evalcore.defaults import (  # type: ignore[import-untyped]
    CARD_REASON_REQUIRED,
    CARD_TERMINAL_STATES,
    CARD_TRANSITIONS,
)
from fastapi import HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select

from app.api.cards import repo, schemas
from app.api.clock import service as clock_service
from app.api.evaluations.service import evaluate_terminal_card
from app.api.notifications import notify
from app.api.training import events as training_events
from app.api.training.status_evidence import require_report_before_status
from app.core.models import Assignment, Call, Card, CardEvent, CardEventReceipt, Service
from app.worker.queue import enqueue_job

TERMINAL_STATES = CARD_TERMINAL_STATES
TRANSITIONS = CARD_TRANSITIONS
CONTENT_EXTENSIONS = {
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "application/ogg": ".ogg",
}
MAX_AUDIO_BYTES = 10 * 1024 * 1024


def serialize_card(row: Any) -> schemas.Card:
    card = row["Card"]
    return schemas.Card(
        id=card.id,
        assignment_id=card.assignment_id,
        trainee_id=row["trainee_id"],
        session_id=row["session_id"],
        state=card.state,
        appeared_at=card.appeared_at,
        delivered_at=card.delivered_at,
        opened_at=card.opened_at,
        closed_at=card.closed_at,
        interrupted_at=card.interrupted_at,
        source=row["source"],
        current=card.current,
    )


def serialize_event(row: CardEvent) -> schemas.StoredEvent:
    return schemas.StoredEvent.model_validate(row)


def call_state(row: Call) -> str:
    if row.ended_at is not None:
        return "ended"
    if row.answered_at is not None:
        return "talking"
    # Входящий от бригады звонит у диспетчера, исходящий — набирается.
    return "ringing" if row.direction == "inbound" else "dialing"


def serialize_call(row: Call) -> schemas.Call:
    if row.service_id is None:
        raise RuntimeError("Звонок не связан со службой.")
    return schemas.Call(
        id=row.id,
        card_id=row.card_id,
        phone_ext=row.dialed_ext,
        service_id=row.service_id,
        state=cast(Any, call_state(row)),
        audio_url=f"/api/calls/{row.id}/audio" if row.audio_path else None,
        transcript=row.transcript,
        direction=cast(Any, row.direction),
    )


async def list_cards(request: Request) -> list[schemas.Card]:
    return [
        serialize_card(row)
        for row in await repo.cards(
            request.state.db, request.state.user.id, request.state.user.role
        )
    ]


async def get_card_row(request: Request, card_id: UUID, *, lock: bool = False):
    row = await repo.card(
        request.state.db,
        card_id,
        request.state.user.id,
        request.state.user.role,
        lock=lock,
    )
    if row is None:
        raise HTTPException(404, "Карточка не найдена.")
    return row


async def get_card(request: Request, card_id: UUID) -> schemas.Card:
    return serialize_card(await get_card_row(request, card_id))


async def list_events(request: Request, card_id: UUID) -> list[schemas.StoredEvent]:
    await get_card_row(request, card_id)
    return [serialize_event(row) for row in await repo.events(request.state.db, card_id)]


async def apply_call(
    request: Request, card: Card, kind: str, payload: dict[str, Any], now: datetime
) -> None:
    call_id = UUID(payload["call_id"])
    if kind == "call_dial":
        await request.state.db.execute(
            select(func.pg_advisory_xact_lock(func.hashtextextended(f"call:{call_id}", 0)))
        )
    row = await request.state.db.get(Call, call_id, with_for_update=True)
    if kind == "call_dial":
        if row is not None:
            raise HTTPException(409, "Идентификатор звонка уже использован.")
        service = await request.state.db.scalar(
            select(Service).where(
                Service.phone_ext == payload["phone_ext"], Service.is_active.is_(True)
            )
        )
        if service is None:
            raise HTTPException(422, "Набран неизвестный или неактивный номер.")
        row = Call(
            id=call_id,
            card_id=card.id,
            dialed_ext=payload["phone_ext"],
            service_id=service.id,
            started_at=now,
            answered_at=None,
            ended_at=None,
            audio_path=None,
            transcript=None,
        )
        request.state.db.add(row)
    elif row is None or row.card_id != card.id:
        raise HTTPException(404, "Звонок не найден.")
    elif kind == "call_answer":
        if row.answered_at is not None or row.ended_at is not None:
            raise HTTPException(409, "Звонок уже принят или завершён.")
        row.answered_at = now
    else:
        if row.ended_at is not None:
            raise HTTPException(409, "Звонок уже завершён.")
        row.ended_at = now
    await request.state.db.flush()
    await notify(request.state.db, "call.state", row.id)


def require_reason(target: str, comment: str) -> None:
    """Отказ без причины не принимается: схема допускает пробелы, памятка — нет."""
    if (target in CARD_REASON_REQUIRED or target == "redirected") and not comment.strip():
        raise HTTPException(
            422,
            {
                "code": "reason_required",
                "message": "Укажите в комментарии причину отказа и кому передана информация.",
                "details": {"state": target},
            },
        )


async def mutate_card(
    request: Request, row: Any, kind: str, payload: dict[str, Any], now: datetime
) -> None:
    card: Card = row["Card"]
    if row["session_status"] == "finished":
        raise HTTPException(
            409,
            {
                "code": "session_finished",
                "message": "Занятие завершено. Действие не принято.",
                "details": {},
            },
        )
    if row["session_status"] != "running":
        raise HTTPException(409, "Действия доступны только во время занятия.")
    if kind == "deliver":
        if card.state != "added" or card.delivered_at is not None:
            # Стабильный код: клиент после reload может повторить deliver новым ID (гонка
            # с ещё не прочитанным snapshot) и должен понять, что доставка уже учтена.
            raise HTTPException(
                409,
                {
                    "code": "card_already_delivered",
                    "message": "Карточка уже доставлена.",
                    "details": {},
                },
            )
        card.delivered_at, card.state = now, "received"
        assignment = await request.state.db.get(Assignment, card.assignment_id)
        if assignment is not None:
            assignment.status = "delivered"
    elif kind == "open":
        if card.state == "added":
            raise HTTPException(409, "Сначала подтвердите доставку карточки.")
        card.opened_at = card.opened_at or now
    elif kind == "field_change":
        if card.state in TERMINAL_STATES:
            raise HTTPException(409, "Закрытую карточку нельзя изменить.")
        card.current = {**card.current, payload["field"]: payload["value"]}
    elif kind == "comment":
        if card.state in TERMINAL_STATES:
            raise HTTPException(409, "Закрытую карточку нельзя изменить.")
        card.current = {**card.current, "comment": payload["comment"]}
    elif kind == "status_change":
        target = payload["state"]
        if target not in TRANSITIONS.get(card.state, set()):
            raise HTTPException(409, f"Недопустимый переход {card.state} → {target}.")
        await require_report_before_status(request.state.db, card, target)
        require_reason(target, payload["comment"])
        card.state = target
        card.current = {**card.current, "comment": payload["comment"]}
        card.first_status_at = card.first_status_at or now
        if target in TERMINAL_STATES:
            card.closed_at = now
            assignment = await request.state.db.get(Assignment, card.assignment_id)
            if assignment is not None:
                assignment.status = "completed"
    elif kind == "redirect":
        if card.state != "rejected":
            raise HTTPException(409, "Перенаправить можно только непринятую карточку.")
        require_reason("redirected", payload["comment"])
        service = await request.state.db.scalar(
            select(Service).where(Service.id == payload["service_id"], Service.is_active.is_(True))
        )
        if service is None:
            raise HTTPException(422, "Неизвестная или неактивная служба.")
        card.state, card.redirected_to_service_id, card.closed_at = "redirected", service.id, now
        card.current = {**card.current, "comment": payload["comment"]}
        assignment = await request.state.db.get(Assignment, card.assignment_id)
        if assignment is not None:
            assignment.status = "completed"
    elif kind in {"brigades_select", "call_dial_target"}:
        if card.state in TERMINAL_STATES:
            raise HTTPException(409, "Для закрытой карточки выбор бригад и звонки недоступны.")
        if kind == "brigades_select":
            await training_events.select_brigades(request, card, payload)
        else:
            await training_events.dial_target(request, card, payload, now)
    elif kind.startswith("call_"):
        if card.state in TERMINAL_STATES:
            raise HTTPException(409, "Для закрытой карточки звонки недоступны.")
        await apply_call(request, card, kind, payload, now)
    # hint_open не меняет проекцию карточки.


async def post_event(
    request: Request, card_id: UUID, body: schemas.CardEvent
) -> schemas.EventReceipt:
    request.state.entity = "card_event"
    request.state.entity_id = str(body.root["client_event_id"])
    event_id = UUID(body.root["client_event_id"])
    # Retry одного события сериализуется даже при одновременных HTTP-запросах.
    await request.state.db.execute(
        select(
            func.pg_advisory_xact_lock(
                func.hashtextextended(f"{request.state.user.id}:{event_id}", 0)
            )
        )
    )
    existing = await request.state.db.scalar(
        select(CardEvent).where(
            CardEvent.actor_id == request.state.user.id,
            CardEvent.client_event_id == event_id,
        )
    )
    if existing is not None:
        sample = body.root.get("clock_sample_id")
        same = (
            existing.card_id == card_id
            and existing.client_ts
            == datetime.fromisoformat(body.root["client_ts"].replace("Z", "+00:00"))
            and existing.type == body.root["type"]
            and existing.payload == body.root["payload"]
            and existing.clock_sample_id == (UUID(sample) if sample else None)
        )
        if not same:
            raise HTTPException(409, "client_event_id уже использован для другого действия.")
        row = await get_card_row(request, card_id)
        saved = await request.state.db.get(CardEventReceipt, existing.id)
        if saved is not None:
            return schemas.EventReceipt.model_validate({**saved.receipt, "duplicate": True})
        return schemas.EventReceipt(
            client_event_id=event_id,
            server_ts=existing.server_ts,
            duplicate=True,
            card=serialize_card(row),
        )
    row = await get_card_row(request, card_id, lock=True)
    sample_id = None
    if body.root.get("clock_sample_id"):
        sample = await clock_service.confirmed(
            request.state.db, request.state.user.id, UUID(body.root["clock_sample_id"])
        )
        sample_id = sample.id
    now = datetime.now(UTC)
    await mutate_card(request, row, body.root["type"], body.root["payload"], now)
    event = CardEvent(
        card_id=card_id,
        actor_id=request.state.user.id,
        client_event_id=event_id,
        client_ts=datetime.fromisoformat(body.root["client_ts"].replace("Z", "+00:00")),
        server_ts=now,
        clock_offset_ms=request.app.state.realtime.offset_for(request.state.user.id),
        type=body.root["type"],
        payload=body.root["payload"],
        clock_sample_id=sample_id,
    )
    request.state.db.add(event)
    await request.state.db.flush()
    await request.state.db.refresh(event, attribute_names=["server_ts"])
    if event.type in {"message_presented", "message_failed"}:
        await training_events.record_presentation(request, row["Card"], event)
    # После статуса бригада, ждавшая решения, докладывает без ожидания тика worker.
    if event.type in {"call_answer", "status_change"}:
        from app.worker.training import deliver_messages

        await deliver_messages(request.state.db, row["Card"], now)
    if row["Card"].state in TERMINAL_STATES and body.root["type"] in {
        "status_change",
        "redirect",
    }:
        await evaluate_terminal_card(request.state.db, card_id)
    await notify(request.state.db, "card.updated", card_id)
    result_card = serialize_card(row)
    request.state.audit_after = {
        "card_id": str(card_id),
        "client_event_id": str(event_id),
        "type": body.root["type"],
    }
    receipt = schemas.EventReceipt(
        client_event_id=event_id,
        server_ts=event.server_ts,
        duplicate=False,
        card=result_card,
    )
    request.state.db.add(
        CardEventReceipt(
            event_id=event.id,
            receipt=receipt.model_dump(mode="json"),
        )
    )
    return receipt


async def list_calls(request: Request, card_id: UUID) -> list[schemas.Call]:
    await get_card_row(request, card_id)
    return [serialize_call(row) for row in await repo.calls(request.state.db, card_id)]


async def get_call_row(request: Request, call_id: UUID) -> Call:
    call = await request.state.db.get(Call, call_id)
    if call is None:
        raise HTTPException(404, "Звонок не найден.")
    try:
        await get_card_row(request, call.card_id)
    except HTTPException as exc:
        raise HTTPException(404, "Звонок не найден.") from exc
    return call


async def get_call(request: Request, call_id: UUID) -> schemas.Call:
    return serialize_call(await get_call_row(request, call_id))


async def upload_audio(request: Request, call_id: UUID, audio: UploadFile) -> schemas.Call:
    request.state.entity = "call_audio"
    request.state.entity_id = str(call_id)
    row = await get_call_row(request, call_id)
    if row.ended_at is None:
        raise HTTPException(409, "Запись можно загрузить после завершения звонка.")
    # MediaRecorder присылает параметры вида "audio/webm;codecs=opus" — сверяем только media type.
    media_type = (audio.content_type or "").split(";", 1)[0].strip().lower()
    extension = CONTENT_EXTENSIONS.get(media_type)
    if extension is None:
        raise HTTPException(422, "Поддерживаются WAV, WebM и Ogg.")
    directory: Path = request.app.state.config.audio_dir
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / f"{call_id}{extension}"
    temporary = directory / f".{call_id}.upload"
    total = 0
    try:
        with temporary.open("wb") as stream:
            while chunk := await audio.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_AUDIO_BYTES:
                    raise HTTPException(413, "Аудиофайл превышает 10 МиБ.")
                stream.write(chunk)
        if total == 0:
            raise HTTPException(422, "Аудиофайл пуст.")
        os.replace(temporary, destination)
    finally:
        await audio.close()
        if temporary.exists():
            temporary.unlink()
    row.audio_path = str(destination)
    await request.state.db.flush()
    result = serialize_call(row)
    request.state.audit_after = {"call_id": str(call_id), "size": total}
    await notify(request.state.db, "call.state", row.id)
    if request.app.state.config.stt_provider != "off":
        await enqueue_job(
            request.state.db,
            kind="transcribe",
            payload={"call_id": str(call_id)},
            entity_id=call_id,
            version=1,
        )
    return result


async def download_audio(request: Request, call_id: UUID) -> FileResponse:
    row = await get_call_row(request, call_id)
    if row.audio_path is None:
        raise HTTPException(404, "Запись звонка не найдена.")
    path = Path(row.audio_path)
    if not path.is_file():
        raise HTTPException(404, "Запись звонка не найдена.")
    media_type = {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".webm": "audio/webm",
        ".ogg": "audio/ogg",
    }.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media_type)
