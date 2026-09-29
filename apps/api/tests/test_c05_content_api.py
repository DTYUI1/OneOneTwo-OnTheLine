"""C-05: предпросмотр, прогресс генерации, утверждение пакета и происхождение сценария."""

import copy
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from app.api.database import create_database_app
from app.core.contracts import read_json, validate_json
from app.core.models import Job, Scenario, ScenarioPack, ScenarioPackItem
from app.worker.runtime import Worker
from fastapi.testclient import TestClient
from sqlalchemy import delete

from .test_lifecycle import login, run_db

EXAMPLE = read_json("contracts/c01.schema.json")["$defs"]["ScenarioPreviewInput"]["examples"][0]
TICKETS_PDF_SHA256 = "4b94bf521f215419921effee2b81cb01e09ae94e7c38514e2cc82b096b15ba39"


def test_preview_is_deterministic_and_rejects_unknown_type(database_client):
    client = database_client
    headers = login(client)
    first = client.post("/api/scenarios/preview", json=EXAMPLE, headers=headers)
    assert first.status_code == 200, first.text
    validate_json(first.json(), "urn:openapi#/components/schemas/ScenarioPreview")
    again = client.post("/api/scenarios/preview", json=EXAMPLE, headers=headers)
    assert again.json() == first.json()
    assert first.json()["provenance"]["source_version"] == "046_24"
    unknown = copy.deepcopy(EXAMPLE)
    unknown["constructor"]["incident_type_code"] = "99999999"
    response = client.post("/api/scenarios/preview", json=unknown, headers=headers)
    assert response.status_code == 422 and response.json()["code"] == "unknown_type"
    trainee = login(client, "trainee01")
    assert client.post("/api/scenarios/preview", json=EXAMPLE, headers=trainee).status_code == 403


def generate(client, headers, database_config, database_url, count=3):
    body = {"count": count, "level": 1, "service_id": "102", "seed": 7}
    job = client.post("/api/packs/generate", json=body, headers=headers).json()
    progress = client.get(f"/api/jobs/{job['id']}/progress")
    assert progress.status_code == 200, progress.text
    validate_json(progress.json(), "urn:openapi#/components/schemas/JobProgress")
    assert (progress.json()["completed"], progress.json()["total"]) == (0, count)

    async def run(db):
        worker = Worker(database_config)
        try:
            row = await db.get(Job, UUID(job["id"]))
            await worker.handlers.handle_generate(db, row.payload)
        finally:
            await worker.close()

    run_db(database_url, run)
    done = client.get(f"/api/jobs/{job['id']}/progress").json()
    assert done["completed"] == count and len(done["scenario_ids"]) == count
    return done


def remove_pack(database_url, pack_id, scenario_ids):
    """Общая тестовая БД: сгенерированный пакет не должен влиять на каталог других тестов."""

    async def remove(db):
        await db.execute(delete(ScenarioPackItem).where(ScenarioPackItem.pack_id == UUID(pack_id)))
        await db.execute(delete(Scenario).where(Scenario.id.in_([UUID(i) for i in scenario_ids])))
        await db.execute(delete(ScenarioPack).where(ScenarioPack.id == UUID(pack_id)))

    run_db(database_url, remove)


def test_pack_approval_is_idempotent_and_checks_versions(database_config, database_url):
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        progress = generate(client, headers, database_config, database_url)
        pack_id, ids = progress["pack_id"], progress["scenario_ids"]
        try:
            approval_flow(client, headers, pack_id, ids)
        finally:
            remove_pack(database_url, pack_id, ids)


def approval_flow(client, headers, pack_id, ids):
    catalog = {item["id"]: item for item in client.get("/api/scenarios").json()}
    body = {
        "request_id": str(uuid4()),
        "scenarios": [{"scenario_id": ids[0], "version": catalog[ids[0]]["version"]}],
    }
    path = f"/api/packs/{pack_id}/approve"
    response = client.post(path, json=body, headers=headers)
    assert response.status_code == 200, response.text
    validate_json(response.json(), "urn:openapi#/components/schemas/PackApproval")
    result = response.json()
    assert result["approved"] == [
        {"scenario_id": ids[0], "version": catalog[ids[0]]["version"] + 1}
    ]
    assert result["remaining_draft_ids"] == ids[1:]
    # Повтор — тот же ответ; тот же ключ с другим телом — конфликт.
    assert client.post(path, json=body, headers=headers).json() == result
    changed = {**body, "scenarios": [{"scenario_id": ids[1], "version": 1}]}
    assert client.post(path, json=changed, headers=headers).status_code == 409
    stale = {**body, "request_id": str(uuid4())}
    assert client.post(path, json=stale, headers=headers).status_code == 409
    foreign = {
        "request_id": str(uuid4()),
        "scenarios": [{"scenario_id": "00000000-0000-4000-8000-000000000100", "version": 1}],
    }
    assert client.post(path, json=foreign, headers=headers).status_code == 404
    assert client.get(f"/api/scenarios/{ids[0]}").json()["status"] == "approved"
    trainee = login(client, "trainee01")
    assert client.post(path, json=body, headers=trainee).status_code == 403


def test_content_provenance_for_ticket_and_template(database_client):
    client = database_client
    login(client)
    ticket = str(uuid5(NAMESPACE_URL, "arm112:ticket:3-2"))
    response = client.get(f"/api/scenarios/{ticket}/content")
    assert response.status_code == 200, response.text
    validate_json(response.json(), "urn:openapi#/components/schemas/ScenarioContent")
    provenance = response.json()["provenance"]
    assert provenance["source_kind"] == "imported" and provenance["synthetic"] is False
    assert provenance["source_id"].endswith("#билет 3, задача 2")
    assert provenance["sha256"] == TICKETS_PDF_SHA256
    template = client.get("/api/scenarios/00000000-0000-4000-8000-000000000100/content").json()
    assert template["provenance"]["source_kind"] == "template"
    assert template["provenance"]["synthetic"] is True and template["training_plan"] is None
    assert client.get(f"/api/scenarios/{uuid4()}/content").status_code == 404
