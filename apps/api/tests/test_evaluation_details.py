import pytest
from app.core.contracts import validate_json
from app.core.evaluation_details import pack_explanations, unpack_explanation
from evalcore.models import CriterionResult
from jsonschema import ValidationError

SCHEMA = "https://arm112.local/contracts/storage.schema.json#/$defs/Explanations"


def test_pack_preserves_evidence_order_and_does_not_alias_input():
    criterion = CriterionResult(
        key="call",
        score=1,
        weight=1,
        critical=False,
        evidence=["Набран 102", "Звонок завершён"],
        explanation="Доклад передан.",
    )
    stored = pack_explanations([criterion])
    validate_json(stored, SCHEMA)
    text, evidence = unpack_explanation(stored["call"])
    assert text == criterion.explanation
    assert evidence == criterion.evidence
    criterion.evidence.append("Изменение входа")
    evidence.append("Изменение ответа")
    assert stored["call"]["evidence"] == ["Набран 102", "Звонок завершён"]


def test_legacy_and_structured_explanations_can_coexist():
    stored = {"routing": "Старое пояснение", "call": {"explanation": "Нет фактов", "evidence": []}}
    validate_json(stored, SCHEMA)
    assert unpack_explanation(stored["routing"]) == ("Старое пояснение", [])
    assert unpack_explanation(stored["call"]) == ("Нет фактов", [])


@pytest.mark.parametrize(
    "value",
    [
        {"explanation": "Нет evidence"},
        {"explanation": "Ошибка типа", "evidence": "не массив"},
        {"explanation": "Ошибка элемента", "evidence": [42]},
        {"explanation": "Лишнее поле", "evidence": [], "reference": "скрытый эталон"},
    ],
)
def test_storage_schema_rejects_invalid_structured_explanation(value):
    with pytest.raises(ValidationError):
        validate_json({"routing": value}, SCHEMA)
