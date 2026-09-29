"""Ручной ввод адреса обучаемым хранится отдельно от исходного адреса карточки."""

import pytest
from app.core.contracts import validate_json

from .test_c01_v3_statuses import trainee_card  # noqa: F401
from .test_c03_sessions import lesson  # noqa: F401

ADDRESS = {
    "city": "Москва",
    "street": "улица Грина",
    "house": "11",
    "building": "",
    "apartment": "",
}


def test_manual_address_is_separate_from_source(trainee_card):  # noqa: F811
    card, send = trainee_card
    result = send("field_change", {"field": "address", "value": ADDRESS})["card"]
    validate_json(result, "urn:openapi#/components/schemas/Card")
    assert result["current"]["address"] == ADDRESS
    # Исходные сведения 112 не меняются ручным вводом.
    assert result["source"]["address"] == card["source"]["address"]
    send("status_change", {"state": "accepted", "comment": "Принята"})
    send("status_change", {"state": "completed", "comment": "Завершено"})
    send("field_change", {"field": "address", "value": ADDRESS}, expected=409)


@pytest.mark.parametrize(
    "payload",
    [
        {"field": "address", "value": "улица Грина, 11"},
        {"field": "address", "value": {**ADDRESS, "house": None}},
        {"field": "address", "value": {"street": "улица Грина"}},
        {"field": "comment", "value": ADDRESS},
    ],
)
def test_invalid_manual_address_is_rejected(trainee_card, payload):  # noqa: F811
    _, send = trainee_card
    send("field_change", payload, expected=422)


def test_card_without_manual_address_reads_as_null(trainee_card):  # noqa: F811
    card, _ = trainee_card
    assert card["current"].get("address") is None
