"""Публичная проекция вести и исход мира используют один разбор голосового текста.

Настоящие event_view/outcome_of; подменена только граница чтения журнала из БД.
"""

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from app.api.training import scenario_events as events
from app.api.training.service import _news_fields

NOW = datetime(2026, 10, 20, tzinfo=UTC)


@pytest.mark.parametrize(
    ("text", "told"),
    [
        ("Вызванная скорая помощь", True),
        ("Медики уже едут", True),
        ("Не пожарных, скорую вызвал", True),
        ("Полицию уже вызвал, едут", False),
        ("Скорую вызвали?", False),
        ("Скорую не вызвал", False),
    ],
)
def test_voice_news_projection_and_world_agree(monkeypatch, text, told):
    line, event_id, brigade = uuid4(), uuid4(), uuid4()
    planned = {
        "id": str(event_id),
        "brigade_id": str(brigade),
        "kind": "request_service",
        "line": {"id": str(line)},
        "priority": "normal",
        "expect": [{"action": "call_service", "phone_exts": ["103", "112"], "within_s": 30}],
        "branches": {},
    }
    spoken_at = NOW + timedelta(seconds=10)
    voice = {
        "at": spoken_at.isoformat(),
        "option_key": "already",
        "mode": "voice",
        "text": text,
    }
    journal = events.Journal(
        statuses=[("accepted", NOW - timedelta(seconds=10))],
        presented={line: NOW},
        delivered={line: brigade},
        heard_from={},
        replies={line: [voice]},
        calls=[
            {
                "phone_ext": "103",
                "service_id": "103",
                "brigade_id": None,
                "direction": "outbound",
                "refusal": None,
                "started_at": (NOW + timedelta(seconds=1)).isoformat(),
                "ended_at": (NOW + timedelta(seconds=2)).isoformat(),
            }
        ],
        firings={event_id: events.Firing(event_id, NOW, "normal")},
    )
    monkeypatch.setattr(events, "_context", AsyncMock(return_value=([], [planned], None, journal)))

    class DB:
        async def scalars(self, _query):
            return []

    view = asyncio.run(events.event_view(DB(), SimpleNamespace(id=uuid4()), []))
    news = _news_fields(view, line)["service_news"]
    assert ("told_at" in news) is told
    if told:
        assert news["told_at"] == spoken_at.isoformat().replace("+00:00", "Z")
    outcome = events.outcome_of(
        planned, journal.firings[event_id], journal, NOW + timedelta(seconds=23)
    )
    assert outcome.news == ("told" if told else "untold")
