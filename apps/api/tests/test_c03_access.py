"""Права C-03, смешанное legacy-расписание и намеренное несовпадение ДДС."""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from app.core.models import Assignment, AssignmentBatch, AuditLog, Scenario, Session, User
from sqlalchemy import func, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from . import test_c03_sessions as c03
from .test_c03_sessions import batch, item, lifecycle, start, tick
from .test_lifecycle import login, run_db

lesson = c03.lesson


def test_failed_transaction_can_retry_same_batch(lesson, database_url, monkeypatch):
    path = f"/api/sessions/{lesson.id}/assignments/batch"
    body = {"request_id": str(uuid4()), "items": [item(lesson), item(lesson, participant=1)]}
    real_add = AsyncSession.add

    def fail_audit(db, instance, **kwargs):
        if isinstance(instance, AuditLog):
            raise DBAPIError("audit", {}, Exception("unavailable"))
        return real_add(db, instance, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(AsyncSession, "add", fail_audit)
        response = lesson.client.post(path, headers=lesson.headers, json=body)
        assert response.status_code == 503

    async def verify_rollback(db):
        for model in [Assignment, AssignmentBatch]:
            assert (
                await db.scalar(
                    select(func.count())
                    .select_from(model)
                    .where(model.session_id == UUID(lesson.id))
                )
                == 0
            )

    run_db(database_url, verify_rollback)
    response = lesson.client.post(path, headers=lesson.headers, json=body)
    assert response.status_code == 201
    assert len(response.json()["assignments"]) == 2


def test_roles_owner_csrf_and_lifecycle_privacy(lesson, database_url):
    client = lesson.client
    path = f"/api/sessions/{lesson.id}"
    body = {"request_id": str(uuid4()), "items": [item(lesson)]}
    assert client.post(path + "/assignments/batch", json=body).status_code == 403
    for role in ["trainee01", "admin"]:
        headers = login(client, role)
        assert (
            client.post(path + "/assignments/batch", json=body, headers=headers).status_code == 403
        )
        assert (
            client.post(
                path + "/finish",
                json={"contract_version": 2, "request_id": str(uuid4())},
                headers=headers,
            ).status_code
            == 403
        )
    login(client, "trainee03")
    assert client.get(path + "/lifecycle").status_code == 404
    lesson.headers = login(client)
    batch(lesson, [item(lesson)])

    async def change_owner(db):
        teacher = await db.scalar(select(User).where(User.login == "teacher"))
        other = User(
            login="c03-owner-" + uuid4().hex,
            password_hash=teacher.password_hash,
            role="teacher",
            full_name="Другой преподаватель",
            is_active=True,
            workstation_number=None,
            dds_service_id=None,
        )
        db.add(other)
        await db.flush()
        session = await db.get(Session, UUID(lesson.id))
        session.teacher_id = other.id
        return teacher.id

    original = run_db(database_url, change_owner)
    try:
        for endpoint in ["/assignment-batches", "/lifecycle", "/assignments"]:
            assert client.get(path + endpoint).status_code == 404
        assert (
            client.post(path + "/assignments/batch", json=body, headers=lesson.headers).status_code
            == 404
        )
        assert (
            client.post(
                path + "/finish",
                json={"contract_version": 2, "request_id": str(uuid4())},
                headers=lesson.headers,
            ).status_code
            == 404
        )
    finally:

        async def restore_owner(db):
            session = await db.get(Session, UUID(lesson.id))
            session.teacher_id = original

        run_db(database_url, restore_owner)


def test_explicit_mismatch_and_legacy_absolute_time(lesson, database_url):
    client = lesson.client
    planned = datetime.now(UTC) + timedelta(days=1)
    legacy = {
        "participant_id": lesson.participants[0]["user_id"],
        "scenario_id": lesson.scenarios[0]["id"],
        "order": 4,
        "planned_at": planned.isoformat(),
    }
    path = f"/api/sessions/{lesson.id}/assignments"
    response = client.post(path, json=legacy, headers=lesson.headers)
    assert response.status_code == 201
    legacy_id = response.json()["id"]
    conflict = {"request_id": str(uuid4()), "items": [item(lesson, order=4)]}
    assert client.post(path + "/batch", json=conflict, headers=lesson.headers).status_code == 409

    async def mismatch(db):
        scenario = await db.get(Scenario, UUID(lesson.scenarios[1]["id"]))
        scenario.target_service_id = "103" if scenario.target_service_id != "103" else "102"

    run_db(database_url, mismatch)
    batch(
        lesson,
        [
            item(lesson, order=5),
            {**item(lesson, participant=1), "delivery_mode": "intentional_mismatch"},
        ],
    )
    # Legacy DTO требует абсолютный planned_at; новые назначения читаются через batches.
    assert [a["id"] for a in client.get(path).json()] == [legacy_id]
    start(lesson)

    async def verify(db):
        assignment = await db.get(Assignment, UUID(legacy_id))
        assert assignment.planned_at == planned and assignment.due_at is None

    run_db(database_url, verify)
    tick(database_url)
    assert len(lifecycle(lesson)["attempts"]) == 2


def test_batch_limits_and_delay_across_batches(lesson):
    client = lesson.client
    path = f"/api/sessions/{lesson.id}/assignments/batch"
    for items in [
        [],
        [item(lesson)] * 231,
        [item(lesson, delay=-1)],
        [item(lesson, delay=86401)],
        [item(lesson, order=0)],
    ]:
        response = client.post(
            path, json={"request_id": str(uuid4()), "items": items}, headers=lesson.headers
        )
        assert response.status_code == 422, response.text
    batch(lesson, [item(lesson, order=2, delay=10)])
    for assignment, expected in [
        (item(lesson, order=1, delay=10), 409),
        (item(lesson, order=3, delay=9), 422),
    ]:
        response = client.post(
            path, json={"request_id": str(uuid4()), "items": [assignment]}, headers=lesson.headers
        )
        assert response.status_code == expected, response.text
    batch(lesson, [item(lesson, order=5, delay=10)])
