"""Неоценённое место в отчёте и CSV — пусто (null), а не 0: как в интерфейсе."""

from .test_lifecycle import login


def test_unevaluated_trainee_is_empty_not_zero(database_client):
    client = database_client
    headers = login(client)
    users = {u["login"]: u for u in client.get("/api/users").json()}
    lesson = client.post(
        "/api/sessions",
        json={
            "title": "Без оценок",
            "participants": [
                {
                    "user_id": users["trainee05"]["id"],
                    "workstation_number": 5,
                    "dds_service_id": "102",
                    "level": 1,
                }
            ],
            "settings_snapshot": client.get("/api/settings").json(),
        },
        headers=headers,
    ).json()
    report = client.get(f"/api/reports/session/{lesson['id']}")
    assert report.status_code == 200, report.text
    row = report.json()["trainees"][0]
    assert (row["total"], row["reaction_time_s"], row["handling_time_s"]) == (None, None, None)
    csv = client.get(f"/api/reports/session/{lesson['id']}/csv")
    assert csv.status_code == 200, csv.text
    line = csv.content.decode("utf-8-sig").splitlines()[1].split(";")
    assert line[2:5] == ["", "", ""] and line[5] == "0"
