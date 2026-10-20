"""Второе ревью: сроки удержания, поздний доклад и повтор учебной карточки."""

from datetime import datetime, timedelta
from uuid import uuid4

import pytest
from app.api.cards import service as card_service

from . import test_brigade_briefing as briefing_base
from . import test_evaluations as evaluation_base
from .test_brigade_briefing import accept
from .test_lifecycle import event
from .test_practice_gating import send, worker_tick

briefing_card = briefing_base.briefing_card
evaluation_case = evaluation_base.evaluation_case


async def isolated_scenario(db, assignment):
    """Override теста не становится few-shot для последующих проверок общей seed-БД."""
    from copy import deepcopy

    from app.core.models import Scenario

    source = await db.get(Scenario, assignment.scenario_id)
    scenario = Scenario(
        **{
            column.name: deepcopy(getattr(source, column.name))
            for column in Scenario.__table__.columns
            if column.name not in {"id", "created_at"}
        },
        id=uuid4(),
    )
    db.add(scenario)
    await db.flush()
    assignment.scenario_id = scenario.id
    return scenario


@pytest.mark.parametrize("briefing_card", ["gas-apartment-101-1"], indirect=True)
@pytest.mark.parametrize("age", [179.999, 180, 181])
@pytest.mark.parametrize("uppercase", ["hold", "resume"])
def test_resume_obeys_server_deadline_before_delayed_worker(
    briefing_card, database_url, monkeypatch, age, uppercase
):
    client, headers, card, _ = briefing_card
    accept(client, headers, card)
    call_id = str(uuid4())
    send(client, headers, card["id"], "call_dial", {"call_id": call_id, "phone_ext": "103"})
    send(client, headers, card["id"], "call_answer", {"call_id": call_id})
    held_payload = {"call_id": call_id.upper() if uppercase == "hold" else call_id}
    held = send(client, headers, card["id"], "call_hold", held_payload).json()
    at = datetime.fromisoformat(held["server_ts"].replace("Z", "+00:00"))

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return at + timedelta(seconds=age)

    monkeypatch.setattr(card_service, "datetime", Clock)
    payload = {"call_id": call_id.upper() if uppercase == "resume" else call_id}
    body = event("call_resume", payload)
    # Клиентские часы не определяют срок; попытка выглядит старше удержания.
    body["client_ts"] = (at - timedelta(seconds=10)).isoformat()
    url = f"/api/cards/{card['id']}/events"
    for attempt in range(2):
        resumed = client.post(url, json=body, headers=headers)
        assert resumed.status_code == (200 if age < 180 else 409), resumed.text
        if age < 180:
            assert resumed.json()["duplicate"] is bool(attempt)
        else:
            assert resumed.json()["code"] == "call_ended"
    marks = client.get(url).json()
    assert [m["payload"] for m in marks if m["type"] == "call_hold"] == [held_payload]
    assert len([m for m in marks if m["type"] == "call_resume"]) == int(age < 180)
    worker_tick(database_url, at + timedelta(seconds=250))
    worker_tick(database_url, at + timedelta(seconds=300))
    assert client.get(f"/api/calls/{call_id}").json()["state"] == (
        "talking" if age < 180 else "ended"
    )


def test_tutorial_again_uses_original_service_after_profile_change(database_client, database_url):
    from uuid import UUID

    from app.api.sessions.practice import tutorial_scenario_id
    from app.core.models import Assignment, Scenario, User
    from sqlalchemy import select

    from . import test_c03_sessions as c03
    from .test_c04_completion import seed_training
    from .test_lifecycle import login, run_db

    seed_training(database_url)
    client = database_client

    async def set_service(db, service):
        user = await db.scalar(select(User).where(User.login == "trainee03"))
        old = user.dds_service_id
        user.dds_service_id = service
        return old

    original = run_db(database_url, lambda db: set_service(db, "101"))
    headers = login(client, "trainee03")
    try:
        first = client.post("/api/practice", headers=headers)
        assert first.status_code == 200, first.text
        c03.tick(database_url)
        card = next(
            c for c in client.get("/api/cards").json() if c["session_id"] == first.json()["id"]
        )
        run_db(database_url, lambda db: set_service(db, "103"))
        repeated = client.post(f"/api/practice?again={card['id']}", headers=headers)
        assert repeated.status_code == 200, repeated.text

        async def assigned(db):
            scenario = await db.scalar(
                select(Scenario)
                .join(Assignment, Assignment.scenario_id == Scenario.id)
                .where(Assignment.session_id == UUID(repeated.json()["id"]))
            )
            return scenario.id, scenario.target_service_id

        assert run_db(database_url, assigned) == (tutorial_scenario_id("101"), "101")
        assert repeated.json()["title"] == first.json()["title"]
        assert repeated.json()["settings_snapshot"]["hints_level"] == 1
        assert repeated.json()["settings_snapshot"]["spelling_hints"] is True
        assert repeated.json()["participants"][0]["dds_service_id"] == "101"
    finally:
        run_db(database_url, lambda db: set_service(db, original))
        for lesson in client.get("/api/sessions").json():
            if lesson["status"] == "running" and lesson["kind"] == "practice":
                client.post(f"/api/sessions/{lesson['id']}/finish", headers=headers)


@pytest.mark.parametrize("worker_first", [True, False])
@pytest.mark.parametrize("judged", [False, True])
@pytest.mark.parametrize("snapshot", [None, [], ["no_change"], ["no_change", "full"]])
def test_late_report_refreshes_persisted_evaluation_in_both_orders(
    database_client, database_config, database_url, evaluation_case, worker_first, judged, snapshot
):
    from copy import deepcopy

    from app.api.analysis.service import card_timing
    from app.api.evaluations.service import evaluation_context
    from app.core.models import (
        Assignment,
        AuditLog,
        Card,
        CardEvent,
        Evaluation,
        Job,
        Prediction,
        Scenario,
        Session,
        TeacherOverride,
    )
    from app.worker.judging import combine
    from app.worker.providers.judge import JudgeVerdict, NullJudge
    from evalcore.defaults import CRITERIA
    from evalcore.scoring import evaluate
    from sqlalchemy import select

    from .test_c06_judge import process
    from .test_lifecycle import login, run_db

    class Judge:
        name = "local:review2"

        def __init__(self):
            self.requests = []
            # Дробный балл ловит потерю точности при повторном соединении слоёв.
            self.verdict = JudgeVerdict(["Один факт"], ["Второй", "Третий"], 0.812345, "Проверено.")

        async def assess(self, request):
            self.requests.append(request)
            return self.verdict

    judge = Judge() if judged else NullJudge()
    card_id = evaluation_case["card_id"]
    client = database_client
    headers = login(client, "trainee01")
    url = f"/api/cards/{card_id}/events"

    async def configure(db):
        card = await db.get(Card, card_id)
        # Базовая фикстура начинает с responding; дополняем журнал исходным показом.
        db.add(
            CardEvent(
                card_id=card_id,
                actor_id=evaluation_case["trainee_id"],
                client_event_id=uuid4(),
                client_ts=card.delivered_at,
                server_ts=card.delivered_at,
                clock_offset_ms=0,
                type="deliver",
                payload={},
            )
        )
        assignment = await db.get(Assignment, card.assignment_id)
        scenario = await isolated_scenario(db, assignment)
        old = deepcopy(scenario.reference)
        scenario.reference = {
            **old,
            "expected_call": {
                "required": True,
                "service_id": "103",
                "phone_ext": "103",
                "before_s": 1000,
            },
        }
        lesson = await db.get(Session, assignment.session_id)
        lesson.settings_snapshot = {
            **lesson.settings_snapshot,
            "weights": {key: int(key == "call") for key in CRITERIA},
        }
        return scenario.id, old

    scenario_id, old_reference = run_db(database_url, configure)
    call_id = str(uuid4())
    try:
        for kind, payload in [
            ("call_dial", {"call_id": call_id, "phone_ext": "103"}),
            ("call_answer", {"call_id": call_id}),
            ("call_hold", {"call_id": call_id.upper(), "report_choices": ["no_change"]}),
            ("call_resume", {"call_id": call_id}),
            ("status_change", {"state": "completed", "comment": "Работа завершена"}),
        ]:
            send(client, headers, card_id, kind, payload)

        async def stored(db):
            return await db.scalar(select(Evaluation).where(Evaluation.card_id == card_id))

        first = run_db(database_url, stored)
        found_id = first.id
        assert first.rules_scores["call"] == pytest.approx(2 / 3)
        prediction_before = run_db(
            database_url, lambda db: db.get(Prediction, evaluation_case["prediction_id"])
        )
        if worker_first:
            process(database_config, database_url, card_id, found_id, judge)
        before = run_db(database_url, stored)

        # Настоящий route override и его append-only аудит не должны потерять связь с оценкой.
        teacher_headers = login(client)
        overridden = client.post(
            "/api/overrides",
            headers=teacher_headers,
            json={
                "evaluation_id": str(found_id),
                "decision": "disagree",
                "new_total": 0.91,
                "reason": "Проверено преподавателем",
                "teacher_comment": "Сохранить решение",
            },
        )
        assert overridden.status_code == 201, overridden.text
        headers = login(client, "trainee01")
        report = (
            {}
            if snapshot is None
            else {
                "report_choices": snapshot,
                "report_modes": ["voice"] * len(snapshot),
            }
        )
        body = event("call_hangup", {"call_id": call_id, **report})
        hangup = client.post(url, headers=headers, json=body)
        assert hangup.status_code == 200, hangup.text

        async def expected(db):
            ctx, card, _, lesson = await evaluation_context(db, card_id)
            return evaluate(ctx, timing=await card_timing(db, card, lesson))

        rules = run_db(database_url, expected)
        after = run_db(database_url, stored)
        assert after.rules_scores == {c.key: c.score for c in rules.criteria}
        assert after.critical_flags == rules.critical_flags
        assert after.explanation["call"]["evidence"] == next(
            c.evidence for c in rules.criteria if c.key == "call"
        )
        assert after.id == found_id and after.version == before.version
        assert after.status == before.status
        assert after.model_info == before.model_info
        assert after.llm_scores == before.llm_scores
        assert after.semantic_scores == before.semantic_scores
        if judged and worker_first:
            assert after.total == pytest.approx(
                combine(rules.total, bool(rules.critical_flags), 0.5, judge.verdict), abs=1e-12
            )
            for key in before.llm_scores:
                assert after.explanation[key] == before.explanation[key]
            assert len(judge.requests) == 1
        else:
            assert after.total == pytest.approx(rules.total)
        for _ in range(2):
            retry = client.post(url, headers=headers, json=body)
            assert retry.status_code == 200 and retry.json()["duplicate"] is True
        collision = {**body, "payload": {**body["payload"], "voice_failures": 10}}
        assert client.post(url, headers=headers, json=collision).status_code == 409
        send(client, headers, card_id, "call_hangup", body["payload"], 409)
        retried = run_db(database_url, stored)
        assert retried.total == after.total and retried.explanation == after.explanation
        if not worker_first:
            process(database_config, database_url, card_id, found_id, judge)
        final = run_db(database_url, stored)
        assert final.rules_scores == after.rules_scores
        assert final.total == pytest.approx(
            combine(rules.total, bool(rules.critical_flags), 0.5, judge.verdict)
            if judged
            else rules.total,
            abs=1e-12,
        )
        assert final.status == ("complete" if judged else "partial")
        view = client.get(f"/api/evaluations/{found_id}").json()
        assert view["total"] == 0.91 and view["teacher_comment"] == "Сохранить решение"

        async def inspect(db):
            assert (
                len(list(await db.scalars(select(Evaluation).where(Evaluation.card_id == card_id))))
                == 1
            )
            jobs = list(
                await db.scalars(
                    select(Job).where(Job.payload["evaluation_id"].astext == str(found_id))
                )
            )
            assert len(jobs) == 1
            overrides = list(
                await db.scalars(
                    select(TeacherOverride).where(TeacherOverride.evaluation_id == found_id)
                )
            )
            assert len(overrides) == 1 and overrides[0].new_total == 0.91
            audit = await db.scalar(
                select(AuditLog).where(
                    AuditLog.action == "createOverride", AuditLog.entity_id == str(overrides[0].id)
                )
            )
            assert audit.after["total"] == 0.91
            prediction = await db.get(Prediction, evaluation_case["prediction_id"])
            assert prediction.actual_score == prediction_before.actual_score

        run_db(database_url, inspect)
        assert len([e for e in client.get(url).json() if e["type"] == "call_hangup"]) == 1
    finally:

        async def restore(db):
            scenario = await db.get(Scenario, scenario_id)
            scenario.reference, scenario.status = old_reference, "retired"

        run_db(database_url, restore)
        client.post(f"/api/sessions/{evaluation_case['session_id']}/finish", headers=login(client))


@pytest.mark.parametrize("winner", ["worker", "hangup"])
def test_worker_and_late_hangup_serialize_without_lock_inversion(
    database_client, database_config, database_url, evaluation_case, monkeypatch, winner
):
    import asyncio
    from concurrent.futures import ThreadPoolExecutor, TimeoutError
    from threading import Event

    from app.api.analysis.service import card_timing
    from app.api.evaluations.service import evaluation_context
    from app.core.models import Assignment, Card, Evaluation, Scenario
    from app.worker.jobs import handlers
    from app.worker.judging import combine
    from evalcore.scoring import evaluate
    from sqlalchemy import select

    from .test_c06_judge import RecordingJudge, process
    from .test_lifecycle import login, run_db

    client = database_client
    headers = login(client, "trainee01")
    card_id = evaluation_case["card_id"]
    call_id = str(uuid4())

    async def configure(db):
        card = await db.get(Card, card_id)
        assignment = await db.get(Assignment, card.assignment_id)
        scenario = await isolated_scenario(db, assignment)
        old = scenario.reference
        scenario.reference = {
            **old,
            "expected_call": {
                "required": True,
                "service_id": "103",
                "phone_ext": "103",
                "before_s": 1000,
            },
        }
        return scenario.id, old

    scenario_id, old_reference = run_db(database_url, configure)
    reached, release = Event(), Event()
    try:
        for kind, payload in [
            ("call_dial", {"call_id": call_id, "phone_ext": "103"}),
            ("call_answer", {"call_id": call_id}),
            ("call_hold", {"call_id": call_id, "report_choices": ["no_change"]}),
            ("call_resume", {"call_id": call_id}),
            ("status_change", {"state": "completed", "comment": "Работа завершена"}),
        ]:
            send(client, headers, card_id, kind, payload)

        async def stored(db):
            return await db.scalar(select(Evaluation).where(Evaluation.card_id == card_id))

        found_id = run_db(database_url, stored).id
        target = handlers if winner == "worker" else card_service
        method = "notify" if winner == "worker" else "refresh_terminal_rules"
        original = getattr(target, method)

        async def gated(*args, **kwargs):
            result = await original(*args, **kwargs)
            reached.set()
            assert await asyncio.to_thread(release.wait, 10), "Транзакция не отпущена"
            return result

        monkeypatch.setattr(target, method, gated)
        judge = RecordingJudge()

        def worker():
            process(database_config, database_url, card_id, found_id, judge)

        body = event(
            "call_hangup",
            {
                "call_id": call_id,
                "report_choices": ["no_change", "full"],
                "report_modes": ["voice", "voice"],
            },
        )

        def hangup():
            response = client.post(f"/api/cards/{card_id}/events", headers=headers, json=body)
            assert response.status_code == 200, response.text

        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(worker if winner == "worker" else hangup)
            try:
                assert reached.wait(10), "Победитель не взял блокировку Evaluation"
                second = pool.submit(hangup if winner == "worker" else worker)
                with pytest.raises(TimeoutError):
                    second.result(timeout=0.1)
            finally:
                release.set()
            first.result(timeout=15)
            second.result(timeout=15)

        async def verify(db):
            evaluation = await db.get(Evaluation, found_id)
            ctx, card, _, lesson = await evaluation_context(db, card_id)
            rules = evaluate(ctx, timing=await card_timing(db, card, lesson))
            assert evaluation.rules_scores == {c.key: c.score for c in rules.criteria}
            assert evaluation.critical_flags == rules.critical_flags
            assert evaluation.status == "complete"
            verdict = await RecordingJudge().assess(judge.requests[0])
            assert evaluation.total == pytest.approx(
                combine(
                    rules.total,
                    bool(rules.critical_flags),
                    lesson.settings_snapshot["critical_cap"],
                    verdict,
                ),
                abs=1e-12,
            )

        run_db(database_url, verify)
        assert len(judge.requests) == 1
    finally:
        release.set()

        async def restore(db):
            scenario = await db.get(Scenario, scenario_id)
            scenario.reference, scenario.status = old_reference, "retired"

        run_db(database_url, restore)
        client.post(f"/api/sessions/{evaluation_case['session_id']}/finish", headers=login(client))
