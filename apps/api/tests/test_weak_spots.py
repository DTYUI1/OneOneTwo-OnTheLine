"""Профиль навыков, доля целевых карточек и персональная история Студии."""

import asyncio
from collections import Counter
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from app.api.analysis import weak_spots
from app.api.database import create_database_app
from app.core.db import Database
from app.core.models import Assignment, Card, Evaluation, Job, Participant, Scenario, Session, User
from app.worker.generators import pairwise, variant_paths, variation
from app.worker.generators.personalization import focus_orders, selection
from app.worker.generators.storage import gameplay_history
from evalcore.models import EvalContext
from fastapi.testclient import TestClient
from sqlalchemy import select

from .test_ai_lessons import prepare, users_for_test
from .test_lifecycle import login, run_db

PROFILE = {"readback_error": {"failed": 4, "total": 5, "rate": 0.8}}


def raw_event(kind, *, correct=False, presented=True):
    at = datetime(2026, 10, 1, tzinfo=UTC)
    action = "correct_readback" if kind == "readback_error" else "reply"
    return {
        "event": {
            "kind": kind,
            "brigade_id": str(UUID(int=1)),
            "trigger": {"on": "message", "after_s": 2, "message_id": "departure"},
            "line": {"id": str(UUID(int=2)), "text": "Вопрос", "version": 1},
            "expect": [{"action": action, "option_key": "yes", "within_s": 30}],
            "branches": {},
            "review": {"label": "Вопрос", "critical": False},
        },
        "fired_at": at.isoformat(),
        "source": "plan",
        "presented_at": at.isoformat() if presented else None,
        "replies": [
            {
                "at": (at + timedelta(seconds=2)).isoformat(),
                "option_key": "yes" if correct else "no",
            }
        ]
        if presented
        else [],
    }


def test_profile_separates_brigade_skills_and_does_not_score_unheard():
    context = EvalContext(
        scenario={},
        current={},
        events=[],
        calls=[],
        settings={},
        scenario_events=(
            raw_event("readback_error"),
            raw_event("clarify", correct=True),
            raw_event("clarify", presented=False),
        ),
    )
    samples = weak_spots.event_samples(context)
    assert samples == [("readback_error", 0), ("clarify", 1)]
    profile = weak_spots.aggregate(samples + [("readback_error", 1), ("reaction_time", 0.5)])
    assert profile["readback_error"] == {"failed": 1, "total": 2, "rate": 0.5}
    assert profile["clarify"]["rate"] == 0
    assert profile["reaction_time"]["rate"] == 1
    assert weak_spots.aggregate([]) == {}


def test_weighted_variants_raise_readback_share_but_do_not_make_it_certain(monkeypatch):
    available = variant_paths.options("102", 2)
    monkeypatch.setattr(variant_paths, "options", lambda *_: available)
    totals = []
    for profile in ({}, PROFILE):
        with_readback = 0
        for seed in range(500):
            _, data = variant_paths.pick("102", 2, seed, Counter(), Counter(), profile=profile)
            assert variation.level_ok(data["events"], 2)
            with_readback += any(e["kind"] == "readback_error" for e in data["events"])
        totals.append(with_readback)
    assert totals[0] + 50 < totals[1] < 500
    assert len(focus_orders(100, 42)) == 60
    assert focus_orders(100, 42) == focus_orders(100, 42)
    for seed in range(5):
        assert variant_paths.pick("102", 2, seed, Counter(), Counter()) == variant_paths.pick(
            "102", 2, seed, Counter(), Counter(), profile={}
        )


def test_reason_describes_actual_fallback_not_requested_focus():
    data = {"events": [{"kind": "clarify"}]}
    info = selection(data, PROFILE, True, "user")
    assert not info["targeted"] and info["skills"] == []
    assert "нет доступного варианта" in info["explanation"]


def test_profile_uses_latest_evaluation_and_only_five_finished_lessons(database_url, monkeypatch):
    async def event_data(db, card):
        return (raw_event("readback_error"), raw_event("clarify", correct=True))

    monkeypatch.setattr(weak_spots, "evaluation_events", event_data)

    async def check():
        database = Database(database_url)
        try:
            async with database.sessions.begin() as db:
                teacher = await db.scalar(select(User).where(User.login == "teacher"))
                sample = await db.scalar(select(User).where(User.login == "trainee01"))
                trainee = User(
                    login="weak-" + uuid4().hex,
                    role="trainee",
                    full_name="Тест",
                    password_hash=sample.password_hash,
                    is_active=True,
                )
                db.add(trainee)
                await db.flush()
                assert await weak_spots.profile(db, trainee.id) == {}
                scenario = await db.scalar(
                    select(Scenario).where(Scenario.target_service_id == "102")
                )
                now = datetime.now(UTC)
                for index in range(7):
                    lesson = Session(
                        teacher_id=teacher.id,
                        title="Оценки",
                        kind="lesson",
                        status="finished" if index < 6 else "running",
                        started_at=now - timedelta(days=8 - index),
                        finished_at=now - timedelta(days=7 - index) if index < 6 else None,
                        settings_snapshot={"weights": {"brigade_work": 1, "reaction_time": 1}},
                    )
                    db.add(lesson)
                    await db.flush()
                    participant = Participant(
                        session_id=lesson.id,
                        user_id=trainee.id,
                        workstation_id=1,
                        dds_service_id="102",
                        level=2,
                        rating_at_start=0,
                    )
                    db.add(participant)
                    await db.flush()
                    assignment = Assignment(
                        session_id=lesson.id,
                        participant_id=participant.id,
                        scenario_id=scenario.id,
                        scenario_version=scenario.version,
                        order=1,
                        status="completed",
                        planned_at=lesson.started_at,
                    )
                    db.add(assignment)
                    await db.flush()
                    card = Card(
                        assignment_id=assignment.id,
                        number=str(10000000 + index),
                        state="completed",
                        appeared_at=lesson.started_at,
                        closed_at=lesson.started_at + timedelta(minutes=10),
                        current={},
                    )
                    db.add(card)
                    await db.flush()
                    for version, scores in [
                        (1, {"reaction_time": 0}),
                        (2, {"reaction_time": 1, "brigade_work": 0.5}),
                        (3, {}),
                    ]:
                        db.add(
                            Evaluation(
                                card_id=card.id,
                                version=version,
                                rules_scores=scores,
                                total=0.5,
                                critical_flags=[],
                                explanation={},
                                model_info={},
                                status="partial",
                            )
                        )
                await db.flush()
                profile = await weak_spots.profile(db, trainee.id)
                assert profile["readback_error"] == {"failed": 5, "total": 5, "rate": 1}
                assert profile["clarify"] == {"failed": 0, "total": 5, "rate": 0}
                assert profile["reaction_time"] == {"failed": 0, "total": 5, "rate": 0}
                await db.rollback()
        finally:
            await database.close()

    asyncio.run(check())


@pytest.mark.usefixtures("clean_generated_content")
def test_search_and_personal_pack_use_trainee_history(database_config, database_url, monkeypatch):
    [(user_id, user_login), (other_id, _)] = users_for_test(database_url, 2)

    async def known_profile(db, user):
        return PROFILE if str(user) == user_id else {}

    monkeypatch.setattr(weak_spots, "profile", known_profile)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        found = client.get("/api/packs/generation-trainees", params={"login": user_login})
        assert found.status_code == 200, found.text
        assert found.json()[0]["id"] == user_id
        assert found.json()[0]["dds_service_id"] == "102"
        assert found.json()[0]["recommended_level"] == 1
        assert (
            client.get("/api/packs/generation-trainees", params={"login": "teacher"}).json() == []
        )
        assert client.get("/api/packs/generation-trainees", params={"login": "%"}).json() == []
        body = {
            "count": 2,
            "service_id": "102",
            "level": 2,
            "seed": 42,
            "trainee_login": user_login,
            "generation_request_id": str(uuid4()),
        }
        result = client.post("/api/packs/generate", json=body, headers=headers)
        assert result.status_code == 202, result.text
        job_id = result.json()["id"]
        assert client.post("/api/packs/generate", json=body, headers=headers).json()["id"] == job_id
        prepare(database_config, job_id)
        progress = client.get(f"/api/jobs/{job_id}/progress").json()
        assert progress["completed"] == 2
        assert any(f"Подобрано для {user_login}" in w for w in progress["warnings"])

        async def check(db):
            teacher = await db.scalar(select(User).where(User.login == "teacher"))
            job = await db.get(Job, UUID(job_id))
            assert all(item["participant_id"] == user_id for item in job.payload["items"])
            assert all(item["weak_spots"] == PROFILE for item in job.payload["items"])
            history = await gameplay_history(db, author_id=teacher.id, participant_id=UUID(user_id))
            assert {str(s.id) for s in history} == set(progress["scenario_ids"])
            assert (
                await gameplay_history(db, author_id=teacher.id, participant_id=UUID(other_id))
                == []
            )
            possible = pairwise.universe(variant_paths.options("102", 2))
            covered = pairwise.covered(history)
            assert f"Покрыто пар: {len(covered)} из {len(possible)}." in progress["warnings"]
            ordered = {str(row.id): row for row in history}
            previous = set()
            for sid in progress["scenario_ids"]:
                actual = pairwise.covered([ordered[sid]])
                best = max(
                    len(pairwise.pairs(pairwise.features(data)) - previous)
                    for _, data in variant_paths.options("102", 2).values()
                )
                assert len(actual - previous) == best
                previous.update(actual)
            for row in history:
                personal = row.generation_metadata["constructor"]["personalization"]
                assert personal["user_id"] == user_id and personal["profile"] == PROFILE
                assert "Причина подбора:" in row.teacher_comment

        run_db(database_url, check)
        before = client.get(
            "/api/packs/generation-variety",
            params={"service_id": "102", "level": 2, "trainee_login": user_login},
        ).json()
        assert before["variants_total"] - before["variants_left"] == 2
        for invalid in ("teacher", "missing-login"):
            response = client.post(
                "/api/packs/generate",
                json={**body, "trainee_login": invalid, "generation_request_id": str(uuid4())},
                headers=headers,
            )
            assert response.status_code == 422
        login(client, "trainee01")
        assert (
            client.get("/api/packs/generation-trainees", params={"login": user_login}).status_code
            == 403
        )
