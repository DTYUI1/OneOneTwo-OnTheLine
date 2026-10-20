"""Ответ бригаде голосом (DT-16): фраза диспетчера в разговоре → вариант ответа реплики.

Как доклад службе голосом (`voice_report`): фразу распознаёт локальный faster-whisper
(сервис stt, без интернета и GPU), сразу, в разговоре; аудио только во временном файле.
Текст сводится к одному из `reply_options` реплики бригады правилом evalcore
(`evalcore.voice_reply.voice_reply_option`: значимые слова подписи по начальной форме,
для поправки адреса — улица, её тип и дом без исправления опечаток).

Запрос ничего не сохраняет: сопоставленный вариант браузер отправляет тем же событием
`brigade_reply` (option_key) с `mode = voice` — мир отвечает на него так же, как на кнопку,
а разбор пишет «голосом». Не сопоставлено — `option_key = null`, бригада переспрашивает.

Ответ на просьбу о службе (GP-28, варианты `already` / `calling`) ещё сводится запасным
правилом `evalcore.service_told.service_reply_option`: «скорую уже вызвал» — «уже вызвал».

Без `delivery_id` (DT-19) — фраза бригаде вне вопроса: «выезжайте», «доложите обстановку».
Только распознавание и громкость; что ответит бригада, решает браузер.
"""

import logging
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast
from uuid import UUID

from evalcore.loudness import loudness_verdict
from evalcore.service_told import ALREADY_OPTION, CALLING_OPTION, service_reply_option
from evalcore.voice_reply import reply_hints, voice_reply_option
from fastapi import HTTPException, Request, UploadFile
from sqlalchemy import select

from app.api.cards.service import get_call_row
from app.api.training.scenario_events import (
    card_events_plan,
    content_id,
    phrase_fixes_readback,
    reply_options,
)
from app.api.voice_reply import schemas
from app.api.voice_report.schemas import VoiceReportLoudness
from app.api.voice_report.service import audio_kind, heard, spool_audio, stt_or_503
from app.core.models import Assignment, Call, Card, CardEvent, MessageDelivery, Scenario
from app.core.spelling import checker

logger = logging.getLogger(__name__)


async def _options(
    request: Request, card: Card, delivery_id: UUID, call_id: UUID
) -> tuple[list[dict[str, Any]], str, list[list[str]]]:
    """Варианты ответа реплики той же бригады, на которую ещё не ответили, и текст
    реплики: в нём повтор адреса, от которого поправка должна отличаться (HQ-024).

    404 — реплика не этой бригады или карточки; 409 — на неё не отвечают или уже ответили.
    """
    db = request.state.db
    delivery = await db.get(MessageDelivery, delivery_id)
    call = await db.get(Call, call_id)
    if (
        delivery is None
        or delivery.card_id != card.id
        or call is None
        or call.card_id != card.id
        or call.brigade_id is None
        or delivery.brigade_id != call.brigade_id
    ):
        raise HTTPException(404, "Реплика бригады не найдена.")
    if call.refusal is not None:
        raise HTTPException(409, "Бригада отказала: ответ на прежнюю реплику недоступен.")
    _, events = await card_events_plan(db, card)
    known = reply_options(events)
    options = known.get(content_id(delivery)) or known.get(delivery.message_id, [])
    if not options:
        raise HTTPException(409, "На эту реплику бригады ответ не нужен.")
    answered = await db.scalar(
        select(CardEvent.id).where(
            CardEvent.card_id == card.id,
            CardEvent.type == "brigade_reply",
            CardEvent.payload["delivery_id"].astext == str(delivery_id),
        )
    )
    if answered is not None:
        raise HTTPException(409, "На эту реплику уже ответили.")
    text = delivery.message.get("text")
    identities = {str(content_id(delivery)), str(delivery.message_id)}
    groups = [
        [str(ext) for ext in expect["phone_exts"]]
        for event in events
        if event.get("line") and str(event["line"]["id"]) in identities
        for expect in event.get("expect", [])
        if expect.get("action") == "call_service"
    ]
    return options, text if isinstance(text, str) else "", groups


async def recognize_reply(
    request: Request, call_id: UUID, delivery_id: UUID | None, audio: UploadFile
) -> schemas.VoiceReply:
    request.state.entity = "call_voice_reply"
    request.state.entity_id = str(call_id)
    provider = await stt_or_503(request, audio)
    call = await get_call_row(request, call_id)
    if call.ended_at is not None or call.answered_at is None:
        await audio.close()
        raise HTTPException(409, "Ответить бригаде можно только в идущем разговоре.")
    media_type, extension = await audio_kind(audio)
    db = request.state.db
    card = await db.get(Card, call.card_id)
    scenario = await db.scalar(
        select(Scenario)
        .join(Assignment, Assignment.scenario_id == Scenario.id)
        .join(Card, Card.assignment_id == Assignment.id)
        .where(Card.id == call.card_id)
    )
    if card is None or scenario is None:
        await audio.close()
        raise HTTPException(404, "Звонок не найден.")
    try:
        options, question, service_groups = (
            await _options(request, card, delivery_id, call.id)
            if delivery_id is not None
            else ([], "", [])
        )
    except HTTPException:
        await audio.close()
        raise
    with tempfile.NamedTemporaryFile(suffix=extension) as handle:
        total = await spool_audio(audio, handle)
        hints = reply_hints(options, {"card": scenario.card, "reference": scenario.reference})
        recognition = await provider.recognize(Path(handle.name), hints)
    text = recognition.text.strip()
    understood = bool(options) and heard(
        text, recognition.confidence, request.app.state.config.stt_min_confidence
    )
    # Ключи already/calling имеют смысл состояния службы: частичное совпадение слов
    # кнопки не должно засчитать вопрос, отрицание или сообщение о другой службе.
    # Для нескольких ожиданий нужны все группы; внутри группы номера альтернативны.
    option_key = None
    if understood:
        if any(option.get("key") in {ALREADY_OPTION, CALLING_OPTION} for option in options):
            matched = [
                service_reply_option(options, text, group) for group in (service_groups or [[]])
            ]
            if matched[0] is not None and all(key == matched[0] for key in matched):
                option_key = matched[0]
        else:
            option_key = voice_reply_option(options, text, checker(), scenario.card, question)
    # Фраза без вопроса, которую мир засчитает поправкой повтора адреса (HQ-024): ответит
    # бригада репликой ветки, окно телефона своего «Принял» не даёт.
    world_answers = (
        delivery_id is None
        and call.brigade_id is not None
        and bool(text)
        and await phrase_fixes_readback(db, card, call.brigade_id, text, datetime.now(UTC))
    )
    loudness = (
        cast(VoiceReportLoudness, loudness_verdict(*recognition.loudness))
        if recognition.loudness is not None
        else None
    )
    # Почему фраза не сопоставлена, видно только здесь: звук не храним, текст — в лог.
    logger.info(
        "Ответ бригаде голосом, звонок %s, реплика %s: %d байт %s, уверенность %s (порог %s), "
        "громкость %s, вариант %s, текст %r",
        call_id,
        delivery_id,
        total,
        media_type,
        recognition.confidence,
        request.app.state.config.stt_min_confidence,
        loudness,
        option_key,
        text,
    )
    return schemas.VoiceReply(
        text=text,
        confidence=recognition.confidence,
        option_key=option_key,
        loudness=loudness,
        world_answers=world_answers,
    )
