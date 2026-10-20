import json
from uuid import NAMESPACE_URL, uuid5

import pytest
from app.core.config import ROOT
from app.core.contracts import validate_json
from app.operator.router import CardInput, card_for_dispatch
from app.operator.scenarios import load_scenarios
from app.tools.build_link112_records import build_records


def test_dispatch_preserves_only_operator_input_and_full_address():
    scenario = load_scenarios()[0]
    card = CardInput.model_validate(
        {
            "incident_type_code": scenario["incident_type_code"],
            "caller_name": "",
            "caller_status": "очевидец",
            "emergency": True,
            "address": {
                "street": "Учебная улица",
                "house": "1",
                "entrance": "2",
                "floor": "5",
                "code": "123",
                "descriptive": "Напротив школы",
            },
            "phone_provided": "+7 (900) 000-00-01",
            "phone_scene": "89000000002",
        }
    )
    result = card_for_dispatch(scenario, card, str(uuid5(NAMESPACE_URL, "operator-test")))
    assert result is not None
    validate_json(result, "https://arm112.local/contracts/card.schema.json")
    assert result["caller_name"] == ""
    assert result["caller_status"] == "очевидец"
    assert result["emergency"] is True
    assert result["address"] == card.address.model_dump()
    assert result["phone_provided"] == "+79000000001"
    assert result["phone_scene"] == "+79000000002"


@pytest.mark.parametrize(
    "phone", ["123", "916123456", "+790000000001", "+7 (916) 123-45", "номер 9000000001"]
)
def test_invalid_phone_is_rejected_before_dispatch(phone):
    with pytest.raises(ValueError):
        CardInput.model_validate({"phone_provided": phone})


@pytest.mark.parametrize(
    "phone",
    ["9161234567", "89161234567", "79161234567", "+7 (916) 123-45-67", "8 916 123 45 67"],
)
def test_phone_by_arm_mask_is_normalized(phone):
    """Десять цифр по маске АРМ; «8», «7» или «+7» перед ними — код страны."""
    assert CardInput.model_validate({"phone_provided": phone}).phone_provided == "+79161234567"


def test_bot_records_are_reproducible_and_validate_as_operator_and_dds_cards():
    records = build_records()
    assert records == build_records()
    scenario = next(item for item in load_scenarios() if item["id"] == "fire_apartment_smoke")
    # Каталог — ровно то, что собирает генератор: вторая копия записи дала бы второй сценарий.
    assert sorted(path.stem for path in (ROOT / "data/link112/records").glob("*.json")) == sorted(
        str(record["id"]) for record in records
    )
    for record in records:
        validate_json(record, "https://arm112.local/contracts/link112-record.schema.json")
        stored = ROOT / "data/link112/records" / f"{record['id']}.json"
        assert json.loads(stored.read_text(encoding="utf-8")) == record
        card = CardInput.model_validate(record["card"])
        result = card_for_dispatch(scenario, card, str(uuid5(NAMESPACE_URL, str(record["id"]))))
        validate_json(result, "https://arm112.local/contracts/card.schema.json")
    streets = {str(record["id"]): record["card"]["address"]["street"] for record in records}
    assert streets == {
        "fire_apartment_smoke.correct": "Дубнинская улица",
        "fire_apartment_smoke.wrong-street": "Дубининская улица",
        "fire_apartment_smoke.wrong-street-level2": "Дубининская улица",
    }
