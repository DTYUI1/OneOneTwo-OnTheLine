"""Доклад службе голосом (DT-05, DT-11): фраза диспетчера распознаётся сразу, в разговоре.

Распознаёт локальный faster-whisper (сервис stt, без интернета и GPU) — тот же провайдер,
что у worker. Через очередь worker фраза не идёт: служба отвечает на доклад в том же
разговоре, а ADR-11 не даёт worker своего HTTP. Так же устроен вопрос оператора 112
(operator/router.py).

Текст засчитывается по смыслу: evalcore находит в нём части памятки ДДС, с. 32
(`evalcore.report.voice_report_check`: кто вы, адрес и повод, карточка, что изменилось) и
сводит их к виду доклада (карточка обязательна только в звонке в 112) — по той же шкале, что
варианты ответа. Доклад складывается за звонок: клиент присылает прежние фразы звонка
(`earlier`), части ищутся в их сумме — ответ на переспрос службы одной частью не теряет
сказанного раньше. Доклад бригады, сменивший задачу (TC-05, `task_change`), уже прозвучал — его
обстановка («горит») засчитывается поводом звонка и тем, что изменилось. Прозвучал адрес, а
улицу карточки легко спутать с похожей (TC-03, `data/confusable_streets.json`), — ответ называет
похожую улицу: дежурный попросит повторить улицу по буквам. Запрос ничего не сохраняет:
вид и части уходят в отбой звонка (`call_hangup.report_choices`, `report_parts`,
`report_modes`), аудио не хранится, в журнал аудита не пишется.
"""

import json
import logging
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import IO, Any, cast
from uuid import UUID

from evalcore.loudness import loudness_verdict
from evalcore.officials import confusable_twin
from evalcore.report import (
    recognition_hints,
    report_choice,
    requested_change,
    voice_report_check,
)
from fastapi import HTTPException, Request, UploadFile
from sqlalchemy import select

from app.api.cards.service import CONTENT_EXTENSIONS, MAX_AUDIO_BYTES, get_call_row
from app.api.evaluations.service import planned_messages
from app.api.training.scenario_events import evaluation_events
from app.api.voice_report import schemas
from app.core.config import ROOT
from app.core.models import Assignment, Card, Scenario, Street
from app.core.spelling import for_scenario
from app.worker.providers.interfaces import Recognition, STTProvider
from app.worker.providers.stt.local import LocalFasterWhisperSTT

logger = logging.getLogger(__name__)
CONFUSABLE_STREETS = ROOT / "data" / "confusable_streets.json"


@lru_cache(maxsize=1)
def confusable_pairs() -> tuple[tuple[str, str], ...]:
    """Пары похожих улиц Москвы; файла нет — переспроса по буквам не будет."""
    try:
        data = json.loads(CONFUSABLE_STREETS.read_text(encoding="utf-8"))
    except FileNotFoundError:
        logger.warning("Нет списка похожих улиц %s", CONFUSABLE_STREETS)
        return ()
    return tuple((str(first), str(second)) for first, second in data["pairs"])


def spell_street(card: object, parts: list[str]) -> str | None:
    """Похожая улица, если адрес прозвучал и улицу карточки легко спутать (TC-03)."""
    if "address" not in parts or not isinstance(card, dict):
        return None
    address = card.get("address")
    street = address.get("street") if isinstance(address, dict) else None
    return confusable_twin(street, confusable_pairs()) if isinstance(street, str) else None


def stt_provider(request: Request) -> STTProvider | None:
    """Тесты подставляют поддельного провайдера через app.state.voice_report_stt."""
    override = getattr(request.app.state, "voice_report_stt", None)
    if override is not None:
        return override
    config = request.app.state.config
    if config.stt_provider != "local":
        return None
    return LocalFasterWhisperSTT(
        base_url=config.stt_base_url, timeout_seconds=config.stt_timeout_seconds
    )


async def stt_or_503(request: Request, audio: UploadFile) -> STTProvider:
    """Провайдер распознавания; выключен на сервере — 503 stt_off (фраза не читается)."""
    provider = stt_provider(request)
    if provider is None:
        await audio.close()
        raise HTTPException(
            503,
            {
                "code": "stt_off",
                "message": "Распознавание речи выключено на сервере.",
                "details": {},
            },
        )
    return provider


async def audio_kind(audio: UploadFile) -> tuple[str, str]:
    """Тип фразы и расширение временного файла; 422 — не WAV, WebM или Ogg.

    MediaRecorder присылает параметры вида "audio/webm;codecs=opus" — сверяем только тип.
    """
    media_type = (audio.content_type or "").split(";", 1)[0].strip().lower()
    extension = CONTENT_EXTENSIONS.get(media_type)
    if extension is None:
        await audio.close()
        raise HTTPException(422, "Поддерживаются WAV, WebM и Ogg.")
    return media_type, extension


async def spool_audio(audio: UploadFile, handle: IO[bytes]) -> int:
    """Фраза — во временный файл вне веб-корня; размер в байтах.

    413 — больше 10 МиБ, 422 — пусто. Файл живёт только на время распознавания.
    """
    total = 0
    while chunk := await audio.read(1024 * 1024):
        total += len(chunk)
        if total > MAX_AUDIO_BYTES:
            await audio.close()
            raise HTTPException(413, "Аудиофайл превышает 10 МиБ.")
        handle.write(chunk)
    await audio.close()
    if total == 0:
        raise HTTPException(422, "Аудиофайл пуст.")
    handle.flush()
    return total


def heard(text: str, confidence: float | None, threshold: float) -> bool:
    """Расслышано: текст есть, и уверенность не ниже порога (нет уверенности — верим тексту)."""
    return bool(text) and (confidence is None or confidence >= threshold)


def presented_changes(planned: tuple[dict[str, Any], ...]) -> tuple[Any, ...]:
    """Перемены задачи (TC-05) из докладов бригады, которые уже прозвучали на карточке."""
    return tuple(
        item["task_change"]
        for item in planned
        if item.get("presented_at") and isinstance(item.get("task_change"), dict)
    )


def requested_changes(
    events: tuple[dict[str, Any], ...], dialed_ext: str | None
) -> tuple[Any, ...]:
    """Просьбы бригады вызвать службу (`request_service`), прозвучавшие на карточке, — для
    звонка в эту службу или в 112: обстановка, ради которой звонят, — и повод, и «что
    изменилось» (`evalcore.report.requested_change`)."""
    found = []
    for item in events:
        event = item.get("event") or {}
        if event.get("kind") != "request_service" or not item.get("presented_at"):
            continue
        exts = [ext for expect in event.get("expect", []) for ext in expect.get("phone_exts", [])]
        if dialed_ext is not None and dialed_ext not in exts:
            continue
        change = requested_change(exts)
        if change is not None:
            found.append(change)
    return tuple(found)


def report_text(earlier: str | None, text: str) -> str:
    """Доклад за звонок: прежние фразы и новая — части ищутся в сумме."""
    before = (earlier or "").strip().rstrip(".")
    return f"{before}. {text}" if before and text else text


async def close(audio: UploadFile | None) -> None:
    if audio is not None:
        await audio.close()


async def recognize_report(
    request: Request,
    call_id: UUID,
    audio: UploadFile | None,
    typed: str | None = None,
    earlier: str | None = None,
) -> schemas.VoiceReport:
    """Фраза доклада: звук (распознаётся) или поправленный обучаемым текст (TC-04).

    Текст, проверенный в поле правки, не распознаётся: он сводится к виду доклада так же, как
    распознанный, с уверенностью `None` — ему верят. Так работает и при выключенном
    распознавании. `earlier` — прежние фразы доклада в этом звонке: части и вид — по сумме.
    """
    request.state.entity = "call_voice_report"
    request.state.entity_id = str(call_id)
    phrase = typed.strip() if typed is not None else None
    if (audio is None) == (phrase is None) or phrase == "":
        await close(audio)
        raise HTTPException(422, "Нужно ровно одно из полей: audio (фраза) или text (текст).")
    provider = await stt_or_503(request, audio) if audio is not None else None
    call = await get_call_row(request, call_id)
    if call.ended_at is not None:
        await close(audio)
        raise HTTPException(409, "Звонок уже завершён.")
    media_type, extension = await audio_kind(audio) if audio is not None else ("text", "")
    db = request.state.db
    found = (
        await db.execute(
            select(Scenario, Assignment, Card)
            .join(Assignment, Assignment.scenario_id == Scenario.id)
            .join(Card, Card.assignment_id == Assignment.id)
            .where(Card.id == call.card_id)
        )
    ).first()
    if found is None:
        await close(audio)
        raise HTTPException(404, "Звонок не найден.")
    scenario, assignment, card = found
    expected = {
        "incident_type_code": scenario.incident_type_code,
        "card": scenario.card,
        "reference": scenario.reference,
    }
    if audio is not None and provider is not None:
        # Аудио — только во временный файл вне веб-корня и только на время распознавания.
        with tempfile.NamedTemporaryFile(suffix=extension) as handle:
            total = await spool_audio(audio, handle)
            recognition = await provider.recognize(Path(handle.name), recognition_hints(expected))
    else:
        total = 0
        recognition = Recognition(phrase or "", None)
    text = recognition.text.strip()
    choice: schemas.VoiceReportChoice | None = None
    parts: list[schemas.VoiceReportPart] = []
    address_gap: schemas.VoiceReportAddressGap | None = None
    if heard(text, recognition.confidence, request.app.state.config.stt_min_confidence):
        streets = tuple((await db.scalars(select(Street.name))).all())
        changes = presented_changes(
            await planned_messages(db, card, assignment, scenario)
        ) + requested_changes(await evaluation_events(db, card), call.dialed_ext)
        check = voice_report_check(
            expected,
            report_text(earlier, text),
            for_scenario(streets, scenario.card, scenario.reference),
            changes,
        )
        parts = [cast(schemas.VoiceReportPart, part) for part in check.parts]
        choice = cast(schemas.VoiceReportChoice, report_choice(check.parts, call.dialed_ext))
        address_gap = cast(schemas.VoiceReportAddressGap | None, check.address_gap)
    loudness = (
        cast(schemas.VoiceReportLoudness, loudness_verdict(*recognition.loudness))
        if recognition.loudness is not None
        else None
    )
    # Почему фраза «не расслышана», видно только здесь: звук не храним, текст — в лог.
    logger.info(
        "Голосовой доклад, звонок %s: %d байт %s, уверенность %s (порог %s), громкость %s %s, "
        "вид %s, части %s, прежнее %r, текст %r",
        call_id,
        total,
        media_type,
        recognition.confidence,
        request.app.state.config.stt_min_confidence,
        recognition.loudness,
        loudness,
        choice,
        parts,
        earlier,
        text,
    )
    return schemas.VoiceReport(
        text=text,
        confidence=recognition.confidence,
        choice=choice,
        parts=parts,
        address_gap=address_gap,
        loudness=loudness,
        spell_street=spell_street(scenario.card, list(parts)),
    )
