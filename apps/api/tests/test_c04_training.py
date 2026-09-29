"""PostgreSQL: C-04 отделяет выдачу, реальное подтверждение и сбой playback."""

import asyncio
import hashlib
import io
import wave
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.api.evaluations.service import planned_messages
from app.api.training.audio import register_asset
from app.api.training.content import plan_for_assignment, store_plan
from app.api.training.gating import card_plan
from app.core.contracts import validate_json
from app.core.db import Database
from app.core.models import (
    Assignment,
    Call,
    Card,
    MessageDelivery,
    MessagePresentation,
    Scenario,
    ScenarioTrainingPlan,
    User,
)
from app.worker.training import TrainingScheduler
from fastapi.testclient import TestClient
from sqlalchemy import func, select, update
from sqlalchemy.exc import DBAPIError

from . import test_c03_sessions as c03
from .test_lifecycle import event as legacy_event
from .test_lifecycle import login, run_db

lesson = c03.lesson


def event(kind, payload):
    body = legacy_event(kind, payload)
    body["client_ts"] = body["client_ts"].replace("+00:00", "Z")
    return body


@pytest.fixture
def training_case(lesson, database_config, database_url, tmp_path, request):
    service_id = lesson.scenarios[0]["target_service_id"]
    # С одним происшествием у обучаемого доступны две первые бригады (training/brigades.py).
    brigades = lesson.client.get(f"/api/services/{service_id}/brigades").json()[:2]
    targets = lesson.client.get(f"/api/services/{service_id}/call-targets").json()
    brigade = brigades[0]
    target = next(t for t in targets if t["brigade_id"] == brigade["id"])
    wrong_target = next(t for t in targets if t["brigade_id"] == brigades[1]["id"])
    stream = io.BytesIO()
    with wave.open(stream, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b"\x00\x00" * 800)
    audio_bytes = stream.getvalue()
    (tmp_path / "message.wav").write_bytes(audio_bytes)
    audio_id = uuid4()
    delay = getattr(request, "param", 0)
    plan = {
        "version": 1,
        "required_brigade_ids": [brigade["id"]],
        "messages": [],
        "observable_defects": [],
    }
    for index in range(2):
        plan["messages"].append(
            {
                "message": {
                    "id": str(uuid4()),
                    "version": 1,
                    "text": f"Учебные сведения {index + 1}",
                    "audio": None
                    if index == 0
                    else {
                        "asset_id": str(audio_id),
                        "version": 1,
                        "sha256": hashlib.sha256(audio_bytes).hexdigest(),
                        "url": f"/api/materials/{audio_id}/content?version=1",
                        "duration_ms": 100,
                    },
                },
                "brigade_id": brigade["id"],
                "call_target_id": target["id"],
                "available_after_s": delay,
                "expected_comment": "СЕКРЕТНЫЙ ЭТАЛОН",
            }
        )
    plan["observable_defects"] = [
        {
            "key": "test-defect",
            "evidence_source": "message",
            "message_id": plan["messages"][0]["message"]["id"],
            "explanation": "СЕКРЕТНАЯ ПОДСКАЗКА",
        }
    ]

    async def prepare(db):
        teacher = await db.scalar(select(User).where(User.login == "teacher"))
        await register_asset(
            db,
            tmp_path,
            asset_id=audio_id,
            version=1,
            relative_path="message.wav",
            duration_ms=100,
            media_type="audio/wav",
        )
        await store_plan(
            db, UUID(lesson.scenarios[0]["id"]), lesson.scenarios[0]["version"], teacher.id, plan
        )

    run_db(database_url, prepare)
    c03.batch(lesson, [c03.item(lesson), c03.item(lesson, participant=1)])
    c03.start(lesson)
    c03.tick(database_url)
    config = database_config.model_copy(update={"information_audio_dir": tmp_path})
    with TestClient(create_database_app(config)) as trainee:
        headers = login(trainee, "trainee01")
        card = next(c for c in trainee.get("/api/cards").json() if c["session_id"] == lesson.id)
        case = SimpleNamespace(
            lesson=lesson,
            client=trainee,
            headers=headers,
            card=card,
            brigade=brigade,
            brigades=brigades,
            target=target,
            wrong_target=wrong_target,
            targets=targets,
            url=database_url,
            plan=plan,
            audio_bytes=audio_bytes,
            directory=tmp_path,
            config=config,
        )
        send(case, "deliver", {})
        # Бригаду направляют после решения реагировать (памятка ДДС, стр. 21).
        send(case, "status_change", {"state": "accepted", "comment": "Принята"})
        yield case


def send(case, kind, payload, expected=200, body=None):
    response = case.client.post(
        f"/api/cards/{case.card['id']}/events",
        json=body or event(kind, payload),
        headers=case.headers,
    )
    assert response.status_code == expected, response.text
    return response


def training(case):
    response = case.client.get(f"/api/cards/{case.card['id']}/training")
    assert response.status_code == 200, response.text
    result = response.json()
    validate_json(result, "urn:openapi#/components/schemas/CardTraining")
    assert "СЕКРЕТ" not in response.text
    assert "private/teacher-only-path" not in response.text
    return result


def select_and_dial(case, *, answer=True, target=None):
    target = target or case.target
    send(case, "brigades_select", {"brigade_ids": [b["id"] for b in case.brigades]})
    call_id = str(uuid4())
    send(
        case,
        "call_dial_target",
        {"call_id": call_id, "call_target_id": target["id"], "brigade_id": target["brigade_id"]},
    )
    if answer:
        send(case, "call_answer", {"call_id": call_id})
    return call_id


def call_refusal(case, call_id):
    async def read(db):
        return (await db.get(Call, UUID(call_id))).refusal

    return run_db(case.url, read)


def worker_tick(case):
    async def run():
        database = Database(case.url)
        try:
            return await TrainingScheduler(database.sessions).tick()
        finally:
            await database.close()

    return asyncio.run(run())


def playback(delivery, *, audio=False, playback_id=None):
    return {
        "delivery_id": delivery["delivery_id"],
        "playback_id": playback_id or str(uuid4()),
        "message_version": delivery["message"]["version"],
        "audio_version": delivery["message"]["audio"]["version"] if audio else None,
        "channel": "audio" if audio else "text",
    }


def test_manual_selection_target_resolution_and_no_plan_leak(training_case):
    case = training_case
    assert training(case)["messages"] == []
    assert training(case)["selected_brigade_ids"] == []
    for brigade_ids in [[], [case.brigade["id"]] * 2, [str(uuid4())]]:
        send(case, "brigades_select", {"brigade_ids": brigade_ids}, expected=422)
    foreign_service = "103" if case.target["service_id"] != "103" else "102"
    foreign = case.client.get(f"/api/services/{foreign_service}/brigades").json()[0]
    send(case, "brigades_select", {"brigade_ids": [foreign["id"]]}, expected=422)
    dial = {
        "call_id": str(uuid4()),
        "call_target_id": case.target["id"],
        "brigade_id": case.brigade["id"],
    }
    # Номер ненаправленной бригады не запрещён: она отвечает отказом и не докладывает.
    refused = {**dial, "call_id": str(uuid4())}
    send(case, "call_dial_target", refused)
    send(case, "call_answer", {"call_id": refused["call_id"]})
    assert call_refusal(case, refused["call_id"]) == "not_assigned"
    assert training(case)["messages"] == []
    send(case, "brigades_select", {"brigade_ids": [case.brigade["id"]]})
    # Направили во время отказного разговора — в нём доклада всё равно нет.
    assert worker_tick(case) == 0
    assert training(case)["messages"] == []
    send(case, "call_hangup", {"call_id": refused["call_id"]})
    send(case, "call_dial_target", {**dial, "brigade_id": None}, expected=422)
    send(case, "call_dial_target", dial)
    assert call_refusal(case, dial["call_id"]) is None
    call = case.client.get(f"/api/calls/{dial['call_id']}").json()
    assert call["phone_ext"] == case.target["phone_ext"]
    assert call["service_id"] == case.target["service_id"]
    assert training(case)["messages"] == []
    send(case, "call_answer", {"call_id": dial["call_id"]})
    assert len(training(case)["messages"]) == 2
    send(case, "brigades_select", {"brigade_ids": [case.brigades[1]["id"]]})
    assert training(case)["selected_brigade_ids"] == [case.brigades[1]["id"]]
    assert len(training(case)["messages"]) == 2
    assert "СЕКРЕТ" not in case.client.get(f"/api/cards/{case.card['id']}").text


def test_legacy_assignment_keeps_reports_after_scenario_retirement(training_case):
    case = training_case

    async def legacy_assignment(db):
        card = await db.get(Card, UUID(case.card["id"]))
        assignment = await db.get(Assignment, card.assignment_id)
        assignment.scenario_version = None

    run_db(case.url, legacy_assignment)
    teacher_headers = login(case.client, "teacher")
    retired = case.client.post(
        f"/api/scenarios/{case.lesson.scenarios[0]['id']}/retire", headers=teacher_headers
    )
    assert retired.status_code == 200, retired.text
    assert retired.json()["version"] == case.lesson.scenarios[0]["version"] + 1
    case.headers = login(case.client, "trainee01")

    async def verify(db):
        card = await db.get(Card, UUID(case.card["id"]))
        assignment = await db.get(Assignment, card.assignment_id)
        scenario = await db.get(Scenario, assignment.scenario_id)
        plan = await plan_for_assignment(db, assignment, scenario)
        assert plan is not None
        assert plan.scenario_version == case.lesson.scenarios[0]["version"]
        assert await card_plan(db, card) == case.plan["messages"]
        assert len(await planned_messages(db, card, assignment, scenario)) == 2

    run_db(case.url, verify)
    select_and_dial(case)
    assert len(training(case)["messages"]) == 2


def test_undispatched_brigade_and_unbound_target_do_not_issue_messages(training_case):
    case = training_case
    # Направлена только бригада плана; вторая на звонок отвечает отказом и не докладывает.
    send(case, "brigades_select", {"brigade_ids": [case.brigade["id"]]})
    call_id = str(uuid4())
    send(
        case,
        "call_dial_target",
        {
            "call_id": call_id,
            "call_target_id": case.wrong_target["id"],
            "brigade_id": case.wrong_target["brigade_id"],
        },
    )
    send(case, "call_answer", {"call_id": call_id})
    assert call_refusal(case, call_id) == "not_assigned"
    assert training(case)["messages"] == []
    send(case, "call_hangup", {"call_id": call_id})
    unbound = next(t for t in case.targets if t["brigade_id"] is None)
    select_and_dial(case, target=unbound)
    assert training(case)["messages"] == []


def test_first_dispatched_brigade_on_the_line_keeps_the_plan_role(training_case):
    # Направлены обе бригады, первой на связь вышла не бригада плана: доклады идут от
    # неё — бригада плана, направленная вместе с ней, роль не перехватывает (ревью 28.09).
    case = training_case
    select_and_dial(case, target=case.wrong_target)
    messages = training(case)["messages"]
    assert len(messages) == len(case.plan["messages"])
    assert {item["delivery"]["brigade_id"] for item in messages} == {
        case.wrong_target["brigade_id"]
    }


@pytest.mark.parametrize("training_case", [10], indirect=True)
def test_delayed_delivery_and_two_workers_keep_one_delivery(training_case):
    case = training_case
    call_id = select_and_dial(case, answer=False)

    async def run():
        database = Database(case.url)
        try:
            assert await TrainingScheduler(database.sessions).tick() == 0
        finally:
            await database.close()

    asyncio.run(run())
    send(case, "call_answer", {"call_id": call_id})
    assert training(case)["messages"] == []

    async def advance(db):
        call = await db.get(Call, UUID(call_id))
        return call.answered_at

    answered_at = run_db(case.url, advance)

    async def ticks():
        database = Database(case.url)
        try:
            scheduler = TrainingScheduler(database.sessions)
            assert await scheduler.tick(answered_at + timedelta(seconds=9)) == 0
            counts = await asyncio.gather(
                scheduler.tick(answered_at + timedelta(seconds=10)),
                scheduler.tick(answered_at + timedelta(seconds=10)),
            )
            assert sum(counts) == 2
            assert (
                await TrainingScheduler(database.sessions).tick(answered_at + timedelta(seconds=20))
                == 0
            )
        finally:
            await database.close()

    asyncio.run(ticks())
    first = training(case)
    assert len(first["messages"]) == 2
    assert all(m["state"] == "delivered" and m["presented_at"] is None for m in first["messages"])
    assert training(case) == first


def test_failure_success_repeat_and_conflict_journal(training_case):
    case = training_case
    select_and_dial(case)
    delivered = next(
        m["delivery"] for m in training(case)["messages"] if m["delivery"]["message"]["audio"]
    )
    receipt = playback(delivered, audio=True)
    failure = {k: v for k, v in receipt.items() if k != "channel"} | {"reason": "interrupted"}
    failed_event = event("message_failed", failure)
    send(case, "message_failed", failure, body=failed_event)
    state = next(m for m in training(case)["messages"] if m["delivery"] == delivered)
    assert state["state"] == "failed" and state["presented_at"] is None
    assert state["presentation_event_id"] is None and state["failure_reason"] == "interrupted"
    assert send(case, "message_failed", failure, body=failed_event).json()["duplicate"] is True
    send(case, "message_presented", receipt, expected=409)
    success_payload = playback(delivered, audio=True)
    accepted_event = event("message_presented", success_payload)
    send(case, "message_presented", success_payload, body=accepted_event)
    presented = next(m for m in training(case)["messages"] if m["delivery"] == delivered)
    assert presented["state"] == "presented"
    assert presented["presentation_event_id"] == accepted_event["client_event_id"]
    assert presented["failed_at"] is None and presented["failure_reason"] is None
    # Retry playback с новым event ID не создаёт второй факт предъявления.
    before = training(case)
    send(case, "message_presented", success_payload)
    assert training(case) == before
    send(case, "message_presented", playback(delivered, audio=True))
    send(
        case, "message_failed", {**failure, "playback_id": str(uuid4()), "reason": "playback_error"}
    )
    assert next(m for m in training(case)["messages"] if m["delivery"] == delivered) == presented

    async def verify(db):
        presentations = list(
            await db.scalars(
                select(MessagePresentation).where(
                    MessagePresentation.delivery_id == UUID(delivered["delivery_id"])
                )
            )
        )
        assert len(presentations) == 4
        assert len([p for p in presentations if p.kind == "message_presented"]) == 2
        for table in [MessagePresentation, MessageDelivery, ScenarioTrainingPlan]:
            with pytest.raises(DBAPIError):
                async with db.begin_nested():
                    if table is ScenarioTrainingPlan:
                        await db.execute(update(table).values(plan={}))
                    elif table is MessageDelivery:
                        await db.execute(update(table).values(message={}))
                    else:
                        await db.execute(update(table).values(kind="message_failed"))

    run_db(case.url, verify)


def test_audio_version_hash_access_and_download_is_not_presentation(training_case):
    case = training_case
    select_and_dial(case)
    message = next(m for m in training(case)["messages"] if m["delivery"]["message"]["audio"])
    url = message["delivery"]["message"]["audio"]["url"]
    response = case.client.get(url)
    assert response.status_code == 200 and response.content == case.audio_bytes
    assert "audio/wav" in response.headers["content-type"]
    assert (
        next(m for m in training(case)["messages"] if m["delivery"] == message["delivery"])
        == message
    )
    assert case.client.get(url.replace("version=1", "version=2")).status_code == 409
    assert case.client.get(url.replace("version=1", "version=0")).status_code == 422
    (case.directory / "message.wav").write_bytes(b"changed")
    assert case.client.get(url).status_code == 409
    (case.directory / "message.wav").unlink()
    assert case.client.get(url).status_code == 404
    (case.directory / "message.wav").write_bytes(case.audio_bytes)
    login(case.client, "trainee02")
    assert case.client.get(url).status_code == 404
    assert case.client.get(f"/api/cards/{case.card['id']}/training").status_code == 404
    login(case.client, "teacher")
    assert case.client.get(url).status_code == 200


@pytest.mark.parametrize(
    "patch",
    [
        {"message_version": 2},
        {"audio_version": 2},
        {"channel": "audio", "audio_version": None},
        {"channel": "text", "audio_version": 1},
    ],
)
def test_presentation_rejects_wrong_versions_and_channels(training_case, patch):
    case = training_case
    select_and_dial(case)
    delivery = next(
        m["delivery"] for m in training(case)["messages"] if m["delivery"]["message"]["audio"]
    )
    send(case, "message_presented", {**playback(delivery, audio=True), **patch}, expected=409)
    assert all(m["presented_at"] is None for m in training(case)["messages"])


def test_concurrent_playback_outcomes_cannot_both_succeed(training_case):
    case = training_case
    select_and_dial(case)
    delivery = training(case)["messages"][0]["delivery"]
    payload = playback(delivery)
    failure = {k: v for k, v in payload.items() if k != "channel"} | {"reason": "interrupted"}
    with TestClient(create_database_app(case.config)) as other:
        headers = login(other, "trainee01")
        path = f"/api/cards/{case.card['id']}/events"
        with ThreadPoolExecutor(2) as pool:
            a = pool.submit(
                case.client.post,
                path,
                json=event("message_presented", payload),
                headers=case.headers,
            )
            b = pool.submit(
                other.post, path, json=event("message_failed", failure), headers=headers
            )
            assert sorted([a.result(timeout=10).status_code, b.result(timeout=10).status_code]) == [
                200,
                409,
            ]

    async def verify(db):
        assert (
            await db.scalar(
                select(func.count())
                .select_from(MessagePresentation)
                .where(MessagePresentation.playback_id == UUID(payload["playback_id"]))
            )
            == 1
        )

    run_db(case.url, verify)


def test_finish_and_restart_preserve_evidence_and_reject_new_confirmations(training_case):
    case = training_case
    select_and_dial(case)
    delivery = training(case)["messages"][0]["delivery"]
    payload = playback(delivery)
    body = event("message_presented", payload)
    send(case, "message_presented", payload, body=body)
    before = training(case)
    response = case.lesson.client.post(
        f"/api/sessions/{case.lesson.id}/finish",
        json={"contract_version": 2, "request_id": str(uuid4())},
        headers=case.lesson.headers,
    )
    assert response.status_code == 200
    assert send(case, "message_presented", payload, body=body).json()["duplicate"]
    response = send(case, "message_presented", playback(delivery), expected=409)
    assert response.json()["code"] == "session_finished"
    assert training(case) == before
    with TestClient(create_database_app(case.config)) as restarted:
        login(restarted, "trainee01")
        assert restarted.get(f"/api/cards/{case.card['id']}/training").json() == before

    async def no_more(db):
        assert (
            await db.scalar(
                select(func.count())
                .select_from(MessageDelivery)
                .where(MessageDelivery.card_id == UUID(case.card["id"]))
            )
            == 2
        )

    run_db(case.url, no_more)
