"""Настройки API и snapshot должны быть пригодны для реального оценщика."""

import pytest
from app.api.foundation.schemas import Settings
from app.api.sessions.schemas import SessionInput
from evalcore.defaults import CRITERIA
from pydantic import ValidationError


def valid_settings():
    return {
        "reaction_normative_s": 30,
        "handling_normative_s": 180,
        "critical_cap": 0.5,
        "weights": dict.fromkeys(CRITERIA, 1.0),
        "parallel_cards": 2,
        "hints_level": 0,
    }


@pytest.mark.parametrize(
    "weights",
    [
        {},
        dict.fromkeys(CRITERIA, 0.0),
        {key: 1.0 for key in CRITERIA if key != "routing"},
        *[
            {**dict.fromkeys(CRITERIA, 1.0), "routing": value}
            for value in (-1, True, "1", float("inf"), float("nan"))
        ],
        dict.fromkeys(CRITERIA, 1e308),
    ],
)
def test_invalid_weights_rejected_globally_and_in_session(weights):
    body = {**valid_settings(), "weights": weights}
    with pytest.raises(ValidationError):
        Settings.model_validate(body)
    with pytest.raises(ValidationError):
        SessionInput.model_validate(
            {"title": "Проверка", "participants": [], "settings_snapshot": body}
        )


def test_zero_individual_weight_and_extension_are_compatible():
    body = valid_settings()
    body["weights"].update(routing=0.0, future_criterion=2.0)
    assert Settings.model_validate(body).weights == body["weights"]


@pytest.mark.parametrize("weights", [{}, dict.fromkeys(CRITERIA, 0.0)])
def test_invalid_weights_http_does_not_change_settings(database_client, weights):
    client = database_client
    response = client.post("/api/auth/login", json={"login": "admin", "password": "test-password"})
    assert response.status_code == 200
    before = client.get("/api/settings").json()
    response = client.put(
        "/api/settings",
        json={**before, "weights": weights},
        headers={"X-CSRF-Token": client.cookies["csrf"]},
    )
    assert response.status_code == 422, response.text
    assert client.get("/api/settings").json() == before
