"""RESUMED-B01: поздний hold/expiry согласован с сохранённой terminal-оценкой."""

from copy import deepcopy
from datetime import datetime, timedelta
from uuid import UUID, uuid4

import pytest
from app.api.analysis.service import card_timing
from app.api.evaluations.service import evaluation_context
from app.core.models import (
    Assignment,
    AuditLog,
    Call,
    Card,
    CardEvent,
    Evaluation,
    Job,
    Prediction,
    Scenario,
    Session,
    TeacherOverride,
)
from app.worker.judging import combine_scores
from app.worker.providers.judge import JudgeVerdict, NullJudge
from evalcore.defaults import CRITERIA
from evalcore.scoring import evaluate
from sqlalchemy import select

from . import test_evaluations as evaluation_base
from .test_c06_judge import process
from .test_lifecycle import event, login, run_db
from .test_practice_gating import send, worker_tick
from .test_review2_backend import isolated_scenario

evaluation_case = evaluation_base.evaluation_case


class Judge:
    name = "local:review3"

    def __init__(self):
        self.requests = []
        self.verdict = JudgeVerdict(["Один факт"], ["Второй", "Третий"], 0.812345, "Проверено.")

    async def assess(self, request):
        self.requests.append(request)
        return self.verdict


def snapshot(choices):
    return (
        {}
        if choices is None
        else {"report_choices": choices, "report_modes": ["voice"] * len(choices)}
    )


def columns(row):
    return {c.name: deepcopy(getattr(row, c.name)) for c in row.__table__.columns}


@pytest.fixture
def terminal_case(database_client, database_config, database_url, evaluation_case, request):
    client = database_client
    card_id = evaluation_case["card_id"]
    headers = login(client, "trainee01")

    async def configure(db):
        card = await db.get(Card, card_id)
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
        scenario.reference = {
            **scenario.reference,
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
        return scenario.id

    scenario_id = run_db(database_url, configure)
    call_id = str(uuid4())
    for kind in ("call_dial", "call_answer"):
        send(
            client,
            headers,
            card_id,
            kind,
            {"call_id": call_id, **({"phone_ext": "103"} if kind == "call_dial" else {})},
        )
    prior = getattr(request, "param", None)
    if prior is not None:
        send(client, headers, card_id, "call_hold", {"call_id": call_id, **snapshot(prior)})
        send(client, headers, card_id, "call_resume", {"call_id": call_id})
    send(
        client,
        headers,
        card_id,
        "status_change",
        {"state": "completed", "comment": "Работа завершена"},
    )

    async def stored(db):
        return await db.scalar(select(Evaluation).where(Evaluation.card_id == card_id))

    found_id = run_db(database_url, stored).id
    case = {
        **evaluation_case,
        "call_id": call_id,
        "evaluation_id": found_id,
        "client": client,
        "headers": headers,
        "url": f"/api/cards/{card_id}/events",
        "database_url": database_url,
        "database_config": database_config,
        "stored": lambda: run_db(database_url, stored),
    }
    try:
        yield case
    finally:

        async def retire(db):
            scenario = await db.get(Scenario, scenario_id)
            scenario.status = "retired"

        run_db(database_url, retire)
        client.post(f"/api/sessions/{evaluation_case['session_id']}/finish", headers=login(client))


def run_worker(case, judge):
    process(
        case["database_config"], case["database_url"], case["card_id"], case["evaluation_id"], judge
    )


def assert_current_rules(case):
    async def expected(db):
        ctx, card, _, lesson = await evaluation_context(db, case["card_id"])
        return evaluate(ctx, timing=await card_timing(db, card, lesson)), lesson.settings_snapshot

    rules, settings = run_db(case["database_url"], expected)
    saved = case["stored"]()
    assert saved.rules_scores == {c.key: c.score for c in rules.criteria}
    assert saved.critical_flags == rules.critical_flags
    assert saved.explanation["call"]["evidence"] == next(
        c.evidence for c in rules.criteria if c.key == "call"
    )
    assert saved.total == pytest.approx(
        combine_scores(
            rules.total, bool(rules.critical_flags), settings["critical_cap"], saved.llm_scores
        )
        if saved.llm_scores
        else rules.total,
        abs=1e-12,
    )
    return saved


def install_preserved_layers(case):
    client = case["client"]
    result = client.post(
        "/api/overrides",
        headers=login(client),
        json={
            "evaluation_id": str(case["evaluation_id"]),
            "decision": "disagree",
            "new_total": 0.91,
            "reason": "Проверено преподавателем",
            "teacher_comment": "Сохранить решение",
        },
    )
    assert result.status_code == 201, result.text
    case["headers"] = login(client, "trainee01")

    async def augment(db):
        saved = await db.get(Evaluation, case["evaluation_id"])
        # Слой семантики сейчас выключен: проверяем сохранение ранее записанного результата.
        saved.semantic_scores = {"semantic_review": 0.654321}
        saved.explanation = {
            **saved.explanation,
            "semantic_review": {"explanation": "Сохранить.", "evidence": ["Факт."]},
        }
        saved.model_info = {**saved.model_info, "semantic": "stored:test"}

    run_db(case["database_url"], augment)
    return preserved(case)


def preserved(case):
    async def read(db):
        override = await db.scalar(
            select(TeacherOverride).where(TeacherOverride.evaluation_id == case["evaluation_id"])
        )
        audit = await db.scalar(
            select(AuditLog).where(
                AuditLog.action == "createOverride", AuditLog.entity_id == str(override.id)
            )
        )
        prediction = await db.get(Prediction, case["prediction_id"])
        return {
            "override": columns(override),
            "audit": columns(audit),
            "prediction": columns(prediction),
        }

    return run_db(case["database_url"], read)


def assert_no_replacement(case, before, immutable):
    after = case["stored"]()
    for key in (
        "id",
        "version",
        "created_at",
        "status",
        "model_info",
        "semantic_scores",
        "llm_scores",
    ):
        assert getattr(after, key) == getattr(before, key), key
    for key in set(before.semantic_scores or {}) | set(before.llm_scores or {}):
        assert (key in after.explanation) == (key in before.explanation)
        assert after.explanation.get(key) == before.explanation.get(key)
    assert preserved(case) == immutable

    async def counts(db):
        evaluations = list(
            await db.scalars(select(Evaluation.id).where(Evaluation.card_id == case["card_id"]))
        )
        jobs = list(
            await db.scalars(
                select(Job.id).where(Job.payload["evaluation_id"].astext == str(after.id))
            )
        )
        overrides = list(
            await db.scalars(
                select(TeacherOverride.id).where(TeacherOverride.evaluation_id == after.id)
            )
        )
        return len(evaluations), len(jobs), len(overrides)

    assert run_db(case["database_url"], counts) == (1, 1, 1)
    view = case["client"].get(f"/api/evaluations/{after.id}")
    assert view.status_code == 200, view.text
    assert view.json()["total"] == 0.91 and view.json()["teacher_comment"] == "Сохранить решение"
    assert (
        next(c["score"] for c in view.json()["criteria"] if c["key"] == "call")
        == after.rules_scores["call"]
    )


@pytest.mark.parametrize("worker_order", ["before_hold", "before_expiry", "after_expiry"])
@pytest.mark.parametrize("judged", [True, False])
@pytest.mark.parametrize(
    ("terminal_case", "choices", "score"),
    [
        (None, None, 2 / 3),
        (None, [], 2 / 3),
        (None, ["no_change"], 2 / 3),
        (["no_change"], ["no_change", "full"], 1),
        (["full"], [], 2 / 3),
        (["full"], None, 1),
    ],
    indirect=["terminal_case"],
)
def test_late_hold_refreshes_existing_evaluation(
    terminal_case, choices, score, worker_order, judged
):
    case = terminal_case
    judge = Judge() if judged else NullJudge()
    if worker_order == "before_hold":
        run_worker(case, judge)
    immutable = install_preserved_layers(case)
    before = case["stored"]()
    body = event("call_hold", {"call_id": case["call_id"].upper(), **snapshot(choices)})
    response = case["client"].post(case["url"], headers=case["headers"], json=body)
    assert response.status_code == 200, response.text
    after = assert_current_rules(case)
    assert after.rules_scores["call"] == pytest.approx(score)
    assert_no_replacement(case, before, immutable)
    for _ in range(2):
        response = case["client"].post(case["url"], headers=case["headers"], json=body)
        assert response.status_code == 200 and response.json()["duplicate"] is True
    assert columns(case["stored"]()) == columns(after)
    collision = {**body, "payload": {**body["payload"], "voice_failures": 10}}
    assert (
        case["client"].post(case["url"], headers=case["headers"], json=collision).status_code == 409
    )
    send(case["client"], case["headers"], case["card_id"], "call_hold", body["payload"], 409)
    if worker_order == "before_expiry":
        run_worker(case, judge)
    assert_current_rules(case)
    assert preserved(case) == immutable
    before_expiry = case["stored"]()
    at = datetime.fromisoformat(response.json()["server_ts"].replace("Z", "+00:00"))
    worker_tick(case["database_url"], at + timedelta(seconds=180))
    assert_current_rules(case)
    assert_no_replacement(case, before_expiry, immutable)
    assert case["client"].get(f"/api/calls/{case['call_id']}").json()["state"] == "ended"
    settled = columns(case["stored"]())
    worker_tick(case["database_url"], at + timedelta(seconds=250))
    assert columns(case["stored"]()) == settled
    retry = case["client"].post(case["url"], headers=case["headers"], json=body)
    assert retry.status_code == 200 and retry.json()["duplicate"] is True
    assert columns(case["stored"]()) == settled
    if worker_order == "after_expiry":
        run_worker(case, judge)
    assert_current_rules(case)
    assert case["stored"]().status == ("complete" if judged else "partial")
    assert preserved(case) == immutable
    if judged:
        assert len(judge.requests) == 1


@pytest.mark.parametrize("worker_first", [True, False])
@pytest.mark.parametrize("judged", [True, False])
@pytest.mark.parametrize(
    ("terminal_case", "choices"),
    [
        (None, None),
        (None, []),
        (None, ["no_change"]),
        (["no_change"], ["no_change", "full"]),
    ],
    indirect=["terminal_case"],
)
def test_expiry_refreshes_already_persisted_late_hold(
    terminal_case, choices, worker_first, judged, monkeypatch
):
    from app.api.cards.schemas import CardEvent as EventInput
    from app.api.evaluations import service as evaluations

    case = terminal_case
    judge = Judge() if judged else NullJudge()
    if worker_first:
        run_worker(case, judge)
    immutable = install_preserved_layers(case)
    before = case["stored"]()
    body = EventInput(event("call_hold", {"call_id": case["call_id"], **snapshot(choices)})).root
    at = datetime.fromisoformat(body["client_ts"])

    async def persisted_hold(db):
        # Уже принятый старым API hold: не обновляем append-only историю и не имитируем SQL.
        # После развёртывания исправления его может первым увидеть серверный expiry.
        db.add(
            CardEvent(
                card_id=case["card_id"],
                actor_id=case["trainee_id"],
                client_event_id=UUID(body["client_event_id"]),
                client_ts=at,
                server_ts=at,
                clock_offset_ms=0,
                type="call_hold",
                payload=body["payload"],
            )
        )

    run_db(case["database_url"], persisted_hold)
    emitted = []
    original = evaluations.notify

    async def record(db, kind, entity_id):
        emitted.append((kind, entity_id))
        await original(db, kind, entity_id)

    monkeypatch.setattr(evaluations, "notify", record)
    worker_tick(case["database_url"], at + timedelta(seconds=179.999))
    assert columns(case["stored"]()) == columns(before)
    assert emitted == []
    worker_tick(case["database_url"], at + timedelta(seconds=180))
    after = assert_current_rules(case)
    assert_no_replacement(case, before, immutable)
    assert emitted == [("evaluation." + after.status, after.id)]

    async def call_row(db):
        return await db.get(Call, UUID(case["call_id"]))

    call = run_db(case["database_url"], call_row)
    assert call.end_reason == "hold_timeout" and call.ended_at == at + timedelta(seconds=180)
    worker_tick(case["database_url"], at + timedelta(seconds=250))
    assert columns(case["stored"]()) == columns(after)
    assert emitted == [("evaluation." + after.status, after.id)]
    assert [
        e["payload"]
        for e in case["client"].get(case["url"]).json()
        if e["client_event_id"] == body["client_event_id"]
    ] == [body["payload"]]
    if not worker_first:
        run_worker(case, judge)
    assert_current_rules(case)
    assert preserved(case) == immutable
    if judged:
        assert len(judge.requests) == 1


@pytest.mark.parametrize("terminal_case", [["no_change"]], indirect=True)
@pytest.mark.parametrize("mutation", ["hold", "expiry"])
@pytest.mark.parametrize("winner", ["worker", "mutation"])
def test_worker_serializes_with_hold_and_expiry(terminal_case, monkeypatch, mutation, winner):
    import asyncio
    import time
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from app.api.cards import service as cards
    from app.api.evaluations import service as evaluations
    from app.worker.jobs import handlers
    from sqlalchemy import text

    case = terminal_case
    judge = Judge()
    immutable = install_preserved_layers(case)
    before = case["stored"]()
    body = event("call_hold", {"call_id": case["call_id"], **snapshot(["no_change", "full"])})

    def hold():
        response = case["client"].post(case["url"], headers=case["headers"], json=body)
        assert response.status_code == 200, response.text
        return datetime.fromisoformat(response.json()["server_ts"].replace("Z", "+00:00"))

    if mutation == "expiry":
        at = hold()

    def mutate():
        if mutation == "hold":
            hold()
        else:
            worker_tick(case["database_url"], at + timedelta(seconds=180))

    reached, release = Event(), Event()
    target = handlers if winner == "worker" else cards if mutation == "hold" else evaluations
    method = "notify" if winner == "worker" else "refresh_terminal_rules"
    original = getattr(target, method)

    async def gated(*args, **kwargs):
        result = await original(*args, **kwargs)
        reached.set()
        assert await asyncio.to_thread(release.wait, 15), "Победитель не отпущен"
        return result

    monkeypatch.setattr(target, method, gated)

    async def blocked(db):
        return await db.scalar(
            text(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() "
                "AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid)) > 0"
            )
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(run_worker, case, judge) if winner == "worker" else pool.submit(mutate)
        try:
            assert reached.wait(10), "Первый участник не взял обычные транзакционные блокировки"
            second = (
                pool.submit(mutate) if winner == "worker" else pool.submit(run_worker, case, judge)
            )
            deadline = time.monotonic() + 5
            while not run_db(case["database_url"], blocked) and time.monotonic() < deadline:
                time.sleep(0.02)
            # Доказываем ожидание PostgreSQL, а не только одновременный запуск двух функций.
            assert run_db(case["database_url"], blocked) > 0
            assert not second.done()
        finally:
            release.set()
        first.result(timeout=15)
        second.result(timeout=15)
    final = assert_current_rules(case)
    assert final.id == before.id and final.version == before.version
    assert final.rules_scores["call"] == 1 and final.status == "complete"
    assert preserved(case) == immutable
    assert len(judge.requests) == 1
    if mutation == "expiry":
        assert case["client"].get(f"/api/calls/{case['call_id']}").json()["state"] == "ended"
