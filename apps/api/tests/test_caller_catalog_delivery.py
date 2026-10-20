"""Три сюжета заявителя: настоящий seed, каталог, снимок тренировки и доступный звонок."""

import json
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.core.config import ROOT
from app.seed.scenarios import scenario_row
from fastapi.testclient import TestClient

from .test_c03_sessions import tick
from .test_c04_completion import seed_training
from .test_c04_training import event
from .test_lifecycle import login

CASES = (
    ("animal-shaft-gkh-1", "animal_shaft", 7),
    ("pipe-access-gkh-2", "pipe_access", 2),
    ("lift-location-moslift-2", "lift_location", 2),
)


@pytest.mark.parametrize("code,plot,version", CASES)
def test_caller_catalog_practice_exposes_callable_contact(
    database_config, database_url, code, plot, version
):
    seed_training(database_url)
    source = json.loads((ROOT / "data/scenarios" / f"{code}.json").read_text())
    # Существующие выдачи первой версии не переписываются новым содержательным планом.
    assert source["version"] == version
    scenario_id = str(scenario_row(source)["id"])
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, "trainee03")
        catalog = {item["id"]: item for item in client.get("/api/practice/catalog").json()}
        assert scenario_id in catalog
        started = client.post(f"/api/practice?scenario={scenario_id}", headers=headers)
        assert started.status_code == 200, started.text
        session = started.json()
        contacts = session["settings_snapshot"]["phone_contacts"][source["service_id"]]
        caller = next(item for item in contacts if item["role"] == "caller")
        assert caller["name"] == "Заявитель"
        tick(database_url)
        cards = client.get("/api/cards").json()
        card = next(item for item in cards if item["session_id"] == session["id"])
        assert UUID(card["id"])
        training = client.get(f"/api/cards/{card['id']}/training").json()
        assert training["caller"]["plot"] == plot
        call_id = str(uuid4())
        for kind, payload in (
            ("call_dial", {"call_id": call_id, "phone_ext": caller["number"]}),
            ("call_answer", {"call_id": call_id}),
            (
                "caller_said",
                {"call_id": call_id, "phrase_id": "CALLER_CALM.answer.animal_shaft.1"},
            ),
            ("call_hangup", {"call_id": call_id}),
        ):
            response = client.post(
                f"/api/cards/{card['id']}/events", json=event(kind, payload), headers=headers
            )
            assert response.status_code == 200, response.text
        journal = client.get(f"/api/cards/{card['id']}/events").json()
        assert any(
            item["type"] == "caller_said" and item["payload"]["call_id"] == call_id
            for item in journal
        )
