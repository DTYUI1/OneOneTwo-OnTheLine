"""C-05: сценарий по билету в draft до утверждения преподавателем, затем выдаётся обычным путём."""

import copy
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from app.core.models import Scenario

from .test_lifecycle import login, run_db

TICKET_3_2 = str(uuid5(NAMESPACE_URL, "arm112:ticket:3-2"))


def test_ticket_scenario_needs_teacher_approval_before_assignment(database_client, database_url):
    client = database_client
    headers = login(client)
    catalog = {item["id"]: item for item in client.get("/api/scenarios").json()}
    scenario = catalog[TICKET_3_2]
    assert (scenario["origin"], scenario["status"]) == ("imported", "draft")
    assert "Билет 3, задача 2" in scenario["teacher_comment"]
    users = {u["login"]: u for u in client.get("/api/users").json()}
    settings = client.get("/api/settings").json()
    lesson = client.post(
        "/api/sessions",
        headers=headers,
        json={
            "title": "Билет 3",
            "participants": [
                {
                    "user_id": users["trainee02"]["id"],
                    "workstation_number": 2,
                    "dds_service_id": "102",
                    "level": 1,
                }
            ],
            "settings_snapshot": settings,
        },
    ).json()
    item = {
        "participant_id": users["trainee02"]["id"],
        "scenario_id": TICKET_3_2,
        "scenario_version": scenario["version"],
        "order": 1,
        "delay_from_start_s": 0,
        "delivery_mode": "profile",
    }
    path = f"/api/sessions/{lesson['id']}/assignments/batch"
    body = {"request_id": str(uuid4()), "items": [item]}
    # Эталон команды не выдаётся ученику, пока преподаватель его не утвердил.
    assert client.post(path, json=body, headers=headers).status_code == 422
    approved = copy.deepcopy(scenario) | {"status": "approved"}
    response = client.put(f"/api/scenarios/{TICKET_3_2}", json=approved, headers=headers)
    assert response.status_code == 200, response.text
    version = response.json()["version"]
    body = {"request_id": str(uuid4()), "items": [item | {"scenario_version": version}]}
    assert client.post(path, json=body, headers=headers).status_code == 201

    async def restore(db):
        row = await db.get(Scenario, UUID(TICKET_3_2))
        row.status, row.version = "draft", scenario["version"]

    run_db(database_url, restore)
