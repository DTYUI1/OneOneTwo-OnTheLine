"""C-07 и ТЗ «Роль: Администратор системы»: администратор не вмешивается в учебный процесс
(не меняет оценки и сценарии, не ведёт занятия) и не видит результаты обучаемых без
необходимости (минимальные привилегии). Свои инструменты — учётки, службы, настройки,
состояние — у него остаются.
"""

import json
import re
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from app.core.config import ROOT

# Учебный процесс: изменение — только преподаватель/обучаемый, чтение — только участники.
TRAINING_OPERATIONS = {
    "createScenario",
    "updateScenario",
    "retireScenario",
    "generatePack",
    "createSession",
    "startSession",
    "finishSession",
    "createAssignment",
    "postEvent",
    "uploadAudio",
    "createOverride",
    "listScenarios",
    "getScenario",
    "listPacks",
    "getJob",
    "listSessions",
    "getSession",
    "listAssignments",
    "listCards",
    "getCard",
    "listEvents",
    "listCalls",
    "getCall",
    "listEvaluations",
    "getEvaluation",
    "getSessionReport",
    "exportSessionCsv",
    "getSessionLifecycle",
    "getCardTraining",
    "getAttemptAnalysis",
    "downloadInformationAudio",
}


def operations():
    spec = json.loads((ROOT / "contracts/openapi.json").read_text(encoding="utf-8"))
    for path, methods in spec["paths"].items():
        for method, operation in methods.items():
            yield path, method, operation


def headers_for(client, name):
    response = client.post("/api/auth/login", json={"login": name, "password": "test-password"})
    assert response.status_code == 200, response.text
    return {
        "cookie": "; ".join(f"{key}={value}" for key, value in client.cookies.items()),
        "X-CSRF-Token": client.cookies["csrf"],
    }


def test_contract_keeps_admin_out_of_training():
    found = {}
    for _, _, operation in operations():
        if operation["operationId"] in TRAINING_OPERATIONS:
            found[operation["operationId"]] = operation["x-roles"]
    assert set(found) == TRAINING_OPERATIONS
    for name, roles in found.items():
        assert "admin" not in roles, name
        assert roles, name


def test_admin_gets_403_on_every_training_operation(database_client):
    client = database_client
    admin = headers_for(client, "admin")
    checked = 0
    for path, method, operation in operations():
        if operation["operationId"] not in TRAINING_OPERATIONS:
            continue
        route = "/api" + re.sub(r"\{[^}]+\}", lambda _: str(uuid4()), path)
        response = client.request(
            method.upper(),
            route,
            headers=admin,
            json=None if method == "get" else {},
        )
        assert response.status_code == 403, (operation["operationId"], response.text)
        checked += 1
    assert checked == len(TRAINING_OPERATIONS)
    # Запись голоса обучаемого — отдельный транспортный маршрут вне OpenAPI.
    assert client.get(f"/api/calls/{uuid4()}/audio", headers=admin).status_code == 403


def test_admin_keeps_own_tools(database_client):
    client = database_client
    admin = headers_for(client, "admin")
    for route in ("/api/users", "/api/services", "/api/incident-types", "/api/admin/health"):
        assert client.get(route, headers=admin).status_code == 200, route
    settings = client.get("/api/settings", headers=admin)
    assert settings.status_code == 200
    assert client.put("/api/settings", json=settings.json(), headers=admin).status_code == 200


def test_admin_realtime_carries_no_training(database_client):
    client = database_client
    teacher = headers_for(client, "teacher")
    users = {item["login"]: item for item in client.get("/api/users", headers=teacher).json()}
    settings = client.get("/api/settings", headers=teacher).json()
    scenario = next(
        item
        for item in client.get("/api/scenarios", headers=teacher).json()
        if item["status"] == "approved"
    )
    admin = headers_for(client, "admin")
    with (
        client.websocket_connect("/ws", headers=teacher) as teacher_socket,
        client.websocket_connect("/ws", headers=admin) as admin_socket,
    ):

        def snapshot(socket):
            while (event := socket.receive_json())["type"] != "snapshot":
                pass
            return event["payload"]

        own = snapshot(admin_socket)
        assert own == {"cards": [], "sessions": [], "evaluations": []}
        snapshot(teacher_socket)
        lesson = client.post(
            "/api/sessions",
            headers=teacher,
            json={
                "title": f"Без администратора {uuid4()}",
                "participants": [
                    {
                        "user_id": users["trainee01"]["id"],
                        "workstation_number": 1,
                        "dds_service_id": "102",
                        "level": 1,
                    }
                ],
                "settings_snapshot": settings,
            },
        )
        assert lesson.status_code == 201, lesson.text
        lesson_id = lesson.json()["id"]
        assigned = client.post(
            f"/api/sessions/{lesson_id}/assignments",
            headers=teacher,
            json={
                "participant_id": users["trainee01"]["id"],
                "scenario_id": scenario["id"],
                "order": 1,
                "planned_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
            },
        )
        assert assigned.status_code == 201, assigned.text
        started = client.post(f"/api/sessions/{lesson_id}/start", headers=teacher)
        assert started.status_code == 200, started.text
        # Преподаватель получил событие — значит, рассылка по нему уже выполнена.
        while (event := teacher_socket.receive_json())["type"] != "session.started":
            pass
        assert event["payload"]["id"] == lesson_id
        # Pong стоит после уже разосланного события: учебное событие админу не пришло.
        admin_socket.send_json({"type": "clock.ping", "client_ts": datetime.now(UTC).isoformat()})
        while (event := admin_socket.receive_json())["type"] != "clock.pong":
            assert event["type"] == "presence", event["type"]
        client.post(
            f"/api/sessions/{lesson_id}/finish",
            headers=teacher,
            json={"contract_version": 2, "request_id": str(uuid4())},
        )
