"""Ручной выбор адресата и append-only журнал результатов playback."""

from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import HTTPException, Request
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.notifications import notify
from app.api.training.brigades import brigade_roster, call_refusal
from app.api.training.service import bump_revision
from app.core.models import (
    Assignment,
    Brigade,
    Call,
    CallTarget,
    Card,
    CardBrigade,
    CardEvent,
    MessageDelivery,
    MessagePresentation,
    Participant,
    Service,
)

# Бригаду направляют после решения реагировать: «Принята» означает «реагирование будет
# осуществляться» (памятка ДДС, стр. 21). До решения и после «Не принята» — нельзя.
UNDECIDED_STATES = {"added", "received", "rejected"}


async def own_participant(db: AsyncSession, card: Card) -> Participant | None:
    """Участник занятия, которому назначена карточка: его ДДС распоряжается бригадами."""
    return await db.scalar(
        select(Participant)
        .join(Assignment, Assignment.participant_id == Participant.id)
        .where(Assignment.id == card.assignment_id)
    )


async def select_brigades(request: Request, card: Card, payload: dict[str, Any]) -> None:
    db = request.state.db
    if card.state in UNDECIDED_STATES:
        raise HTTPException(
            409,
            {
                "code": "decision_required",
                "message": "Сначала примите решение: поставьте статус «Принята».",
                "details": {"state": card.state},
            },
        )
    brigade_ids = [UUID(value) for value in payload["brigade_ids"]]
    participant = await own_participant(db, card)
    if participant is None:
        raise HTTPException(422, "Выберите активные бригады своей ДДС.")
    brigades = list(
        (
            await db.scalars(
                select(Brigade)
                .join(Service)
                .where(
                    Brigade.id.in_(brigade_ids),
                    Service.is_active.is_(True),
                    Brigade.is_active.is_(True),
                    Brigade.service_id == participant.dds_service_id,
                )
                .order_by(Brigade.id)
                .with_for_update(read=True)
            )
        ).all()
    )
    if len(brigades) != len(brigade_ids):
        raise HTTPException(422, "Выберите активные бригады своей ДДС.")
    # Уже направленные на эту карточку остаются; новые — только свободные из доступных.
    already = set(
        await db.scalars(select(CardBrigade.brigade_id).where(CardBrigade.card_id == card.id))
    )
    roster = await brigade_roster(db, card)
    added = [b for b in brigades if b.id not in already]
    if any(b.id not in roster.available for b in added):
        raise HTTPException(422, "Эта бригада сейчас недоступна диспетчеру.")
    busy = next((roster.busy[b.id] for b in added if b.id in roster.busy), None)
    if busy is not None:
        raise HTTPException(
            422, f"Бригада занята на происшествии {busy.card_number}: там не закончена работа."
        )
    await db.execute(delete(CardBrigade).where(CardBrigade.card_id == card.id))
    db.add_all([CardBrigade(card_id=card.id, brigade_id=b.id) for b in brigades])
    await bump_revision(db, card.id)


async def dial_target(request: Request, card: Card, payload: dict[str, Any], now: datetime) -> None:
    db = request.state.db
    target = await db.scalar(
        select(CallTarget)
        .join(Service)
        .where(
            CallTarget.id == UUID(payload["call_target_id"]),
            CallTarget.is_active.is_(True),
            Service.is_active.is_(True),
        )
        .with_for_update(read=True)
    )
    if target is None:
        raise HTTPException(422, "Адресат не найден или неактивен.")
    brigade_id = UUID(payload["brigade_id"]) if payload["brigade_id"] else None
    if target.brigade_id != brigade_id:
        raise HTTPException(422, "Адресат не соответствует выбранной бригаде.")
    refusal = None
    if brigade_id:
        brigade = await db.scalar(
            select(Brigade).where(Brigade.id == brigade_id).with_for_update(read=True)
        )
        participant = await own_participant(db, card)
        if (
            brigade is None
            or not brigade.is_active
            or brigade.service_id != target.service_id
            or participant is None
            or brigade.service_id != participant.dds_service_id
        ):
            raise HTTPException(422, "Звонить напрямую можно только бригадам своей ДДС.")
        # Номер не «разблокируется» выбором: ненаправленная бригада отвечает отказом.
        refusal = await call_refusal(db, card, brigade_id)
    call_id = UUID(payload["call_id"])
    # Один UUID звонка нельзя одновременно создать на двух карточках/занятиях.
    await db.execute(
        select(func.pg_advisory_xact_lock(func.hashtextextended(f"call:{call_id}", 0)))
    )
    if await db.get(Call, call_id) is not None:
        raise HTTPException(409, "Идентификатор звонка уже использован.")
    db.add(
        Call(
            id=call_id,
            card_id=card.id,
            dialed_ext=target.phone_ext,
            service_id=target.service_id,
            target_id=target.id,
            brigade_id=brigade_id,
            started_at=now,
            refusal=refusal,
        )
    )
    await db.flush()
    await notify(db, "call.state", call_id)


async def record_presentation(request: Request, card: Card, event: CardEvent) -> None:
    db = request.state.db
    payload = event.payload
    delivery = await db.get(MessageDelivery, UUID(payload["delivery_id"]))
    if delivery is None or delivery.card_id != card.id:
        raise HTTPException(404, "Выданное сообщение не найдено.")
    call = await db.get(Call, delivery.call_id)
    if call is None or call.card_id != card.id:
        raise HTTPException(404, "Звонок сообщения не найден.")
    audio = delivery.message["audio"]
    if payload["message_version"] != delivery.message_version:
        raise HTTPException(409, "Версия сообщения не соответствует выданной.")
    audio_version = payload["audio_version"]
    if audio_version is not None and (audio is None or audio_version != audio["version"]):
        raise HTTPException(409, "Версия аудио не соответствует выданной.")
    if event.type == "message_presented":
        if (payload["channel"] == "audio" and (audio is None or audio_version is None)) or (
            payload["channel"] == "text" and audio_version is not None
        ):
            raise HTTPException(409, "Канал предъявления не соответствует версии аудио.")
    playback_id = UUID(payload["playback_id"])
    await db.execute(
        select(
            func.pg_advisory_xact_lock(
                func.hashtextextended(f"playback:{event.actor_id}:{playback_id}", 0)
            )
        )
    )
    existing = await db.scalar(
        select(MessagePresentation).where(
            MessagePresentation.actor_id == event.actor_id,
            MessagePresentation.playback_id == playback_id,
        )
    )
    if existing is not None:
        if existing.kind != event.type or existing.payload != payload:
            raise HTTPException(409, "Попытка playback уже имеет другой результат.")
        return
    db.add(
        MessagePresentation(
            delivery_id=delivery.id,
            event_id=event.id,
            actor_id=event.actor_id,
            playback_id=playback_id,
            kind=event.type,
            recorded_at=event.server_ts,
            payload=payload,
        )
    )
    await bump_revision(db, card.id)
