"""Правка норматива черновика: HTTP, RBAC и снимки без PostgreSQL."""

import copy
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from app.api.c01 import DEFAULT_TIMING_POLICY
from app.api.foundation import router as foundation
from app.api.sessions import repo, schemas, service
from app.api.sessions.router import ENDPOINTS
from app.core.contracts import read_json
from app.core.models import Session
from app.core.security import csrf_digest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient


@pytest.fixture
def lesson(monkeypatch):
    spec = read_json("contracts/openapi.draft.yaml")
    settings = copy.deepcopy(spec["components"]["schemas"]["Settings"]["examples"][0])
    owner = uuid4()
    row = Session(
        id=uuid4(),
        teacher_id=owner,
        title="Норматив",
        status="draft",
        kind="lesson",
        participants=[],
        settings_snapshot=settings,
        timing_policy=dict(DEFAULT_TIMING_POLICY),
        started_at=None,
        finished_at=None,
        ai_preparation=None,
        start_request=None,
    )
    db = SimpleNamespace(flush=AsyncMock())
    get_session = AsyncMock(return_value=row)
    monkeypatch.setattr(repo, "get_session", get_session)
    user = SimpleNamespace(id=owner, role="teacher")
    monkeypatch.setattr(foundation, "read_token", lambda *_: (uuid4(), user.id))
    monkeypatch.setattr(
        foundation.repo,
        "authenticate",
        AsyncMock(return_value=(SimpleNamespace(csrf_hash=csrf_digest("test-csrf")), user)),
    )
    app = FastAPI()
    app.state.config = SimpleNamespace()

    @app.middleware("http")
    async def state(request: Request, call_next):
        request.state.db = db
        return await call_next(request)

    app.include_router(
        foundation.make_router(spec, {"updateSessionNorms": ENDPOINTS["updateSessionNorms"]}),
        prefix="/api",
    )
    with TestClient(app) as client:
        client.cookies.update({"session": "test", "csrf": "test-csrf"})
        yield SimpleNamespace(client=client, row=row, db=db, user=user, get=get_session)


def patch(lesson, value=240, **kwargs):
    return lesson.client.patch(
        f"/api/sessions/{lesson.row.id}/norms",
        json={"handling_normative_s": value},
        headers={"X-CSRF-Token": "test-csrf"},
        **kwargs,
    )


@pytest.mark.parametrize("seconds", [1, 180, 240, 3600])
@pytest.mark.parametrize("version", [None, 2, 3])
def test_updates_both_snapshots(lesson, seconds, version):
    if version is None:
        lesson.row.timing_policy = None
    else:
        lesson.row.timing_policy = copy.deepcopy(
            read_json("contracts/c01.schema.json")["$defs"]["TimingPolicy"]["examples"][version - 2]
        )
    settings_before = copy.deepcopy(lesson.row.settings_snapshot)
    policy_before = copy.deepcopy(lesson.row.timing_policy)
    response = patch(lesson, seconds)
    assert response.status_code == 200, response.text
    expected_settings = {
        **settings_before,
        "handling_normative_s": seconds,
    }
    assert lesson.row.settings_snapshot == expected_settings
    assert response.json()["settings_snapshot"] == schemas.Settings.model_validate(
        expected_settings
    ).model_dump(mode="json")
    assert lesson.row.timing_policy == (
        {**policy_before, "handling_normative_s": seconds} if policy_before else None
    )
    lesson.get.assert_awaited_once_with(lesson.db, lesson.row.id, lock=True)
    lesson.db.flush.assert_awaited_once()


@pytest.mark.parametrize("value", [0, -1, 3601, 1.5, "180", True, None])
def test_rejects_invalid_seconds(lesson, value):
    assert patch(lesson, value).status_code == 422
    lesson.db.flush.assert_not_awaited()


def test_rejects_unknown_fields(lesson):
    response = lesson.client.patch(
        f"/api/sessions/{lesson.row.id}/norms",
        json={"handling_normative_s": 180, "reaction_normative_s": 10},
        headers={"X-CSRF-Token": "test-csrf"},
    )
    assert response.status_code == 422


def test_other_teacher_cannot_update(lesson):
    lesson.user.id = uuid4()
    assert patch(lesson).status_code == 404
    assert lesson.row.settings_snapshot["handling_normative_s"] == 180
    lesson.db.flush.assert_not_awaited()


@pytest.mark.parametrize("role", ["trainee", "admin"])
def test_only_teacher_can_update(lesson, role):
    lesson.user.role = role
    assert patch(lesson).status_code == 403
    lesson.get.assert_not_awaited()


@pytest.mark.parametrize("status", ["running", "finished"])
def test_cannot_update_after_start(lesson, status):
    lesson.row.status = status
    response = patch(lesson)
    assert response.status_code == 409
    assert "до начала занятия" in response.json()["detail"]
    assert lesson.row.settings_snapshot["handling_normative_s"] == 180
    lesson.db.flush.assert_not_awaited()


def test_requires_csrf(lesson):
    lesson.client.cookies.delete("csrf")
    assert patch(lesson).status_code == 403


def test_missing_session(lesson):
    lesson.get.return_value = None
    assert patch(lesson).status_code == 404


def test_default_new_lesson_normative():
    settings = read_json("contracts/openapi.draft.yaml")["components"]["schemas"]["Settings"][
        "examples"
    ][0]
    assert settings["handling_normative_s"] == 180
    body = schemas.SessionInput(title="Новое занятие", participants=[], settings_snapshot=settings)
    assert service.timing_snapshot(body)["handling_normative_s"] == 180
