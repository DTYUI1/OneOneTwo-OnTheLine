import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast
from uuid import UUID, uuid4, uuid5

from evalcore.defaults import (  # type: ignore[import-untyped]
    CARD_REASON_REQUIRED,
    CARD_TERMINAL_STATES,
    CARD_TRANSITIONS,
)
from fastapi import HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.cards import repo, schemas
from app.api.clock import service as clock_service
from app.api.evaluations.service import evaluate_terminal_card, refresh_terminal_rules
from app.api.notifications import notify
from app.api.sessions import memory_check
from app.api.training import briefing, caller, control, scenario_events
from app.api.training import events as training_events
from app.api.training.contacts import card_phone
from app.api.training.holds import HOLD_LIMIT
from app.api.training.status_evidence import require_report_before_status
from app.core.models import (
    Assignment,
    Call,
    Card,
    CardEvent,
    CardEventReceipt,
    Service,
)
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
    events = [serialize_event(row) for row in await repo.events(request.state.db, card_id)]
    # Проверка памяти (HQ-033): верные ответы обучаемому — только после его ответа.
    return memory_check.sealed(events) if request.state.user.role == "trainee" else events


async def contact_service(request: Request, card: Card) -> str | None:
    """ДДС участника карточки: абоненты телефона ДДС (GP-09) записываются на свою службу."""
    return (await card_phone(request.state.db, card)).service_id


async def contact_numbers(request: Request, card: Card) -> set[str]:
    """Номера абонентов телефона ДДС на занятии карточки: список преподавателя или по умолчанию."""
    return (await card_phone(request.state.db, card)).numbers()


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
        service_id = service.id if service is not None else await contact_service(request, card)
        if service_id is None or (
            service is None and payload["phone_ext"] not in await contact_numbers(request, card)
        ):
            raise HTTPException(422, "Набран неизвестный или неактивный номер.")
        row = Call(
            id=call_id,
            card_id=card.id,
            dialed_ext=payload["phone_ext"],
            service_id=service_id,
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
        if row.ended_at is not None:
            raise call_ended()
        if row.answered_at is not None:
            raise HTTPException(409, "Звонок уже принят или завершён.")
        row.answered_at = now
    else:
        if row.ended_at is not None:
            raise call_ended()
        row.ended_at = now
    await request.state.db.flush()
    await notify(request.state.db, "call.state", row.id)


async def hold_call(db: AsyncSession, card: Card, kind: str, call_id: UUID) -> None:
    """Удержание звонка (HQ-033, `call_hold` / `call_resume`): только идущий звонок карточки.

    Звонок на сервере не кончается и `call.state` не меняется — собеседник ждёт на линии.
    Удержан ли звонок сейчас — по последнему событию удержания этого звонка в журнале.
    """
    call = await db.get(Call, call_id)
    if call is None or call.card_id != card.id:
        raise HTTPException(404, "Звонок не найден.")
    if call.ended_at is not None:
        raise call_ended()
    if call.answered_at is None:
        raise hold_state("Удержать можно только идущий разговор.")
    marks = await db.execute(
        select(CardEvent.type, CardEvent.payload, CardEvent.server_ts)
        .where(CardEvent.card_id == card.id, CardEvent.type.in_(("call_hold", "call_resume")))
        .order_by(CardEvent.server_ts, CardEvent.id)
    )
    held_since = None
    for event_type, payload, at in marks:
        if UUID(payload["call_id"]) == call_id:
            held_since = at if event_type == "call_hold" else None
    # HTTP может опередить запоздавший тик. Не снимаем истёкшее удержание: worker
    # должен увидеть исходную метку и завершить звонок ровно на границе срока.
    if held_since is not None and datetime.now(UTC) >= held_since + HOLD_LIMIT:
        raise call_ended()
    if kind == "call_hold" and held_since is not None:
        raise hold_state("Звонок уже на удержании.")
    if kind == "call_resume" and held_since is None:
        raise hold_state("Звонок не на удержании.")


def hold_state(message: str) -> HTTPException:
    """Удержание не сходится с журналом (повтор после обновления страницы, гонка с отбоем).
    Стабильный код: отметка удержания только для разбора, очередь событий карточку из-за
    неё не останавливает (`shared/ws/outbox.ts`)."""
    return HTTPException(409, {"code": "hold_state", "message": message, "details": {}})


def call_ended() -> HTTPException:
    """Звонок уже кончился на сервере: вызов бригады пропущен (TC-02) или погашен, а клиент
    ответил или положил трубку одновременно с этим. Стабильный код: очередь событий не
    останавливает карточку из-за такой гонки (`shared/ws/outbox.ts`)."""
    return HTTPException(
        409, {"code": "call_ended", "message": "Звонок уже завершён.", "details": {}}
    )


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
    elif kind == "brigade_reply":
        if card.state in TERMINAL_STATES:
            raise HTTPException(409, "Для закрытой карточки разговор с бригадой недоступен.")
        await scenario_events.record_reply(request.state.db, card, payload)
    elif kind == "brigade_briefing":
        if card.state in TERMINAL_STATES:
            raise HTTPException(409, "Для закрытой карточки разговор с бригадой недоступен.")
        await briefing.record_briefing(request.state.db, card, payload, now)
    elif kind == "brigade_said":
        if card.state in TERMINAL_STATES:
            raise HTTPException(409, "Для закрытой карточки разговор с бригадой недоступен.")
        # Запись — сама строка card_events: журнал и разбор читают её оттуда.
        await briefing.said_call(request.state.db, card, UUID(payload["call_id"]))
    elif kind == "report_confirmed":
        if card.state in TERMINAL_STATES:
            raise HTTPException(409, "Для закрытой карточки разговор с бригадой недоступен.")
        # «Принял» на «Как приняли?» (TC-01): запись — сама строка card_events.
        await briefing.confirm_report(request.state.db, card, payload)
    elif kind == "control_reply":
        # Пояснение отделу контроля (TC-07): запись — сама строка card_events. Отдел контроля
        # мог позвонить, пока карточка была без статуса, а ответ прийти уже после закрытия.
        await control.control_reply_call(request.state.db, card, payload)
    elif kind == "caller_said":
        # Реплика живого заявителя (HQ-019): запись — сама строка card_events.
        await caller.record_caller_line(request.state.db, card, payload)
    elif kind in {"call_hold", "call_resume"}:
        # Удержание (HQ-033): запись — сама строка card_events. Закрытие карточки не мешает:
        # разговор с отделом контроля или службой мог продолжиться после статуса.
        await hold_call(request.state.db, card, kind, UUID(payload["call_id"]))
    elif kind.startswith("call_"):
        # Закрытие карточки не мешает закончить уже начатый разговор, в том числе
        # автоматическим отбоем с удержания. Принадлежность звонка проверит apply_call.
        if card.state in TERMINAL_STATES and not (
            kind == "call_hangup"
            or (
                kind != "call_dial"
                and await control.is_control_call(request.state.db, UUID(payload["call_id"]))
            )
        ):
            raise HTTPException(409, "Для закрытой карточки звонки недоступны.")
        await apply_call(request, card, kind, payload, now)
    # hint_open не меняет проекцию карточки.


async def repeated_action(
    request: Request, row: Any, kind: str, payload: dict[str, Any]
) -> CardEvent | None:
    """Двойной щелчок по «Подтвердить» (TC-08): то же действие новым client_event_id.

    Статус или перенаправление, после которых карточка уже в этом состоянии, повторить нельзя
    по смыслу — переход в то же состояние никогда не допустим. Если последнее такое действие
    этого автора на этой карточке с тем же телом — это повтор, а не новая команда: возвращаем
    его запись. Другое тело (иной комментарий) повтором не считается и получает прежний 409.
    """
    card: Card = row["Card"]
    if row["session_status"] != "running":
        return None
    if kind == "status_change":
        if payload["state"] != card.state:
            return None
    elif kind == "redirect":
        if card.state != "redirected" or str(payload["service_id"]) != str(
            card.redirected_to_service_id
        ):
            return None
    else:
        return None
    last = await request.state.db.scalar(
        select(CardEvent)
        .where(
            CardEvent.card_id == card.id,
            CardEvent.actor_id == request.state.user.id,
            CardEvent.type == kind,
        )
        .order_by(CardEvent.server_ts.desc(), CardEvent.id)
        .limit(1)
    )
    if last is None or last.payload != payload:
        return None
    return last


def keep_denied_status(
    request: Request, card_id: UUID, event: dict[str, Any], exc: HTTPException, now: datetime
) -> None:
    """Статус без доклада (409 report_required) — в журнал карточки, хотя действие отклонено.

    Эталон, раздел 7: такую попытку разбор называет в «Последовательности статусов» (GP-26).
    Отказ откатывает транзакцию запроса, поэтому запись делает transaction_middleware уже
    после отката (`request.state.keep_on_error`). Повтор того же события вторую запись не
    создаёт: её client_event_id выводится из client_event_id отклонённого действия.
    """
    detail: dict[str, Any] = exc.detail if isinstance(exc.detail, dict) else {}
    if event["type"] != "status_change" or detail.get("code") != "report_required":
        return
    denied_id = UUID(event["client_event_id"])
    values = {
        "card_id": card_id,
        "actor_id": request.state.user.id,
        "client_event_id": uuid5(denied_id, "status_denied"),
        "client_ts": datetime.fromisoformat(event["client_ts"].replace("Z", "+00:00")),
        "server_ts": now,
        "clock_offset_ms": request.app.state.realtime.offset_for(request.state.user.id),
        "type": "status_denied",
        "payload": {
            "state": event["payload"]["state"],
            "code": "report_required",
            "message": str(detail.get("message", "")),
            "denied_event_id": str(denied_id),
        },
    }

    async def write(db: AsyncSession) -> None:
        await db.execute(
            insert(CardEvent)
            .values(id=uuid4(), **values)
            .on_conflict_do_nothing(index_elements=["actor_id", "client_event_id"])
        )
        await notify(db, "card.updated", card_id)

    request.state.keep_on_error = [*getattr(request.state, "keep_on_error", []), write]


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
    repeat = await repeated_action(request, row, body.root["type"], body.root["payload"])
    if repeat is not None:
        # Новую запись не создаём: «двойной щелчок — одно событие». Ключ новой попытки не
        # хранится — её повтор снова распознается так же.
        return schemas.EventReceipt(
            client_event_id=event_id,
            server_ts=repeat.server_ts,
            duplicate=True,
            card=serialize_card(row),
        )
    sample_id = None
    if body.root.get("clock_sample_id"):
        sample = await clock_service.confirmed(
            request.state.db, request.state.user.id, UUID(body.root["clock_sample_id"])
        )
        sample_id = sample.id
    now = datetime.now(UTC)
    try:
        await mutate_card(request, row, body.root["type"], body.root["payload"], now)
    except HTTPException as exc:
        keep_denied_status(request, card_id, body.root, exc, now)
        raise
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
    # После статуса бригада, ждавшая решения, докладывает без ожидания тика worker; на ответ
    # вариантом (DT-10) отвечает в том же разговоре, после вводной (GP-05) — докладывает о
    # выезде; на «скорую уже вызвал» после своей просьбы (GP-28) — «понял, ждём».
    if event.type in {
        "call_answer",
        "status_change",
        "brigade_reply",
        "brigade_briefing",
        "brigade_said",
    }:
        from app.api.training.scenario_events import fire_due_events
        from app.worker.training import deliver_messages

        # Сначала события, которым пора, — как в тике worker: иначе доклад, который ждал
        # исхода вопроса, уходит раньше реплики события, сработавшего на том же ответе
        # (ночной прогон 17.10: «в квартире дым» звучало после доклада о работах).
        await fire_due_events(request.state.db, row["Card"], now)
        await deliver_messages(request.state.db, row["Card"], now)
    if row["Card"].state in TERMINAL_STATES and body.root["type"] in {
        "status_change",
        "redirect",
    }:
        await evaluate_terminal_card(request.state.db, card_id)
    elif row["Card"].state in TERMINAL_STATES and event.type in {"call_hangup", "call_hold"}:
        # Снимок удержания меняет доклад и без отбоя: worker мог уже завершить оценку.
        await refresh_terminal_rules(request.state.db, card_id)
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
