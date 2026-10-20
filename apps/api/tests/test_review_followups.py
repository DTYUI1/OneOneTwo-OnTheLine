"""Блокирующие замечания независимого ревью: серверные сквозные регрессии."""

from uuid import UUID, uuid4

import pytest
from app.core.models import Assignment
from sqlalchemy import select

from . import test_brigade_briefing as briefing_base
from . import test_c03_sessions as c03
from .test_c04_completion import seed_training
from .test_lifecycle import login, run_db

briefing_card = briefing_base.briefing_card


def test_tutorial_again_without_step_keeps_tutorial_path(database_client, database_url):
    seed_training(database_url)
    client = database_client
    headers = login(client, "trainee03")
    first = client.post("/api/practice", headers=headers)
    assert first.status_code == 200, first.text
    c03.tick(database_url)
    card = next(
        row for row in client.get("/api/cards").json() if row["session_id"] == first.json()["id"]
    )
    repeated = client.post(f"/api/practice?again={card['id']}", headers=headers)
    assert repeated.status_code == 200, repeated.text

    async def scenario_ids(db):
        return [
            await db.scalar(
                select(Assignment.scenario_id).where(Assignment.session_id == UUID(session_id))
            )
            for session_id in (first.json()["id"], repeated.json()["id"])
        ]

    original, again = run_db(database_url, scenario_ids)
    assert original == again
    assert repeated.json()["title"] == first.json()["title"]


@pytest.mark.parametrize("briefing_card", ["gas-apartment-101-1"], indirect=True)
@pytest.mark.parametrize("action", ["expire", "resume", "duplicate", "uppercase_resume"])
def test_hold_uuid_case_is_identity_without_rewriting_payload(briefing_card, database_url, action):
    from datetime import datetime, timedelta

    from .test_brigade_briefing import accept
    from .test_practice_gating import send, worker_tick

    client, headers, card, _ = briefing_card
    accept(client, headers, card)
    call_id = str(uuid4())
    send(client, headers, card["id"], "call_dial", {"call_id": call_id, "phone_ext": "103"})
    send(client, headers, card["id"], "call_answer", {"call_id": call_id})
    raw_id = call_id if action == "uppercase_resume" else call_id.upper()
    first = send(client, headers, card["id"], "call_hold", {"call_id": raw_id}).json()
    events = client.get(f"/api/cards/{card['id']}/events").json()
    assert next(row for row in events if row["type"] == "call_hold")["payload"] == {
        "call_id": raw_id
    }
    if action == "duplicate":
        response = send(client, headers, card["id"], "call_hold", {"call_id": call_id}, 409)
        assert response.json()["code"] == "hold_state"
    if action in {"resume", "uppercase_resume"}:
        resume_id = call_id.upper() if action == "uppercase_resume" else call_id
        send(client, headers, card["id"], "call_resume", {"call_id": resume_id})
    started = datetime.fromisoformat(first["server_ts"].replace("Z", "+00:00"))
    worker_tick(database_url, started + timedelta(seconds=180))
    assert client.get(f"/api/calls/{call_id}").json()["state"] == (
        "talking" if action in {"resume", "uppercase_resume"} else "ended"
    )


@pytest.mark.parametrize("briefing_card", ["smoke-apartment-101-1"], indirect=True)
@pytest.mark.parametrize("refusal", ["busy", "not_assigned"])
@pytest.mark.parametrize("mode", ["option", "voice"])
def test_old_delivery_cannot_be_answered_through_refused_call(
    briefing_card, database_url, refusal, mode
):
    from app.core.models import Call

    from .briefing_helpers import briefing_payload
    from .test_brigade_briefing import accept, dial
    from .test_live_brigade_flow import training, voice_reply
    from .test_practice_gating import send
    from .test_voice_report import FakeSTT

    client, headers, card, target = briefing_card
    accept(client, headers, card)
    original = dial(client, headers, card, target)
    send(client, headers, card["id"], "brigade_briefing", briefing_payload(card, original))
    question = next(
        m for m in training(client, card["id"])["messages"] if "reply_options" in m["delivery"]
    )
    send(client, headers, card["id"], "call_hangup", {"call_id": original})
    replacement = dial(client, headers, card, target)

    async def refuse(db):
        (await db.get(Call, UUID(replacement))).refusal = refusal

    run_db(database_url, refuse)
    delivery_id = question["delivery"]["delivery_id"]
    if mode == "voice":
        client.app.state.voice_report_stt = FakeSTT(
            "Нет, Бескудниковский бульвар, двадцать четыре", 0.8
        )
        response = voice_reply(client, headers, replacement, delivery_id)
        assert response.status_code == 409, response.text
    else:
        send(
            client,
            headers,
            card["id"],
            "brigade_reply",
            {
                "call_id": replacement,
                "delivery_id": delivery_id,
                "option_key": "fix",
                "mode": "option",
            },
            409,
        )
    events = client.get(f"/api/cards/{card['id']}/events").json()
    assert not any(row["type"] == "brigade_reply" for row in events)


REPORT_SNAPSHOT = {
    "report_choices": ["no_change", "full"],
    "report_modes": ["voice", "voice"],
    "voice_failures": 2,
    "report_parts": [["who", "address"], ["who", "address", "change"]],
    "report_loudness": ["quiet", "ok"],
    "registration_number": "12345",
}


@pytest.mark.parametrize("briefing_card", ["gas-apartment-101-1"], indirect=True)
def test_hold_report_snapshot_is_validated_and_journaled_exactly(briefing_card):
    from .test_brigade_briefing import accept
    from .test_lifecycle import event
    from .test_practice_gating import send

    client, headers, card, _ = briefing_card
    accept(client, headers, card)
    call_id = str(uuid4())
    send(client, headers, card["id"], "call_dial", {"call_id": call_id, "phone_ext": "103"})
    send(client, headers, card["id"], "call_answer", {"call_id": call_id})
    payload = {"call_id": call_id.upper(), **REPORT_SNAPSHOT}
    body = event("call_hold", payload)
    url = f"/api/cards/{card['id']}/events"
    response = client.post(url, json=body, headers=headers)
    assert response.status_code == 200, response.text
    duplicate = client.post(url, json=body, headers=headers)
    assert duplicate.status_code == 200, duplicate.text
    assert duplicate.json()["duplicate"] is True
    marks = [row for row in client.get(url).json() if row["type"] == "call_hold"]
    assert [row["payload"] for row in marks] == [payload]
    send(client, headers, card["id"], "call_resume", {"call_id": call_id})
    invalid = {
        "report_choices": ["invented"],
        "report_modes": ["invalid"],
        "voice_failures": -1,
        "report_parts": [["unknown"]],
        "report_loudness": ["invalid"],
        "registration_number": "not-a-number",
    }
    for field, value in invalid.items():
        malformed = {**payload, field: value}
        for kind in ("call_hold", "call_hangup"):
            send(client, headers, card["id"], kind, malformed, 422)
    assert len([row for row in client.get(url).json() if row["type"] == "call_hold"]) == 1


@pytest.fixture
def hold_report_scenario(briefing_card, database_url):
    """Expiry и оба адаптера читают один эталон, не затрагивая seed-сценарий."""
    from app.core.models import Card, Scenario

    from .test_review2_backend import isolated_scenario

    _, _, card, _ = briefing_card

    async def configure(db):
        row = await db.get(Card, UUID(card["id"]))
        assignment = await db.get(Assignment, row.assignment_id)
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
        return scenario.id, scenario.reference

    scenario_id, reference = run_db(database_url, configure)
    try:
        yield reference
    finally:

        async def retire(db):
            scenario = await db.get(Scenario, scenario_id)
            assert scenario.reference == reference
            scenario.status = "retired"

        run_db(database_url, retire)


@pytest.mark.parametrize("briefing_card", ["gas-apartment-101-1"], indirect=True)
@pytest.mark.parametrize("closed", [False, True])
@pytest.mark.parametrize("snapshot", [None, [], ["no_change"], ["no_change", "full"]])
def test_hold_timeout_retains_snapshot_through_real_scoring_context(
    briefing_card, hold_report_scenario, database_url, database_config, closed, snapshot
):
    from dataclasses import replace
    from datetime import UTC, datetime, timedelta

    from app.api.evaluations.service import evaluation_context
    from app.core.models import Call, Card
    from evalcore.criteria import CallCriterion, _call_reports

    from .test_brigade_briefing import accept
    from .test_practice_gating import send, worker_tick

    client, headers, card, _ = briefing_card
    accept(client, headers, card)
    call_id = str(uuid4())
    send(client, headers, card["id"], "call_dial", {"call_id": call_id, "phone_ext": "103"})
    send(client, headers, card["id"], "call_answer", {"call_id": call_id})
    report = (
        {}
        if snapshot is None
        else {
            **REPORT_SNAPSHOT,
            "report_choices": snapshot,
            "report_modes": REPORT_SNAPSHOT["report_modes"][: len(snapshot)],
            "report_parts": REPORT_SNAPSHOT["report_parts"][: len(snapshot)],
            "report_loudness": REPORT_SNAPSHOT["report_loudness"][: len(snapshot)],
        }
    )
    held = send(
        client,
        headers,
        card["id"],
        "call_hold",
        {
            "call_id": call_id.upper(),
            **report,
        },
    ).json()
    started = datetime.fromisoformat(held["server_ts"].replace("Z", "+00:00"))
    if closed:

        async def close(db):
            from app.api.evaluations.service import evaluate_terminal_card

            row = await db.get(Card, UUID(card["id"]))
            row.state, row.closed_at = "completed", datetime.now(UTC)
            evaluation = await evaluate_terminal_card(db, row.id)
            assert evaluation.rules_scores["call"] == pytest.approx(
                1 if snapshot and "full" in snapshot else 2 / 3
            )

        run_db(database_url, close)
    worker_tick(database_url, started + timedelta(seconds=180))
    worker_tick(database_url, started + timedelta(seconds=250))

    async def context(db):
        ctx, *_ = await evaluation_context(db, UUID(card["id"]))
        call = await db.get(Call, UUID(call_id))
        assert call.end_reason == "hold_timeout"
        assert call.ended_at == started + timedelta(seconds=180)
        assert ctx.scenario["reference"] == hold_report_scenario
        return ctx

    ctx = run_db(database_url, context)
    # План сообщений не участвует в этой проверке; эталон остаётся из БД.
    ctx = replace(ctx, planned_messages=())
    saved = _call_reports(ctx).get(call_id)
    assert saved is not None, "Современный timeout не должен получать legacy credit"
    assert saved.choices == (snapshot or [])
    if snapshot:
        assert saved.parts == [tuple(p) for p in report["report_parts"]]
        assert saved.loudness == report["report_loudness"]
        assert saved.voice_failures == 2
    assert ctx.calls[0]["end_reason"] == "hold_timeout"
    if snapshot is not None:
        from evalcore.comment import _answered_at, registrations

        assert registrations(ctx) == [("103", "12345")]
        assert _answered_at(ctx)["12345"].isoformat() == ctx.calls[0]["answered_at"]
    result = CallCriterion().evaluate(ctx)
    assert result.score == pytest.approx(1 if snapshot and "full" in snapshot else 2 / 3)
    if snapshot == ["no_change"]:
        assert any("полного доклада нет" in line for line in result.evidence)
    elif not snapshot:
        assert result.critical
    late = send(
        client,
        headers,
        card["id"],
        "call_hangup",
        {
            "call_id": call_id,
            **REPORT_SNAPSHOT,
        },
        409,
    )
    assert late.json()["code"] == "call_ended"
    assert _call_reports(run_db(database_url, context))[call_id] == saved
    if closed:
        from app.api.evaluations.service import evaluate_terminal_card
        from app.worker.runtime import Worker

        async def evaluate_both_adapters(db):
            worker = Worker(database_config)
            try:
                evaluation = await evaluate_terminal_card(db, UUID(card["id"]))
                assert evaluation.rules_scores["call"] == pytest.approx(result.score)
                payload = {"card_id": card["id"], "evaluation_id": str(evaluation.id)}
                await worker.handlers.handle_evaluate(db, payload)
                await worker.handlers.handle_evaluate(db, payload)
                assert evaluation.rules_scores["call"] == pytest.approx(result.score)
                assert evaluation.explanation["call"]["evidence"] == result.evidence
            finally:
                await worker.close()

        run_db(database_url, evaluate_both_adapters)


@pytest.mark.parametrize(
    "events, reason, choices",
    [
        ([], None, None),
        ([("call_hangup", {})], None, None),
        ([], "hold_timeout", []),
        ([("call_hold", {})], None, []),
        ([("call_hold", {"report_choices": []})], "hold_timeout", []),
        (
            [
                ("call_hold", {"report_choices": ["no_change"]}),
                ("call_resume", {}),
                ("call_hold", {}),
            ],
            "hold_timeout",
            ["no_change"],
        ),
        (
            [
                ("call_hold", {"report_choices": ["no_change"]}),
                ("call_resume", {}),
                ("call_hold", {"report_choices": ["full"]}),
            ],
            "hold_timeout",
            ["full"],
        ),
        (
            [
                ("call_hold", {"report_choices": ["full"]}),
                ("call_resume", {}),
                ("call_hold", {"report_choices": []}),
            ],
            "hold_timeout",
            [],
        ),
        (
            [
                ("call_hold", {"report_choices": ["no_change"]}),
                ("call_hangup", {"report_choices": ["full"]}),
            ],
            None,
            ["full"],
        ),
        ([("call_hold", {"report_choices": ["full"]}), ("call_hangup", {})], None, ["full"]),
    ],
)
def test_report_snapshots_are_cumulative_and_legacy_is_not_timeout(events, reason, choices):
    from evalcore.criteria import CallCriterion, _call_reports
    from evalcore.models import EvalContext

    call_id = str(uuid4())
    at = "2026-09-01T10:00:00+00:00"
    ctx = EvalContext(
        scenario={
            "reference": {
                "expected_call": {
                    "required": True,
                    "service_id": "103",
                    "phone_ext": "103",
                    "before_s": 30,
                }
            }
        },
        current={},
        settings={"weights": {"call": 1}},
        calls=[
            {
                "id": call_id,
                "service_id": "103",
                "phone_ext": "103",
                "started_at": at,
                "answered_at": at,
                "end_reason": reason,
            }
        ],
        events=[{"type": "deliver", "client_ts": at, "server_ts": at, "payload": {}}]
        + [
            {"type": kind, "payload": {"call_id": call_id.upper(), **payload}}
            for kind, payload in events
        ],
    )
    report = _call_reports(ctx).get(call_id)
    if choices is None:
        assert report is None
    else:
        assert report is not None and report.choices == choices
    result = CallCriterion().evaluate(ctx)
    from evalcore.defaults import REPORT_CHOICE_FACTOR

    reported = 1 if choices is None else REPORT_CHOICE_FACTOR if "full" in choices else 0
    assert result.score == pytest.approx((2 + reported) / 3)


@pytest.mark.parametrize("briefing_card", ["gas-apartment-101-1"], indirect=True)
@pytest.mark.parametrize("winner", ["expiry", "hangup"])
def test_expiry_and_local_hangup_serialize_and_preserve_report(
    briefing_card, database_url, monkeypatch, winner
):
    import asyncio
    from concurrent.futures import ThreadPoolExecutor, TimeoutError
    from datetime import datetime, timedelta
    from threading import Event

    from app.api.cards import service
    from app.api.evaluations.service import evaluation_context
    from app.api.training import holds
    from app.core.models import Call
    from evalcore.criteria import _call_reports

    from .test_brigade_briefing import accept
    from .test_lifecycle import event
    from .test_practice_gating import send, worker_tick

    client, headers, card, _ = briefing_card
    accept(client, headers, card)
    call_id = str(uuid4())
    send(client, headers, card["id"], "call_dial", {"call_id": call_id, "phone_ext": "103"})
    send(client, headers, card["id"], "call_answer", {"call_id": call_id})
    held = send(
        client,
        headers,
        card["id"],
        "call_hold",
        {
            "call_id": call_id,
            "report_choices": ["no_change"],
        },
    ).json()
    at = datetime.fromisoformat(held["server_ts"].replace("Z", "+00:00"))
    reached, release = Event(), Event()
    original = holds.notify if winner == "expiry" else service.apply_call

    async def gated(*args, **kwargs):
        result = await original(*args, **kwargs)
        reached.set()
        assert await asyncio.to_thread(release.wait, 10), "Не отпущена транзакция гонки"
        return result

    monkeypatch.setattr(
        holds if winner == "expiry" else service,
        "notify" if winner == "expiry" else "apply_call",
        gated,
    )
    body = event("call_hangup", {"call_id": call_id, **REPORT_SNAPSHOT})
    url = f"/api/cards/{card['id']}/events"

    def hangup():
        return client.post(url, json=body, headers=headers)

    def expire():
        return worker_tick(database_url, at + timedelta(seconds=180))

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(expire if winner == "expiry" else hangup)
        try:
            assert reached.wait(10), "Первый участник гонки не взял блокировки"
            second = pool.submit(hangup if winner == "expiry" else expire)
            if winner == "expiry":
                # HTTP не может завершиться, пока worker держит блокировку занятия.
                with pytest.raises(TimeoutError):
                    second.result(timeout=0.1)
        finally:
            release.set()
        first_result, second_result = first.result(timeout=20), second.result(timeout=20)
    response = second_result if winner == "expiry" else first_result
    assert response.status_code == (409 if winner == "expiry" else 200), response.text
    worker_tick(database_url, at + timedelta(seconds=250))

    async def inspect(db):
        call = await db.get(Call, UUID(call_id))
        ctx, *_ = await evaluation_context(db, UUID(card["id"]))
        return call.end_reason, call.ended_at, _call_reports(ctx)[call_id]

    reason, ended_at, saved = run_db(database_url, inspect)
    assert reason == ("hold_timeout" if winner == "expiry" else None)
    assert saved.choices == (["no_change"] if winner == "expiry" else ["no_change", "full"])
    if winner == "expiry":
        assert ended_at == at + timedelta(seconds=180)
        assert response.json()["code"] == "call_ended"
    else:
        replay = client.post(url, json=body, headers=headers)
        assert replay.status_code == 200 and replay.json()["duplicate"] is True
    assert len([row for row in client.get(url).json() if row["type"] == "call_hangup"]) == (
        0 if winner == "expiry" else 1
    )
