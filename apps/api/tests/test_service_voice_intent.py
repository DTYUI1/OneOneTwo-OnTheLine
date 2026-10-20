"""Смысл ответа голосом проверяется до общего совпадения со словами кнопки.

Настоящий recognize_reply и словарь приложения; STT и чтение БД — управляемые границы.
"""

import asyncio
from datetime import UTC, datetime
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from app.api.voice_reply import service
from app.core.models import Call, Card, MessageDelivery, Scenario
from app.worker.providers.interfaces import Recognition
from starlette.datastructures import Headers, UploadFile


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Медики уже едут", "already"),
        ("Вызванная скорая помощь", "already"),
        ("Вызов приняли, машина в пути", "already"),
        ("Не пожарных, скорую вызвал", "already"),
        ("Полицию уже вызвал, едут", None),
        ("Уже вызвал, едут?", None),
        ("Скорую не вызвал, ещё не едут", None),
        ("Сейчас вызову скорую", "calling"),
    ],
)
def test_recognize_reply_uses_service_intent_and_the_requested_service(monkeypatch, text, expected):
    card = SimpleNamespace(id=uuid4(), assignment_id=uuid4())
    brigade = uuid4()
    call = SimpleNamespace(
        id=uuid4(),
        card_id=card.id,
        brigade_id=brigade,
        answered_at=datetime.now(UTC),
        ended_at=None,
        refusal=None,
    )
    line = uuid4()
    options = [
        {"key": "already", "label": "Уже вызвал, едут"},
        {"key": "calling", "label": "Понял, вызываю"},
    ]
    delivery = SimpleNamespace(
        id=uuid4(),
        card_id=card.id,
        brigade_id=brigade,
        message_id=line,
        message={"id": str(line), "text": "Нужна скорая, срочно!"},
    )
    planned = {
        "id": str(line),
        "kind": "request_service",
        "line": {"id": str(line), "text": delivery.message["text"]},
        "reply_options": options,
        "expect": [{"action": "call_service", "phone_exts": ["103", "112"], "within_s": 30}],
    }
    scenario = SimpleNamespace(card={}, reference={})

    class DB:
        async def get(self, model, _key):
            return {Card: card, Call: call, MessageDelivery: delivery}.get(model)

        async def scalar(self, query):
            return scenario if query.column_descriptions[0]["entity"] is Scenario else None

    provider = SimpleNamespace(recognize=AsyncMock(return_value=Recognition(text, 0.9)))
    monkeypatch.setattr(service, "stt_or_503", AsyncMock(return_value=provider))
    monkeypatch.setattr(service, "get_call_row", AsyncMock(return_value=call))
    monkeypatch.setattr(service, "card_events_plan", AsyncMock(return_value=([], [planned])))
    request = SimpleNamespace(
        state=SimpleNamespace(db=DB()),
        app=SimpleNamespace(state=SimpleNamespace(config=SimpleNamespace(stt_min_confidence=0.45))),
    )
    audio = UploadFile(
        BytesIO(b"controlled-audio"),
        filename="reply.webm",
        headers=Headers({"content-type": "audio/webm"}),
    )
    result = asyncio.run(service.recognize_reply(request, call.id, delivery.id, audio))
    assert result.text == text
    assert result.option_key == expected
    assert result.world_answers is False
    assert provider.recognize.await_count == 1
