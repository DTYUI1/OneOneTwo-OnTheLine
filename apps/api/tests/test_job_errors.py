"""Прочтение ошибки меняет только уведомление, не задание и не результат."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from app.core.models import AuditLog, Job
from sqlalchemy import delete, select

from .test_lifecycle import login, run_db


@pytest.fixture
def failed_jobs(database_url):
    ids = [uuid4() for _ in range(3)]

    async def create(db):
        for index, id in enumerate(ids):
            db.add(
                Job(
                    id=id,
                    kind="generate",
                    payload={"private": "must not be exposed"},
                    status="failed",
                    attempts=3,
                    error=f"Проверка связности {index}",
                    run_after=datetime.now(UTC) + timedelta(seconds=index),
                    result={"partial": True},
                )
            )

    run_db(database_url, create)
    yield ids

    async def clean(db):
        await db.execute(delete(Job).where(Job.id.in_(ids)))

    run_db(database_url, clean)


def get_item(client, id):
    response = client.get("/api/admin/job-errors", params={"limit": 100})
    assert response.status_code == 200, response.text
    return next(item for item in response.json()["items"] if item["id"] == str(id))


def test_read_preserves_job_history_and_survives_new_login(
    database_client, database_url, failed_jobs
):
    client = database_client
    headers = login(client, "admin")
    id = failed_jobs[0]
    item = get_item(client, id)
    assert item["read_at"] is None
    assert "private" not in str(item) and "payload" not in item and "result" not in item
    before = client.get("/api/admin/status").json()["queue"]
    response = client.post(
        f"/api/admin/job-errors/{id}/read", json={"version": item["version"]}, headers=headers
    )
    assert response.status_code == 200, response.text
    read_at = response.json()["read_at"]
    assert read_at
    repeated = client.post(
        f"/api/admin/job-errors/{id}/read", json={"version": item["version"]}, headers=headers
    )
    assert repeated.status_code == 200 and repeated.json()["read_at"] == read_at
    after = client.get("/api/admin/status").json()["queue"]
    assert after["failed"] == before["failed"]
    assert after["failed_unread"] == before["failed_unread"] - 1
    login(client, "admin")
    assert get_item(client, id)["read_at"] == read_at
    assert str(id) in {
        x["id"] for x in client.get("/api/admin/job-errors?state=read").json()["items"]
    }
    assert str(id) not in {
        x["id"] for x in client.get("/api/admin/job-errors?state=unread").json()["items"]
    }

    async def verify(db):
        job = await db.get(Job, id)
        assert (job.status, job.attempts, job.result, job.error) == (
            "failed",
            3,
            {"partial": True},
            "Проверка связности 0",
        )
        assert await db.scalar(
            select(AuditLog.id).where(
                AuditLog.action == "readJobError", AuditLog.entity_id == str(id)
            )
        )

    run_db(database_url, verify)


def test_new_failure_needs_new_ack_and_stale_page_cannot_hide_it(
    database_client, database_url, failed_jobs
):
    client = database_client
    headers = login(client, "admin")
    id = failed_jobs[0]
    old = get_item(client, id)
    path = f"/api/admin/job-errors/{id}/read"
    assert client.post(path, json={"version": old["version"]}, headers=headers).status_code == 200

    async def fail_again(db):
        job = await db.get(Job, id)
        # Повтор может сбросить attempts и выдать тот же текст, но время меняется.
        job.run_after += timedelta(minutes=1)

    run_db(database_url, fail_again)
    fresh = get_item(client, id)
    assert fresh["read_at"] is None and fresh["version"] != old["version"]
    assert client.post(path, json={"version": old["version"]}, headers=headers).status_code == 409
    assert get_item(client, id)["read_at"] is None
    assert client.post(path, json={"version": fresh["version"]}, headers=headers).status_code == 200


def test_access_csrf_pagination_and_nonfailed_job(database_client, database_url, failed_jobs):
    client = database_client
    path = f"/api/admin/job-errors/{failed_jobs[0]}/read"
    for role in ("teacher", "trainee01"):
        headers = login(client, role)
        assert client.get("/api/admin/job-errors").status_code == 403
        assert client.post(path, json={"version": "a" * 64}, headers=headers).status_code == 403
    client.cookies.clear()
    assert client.get("/api/admin/job-errors").status_code == 401
    headers = login(client, "admin")
    item = get_item(client, failed_jobs[0])
    assert client.post(path, json={"version": item["version"]}).status_code == 403
    assert client.get("/api/admin/job-errors?limit=101").status_code == 422
    assert client.get("/api/admin/job-errors?offset=-1").status_code == 422
    first = client.get("/api/admin/job-errors?limit=2").json()
    second = client.get("/api/admin/job-errors?limit=2&offset=2").json()
    assert first["total"] >= 3 and len(first["items"]) == 2
    assert not ({x["id"] for x in first["items"]} & {x["id"] for x in second["items"]})
    assert all(get_item(client, id)["read_at"] is None for id in failed_jobs)

    async def recover(db):
        job = await db.get(Job, failed_jobs[0])
        job.status = "done"

    run_db(database_url, recover)
    assert client.post(path, json={"version": item["version"]}, headers=headers).status_code == 409
    assert (
        client.post(
            f"/api/admin/job-errors/{uuid4()}/read", json={"version": "a" * 64}, headers=headers
        ).status_code
        == 404
    )
