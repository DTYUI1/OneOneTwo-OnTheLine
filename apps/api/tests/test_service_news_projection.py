"""Чистая реальная проекция event_view: БД заменена только на границе чтения."""

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from app.api.training import scenario_events as events
from app.api.training.service import TrainingView, _news_fields

NOW = datetime(2026, 10, 19, tzinfo=UTC)


def call(ext, offset=1, **kwargs):
    return {
        "phone_ext": ext,
        "service_id": ext,
        "brigade_id": None,
        "direction": "outbound",
        "refusal": None,
        "started_at": (NOW + timedelta(seconds=offset)).isoformat(),
        "ended_at": (NOW + timedelta(seconds=offset + 1)).isoformat(),
        **kwargs,
    }


@pytest.mark.parametrize("kind", ["request_service", "alarm"])
@pytest.mark.parametrize(
    "groups,calls,eligible",
    [
        ([["112"]], [call("112")], True),
        ([["999"]], [call("999")], True),
        ([["103", "112"], ["104"]], [call("112")], False),
        ([["103", "112"], ["104"]], [call("112"), call("104", 2)], True),
        ([["103", "112"], ["104"]], [call("103", -1), call("105")], False),
        ([["103"]], [call("103", refusal="busy")], False),
        ([["103"]], [call("103", direction="inbound")], False),
    ],
)
def test_actual_event_view_projects_all_call_service_groups(
    monkeypatch, kind, groups, calls, eligible
):
    line, event_id, brigade = uuid4(), uuid4(), uuid4()
    planned = {
        "id": str(event_id),
        "brigade_id": str(brigade),
        "kind": kind,
        "line": {"id": str(line)},
        "priority": "alarm" if kind == "alarm" else "normal",
        "expect": [
            {"action": "call_service", "phone_exts": group, "within_s": 30} for group in groups
        ],
        "branches": {},
    }
    journal = events.Journal(
        statuses=[("accepted", NOW - timedelta(seconds=10))],
        presented={line: NOW},
        delivered={line: brigade},
        heard_from={},
        replies={},
        calls=calls,
        firings={event_id: events.Firing(event_id, NOW, "normal")},
    )
    monkeypatch.setattr(events, "_context", AsyncMock(return_value=([], [planned], None, journal)))

    class DB:
        async def scalars(self, _query):
            return []

    view = asyncio.run(events.event_view(DB(), SimpleNamespace(id=uuid4()), []))
    fields = _news_fields(view, line)
    assert "service_news" in fields
    assert (fields["service_news"] is not None) is eligible
    if eligible:
        assert fields["service_news"]["called_at"] == max(c["started_at"] for c in calls).replace(
            "+00:00", "Z"
        )
    # Проверяем сам training_projection: раньше он отбрасывал окно only112.
    from app.api.training import service

    card_id, delivery_id = uuid4(), uuid4()
    delivery = SimpleNamespace(
        id=delivery_id,
        message_id=line,
        call_id=uuid4(),
        brigade_id=brigade,
        target_id=uuid4(),
        delivered_at=NOW,
        message={"id": str(line), "version": 1, "text": "Нужна помощь.", "audio": None},
    )
    presentation = SimpleNamespace(
        delivery_id=delivery_id, kind="message_presented", recorded_at=NOW
    )

    class ProjectionDB:
        reads = 0

        async def get(self, model, _key):
            return SimpleNamespace(id=card_id) if model is service.Card else None

        async def scalars(self, _query):
            return []

        async def execute(self, _query):
            self.reads += 1
            rows = [(delivery, uuid4())] if self.reads == 1 else [(presentation, uuid4())]
            return SimpleNamespace(tuples=lambda: rows)

    monkeypatch.setattr(service, "brigade_roster", AsyncMock(return_value=None))
    monkeypatch.setattr(service, "event_view", AsyncMock(return_value=view))
    monkeypatch.setattr(service, "card_events_plan", AsyncMock(return_value=([], [planned])))
    monkeypatch.setattr(service, "control_view", AsyncMock(return_value=None))
    projected = asyncio.run(service.training_projection(ProjectionDB(), card_id)).root
    actual = projected["messages"][0]["delivery"]
    assert actual["service_news"] == fields["service_news"]
    if groups == [["112"]] or groups == [["999"]]:
        assert "needs_service" not in actual
    assert TrainingView(projected).root == projected
    import json
    import os
    from pathlib import Path

    if target := os.getenv("SERVICE_NEWS_PROJECTION_FIXTURE"):
        with Path(target).open("a") as output:
            output.write(
                json.dumps(
                    {"kind": kind, "groups": groups, "eligible": eligible, "delivery": actual}
                )
                + "\n"
            )


def test_ahead_and_groups_do_not_use_union(monkeypatch):
    test_actual_event_view_projects_all_call_service_groups(
        monkeypatch, "request_service", [["103", "112"], ["104"]], [call("103", -2)], False
    )


@pytest.mark.parametrize("offset,told", [(0, True), (0.001, False)])
def test_manual_news_reports_authoritative_timely_speech(monkeypatch, offset, told):
    line, event_id, brigade = uuid4(), uuid4(), uuid4()
    planned = {
        "id": str(event_id),
        "brigade_id": str(brigade),
        "kind": "request_service",
        "line": {"id": str(line)},
        "priority": "normal",
        "expect": [{"action": "call_service", "phone_exts": ["112"], "within_s": 30}],
        "branches": {},
    }
    journal = events.Journal(
        statuses=[("accepted", NOW - timedelta(seconds=10))],
        presented={line: NOW},
        delivered={line: brigade},
        heard_from={},
        replies={},
        calls=[call("112")],
        firings={event_id: events.Firing(event_id, NOW, "normal")},
    )
    window = events.manual_news_window(planned, journal.firings[event_id], journal)
    assert window is not None and window[1] is not None
    at = window[1] + timedelta(seconds=offset)
    journal.said[brigade] = [{"at": at.isoformat(), "text": "Служба вызвана."}]
    monkeypatch.setattr(events, "_context", AsyncMock(return_value=([], [planned], None, journal)))

    class DB:
        async def scalars(self, _query):
            return []

    view = asyncio.run(events.event_view(DB(), SimpleNamespace(id=uuid4()), []))
    news = _news_fields(view, line)["service_news"]
    assert news.get("told_at") == (at.isoformat().replace("+00:00", "Z") if told else None)
    assert ("told_at" in news) is told
