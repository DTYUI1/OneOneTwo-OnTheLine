import pytest
from app.core.contracts import validate_json
from app.core.evaluation_details import pack_explanations, unpack_explanation, unpack_remarks
from evalcore.models import CriterionResult, Remark
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


def test_remarks_are_stored_and_read_back():
    """TC-10: замечание разбора хранится рядом с фактами и читается без потерь."""
    remark = Remark(
        "Карточка вашей службы не принята.",
        "Служба не оповещена — фактически не выехала: помощь заявителю не придёт.",
        26,
        "Повторите: сверьте происшествие со своей службой.",
        quote="Не наша территория",
    )
    criterion = CriterionResult("routing", 0, 1, True, [], "Маршрутизация неверна.", (remark,))
    stored = pack_explanations([criterion])
    validate_json(stored, SCHEMA)
    assert unpack_remarks(stored["routing"], "routing", 0) == [
        {
            "text": remark.text,
            "consequence": remark.consequence,
            "memo_page": 26,
            "repeat": remark.repeat,
            "quote": "Не наша территория",
            "kind": "error",
        }
    ]
    clean = pack_explanations([CriterionResult("routing", 1, 1, False, [], "Верно.")])
    assert clean["routing"]["remarks"] == []
    assert unpack_remarks(clean["routing"], "routing", 1) == []


def test_old_evaluations_get_a_remark_by_criterion_key():
    """Оценка до TC-10 без `remarks`: общее замечание по ключу, только при потере балла."""
    for stored in ("Старое пояснение", {"explanation": "Старое пояснение", "evidence": []}):
        (remark,) = unpack_remarks(stored, "status_flow", 0.5)
        assert remark["text"] == "Старое пояснение"
        assert remark["consequence"] and remark["memo_page"] == 22
        assert remark["repeat"].startswith("Повторите:")
        assert unpack_remarks(stored, "status_flow", 1) == []


def test_effective_zero_weight_survives_storage_and_api():
    from types import SimpleNamespace

    from app.api.evaluations.service import criteria_for

    criterion = CriterionResult("handling_time", 0, 0, False, [], "Не оценивается.")
    stored = pack_explanations([criterion])
    validate_json(stored, SCHEMA)
    from app.api.progress.advice import _skipped

    assert "handling_time" in _skipped(stored)
    row = SimpleNamespace(
        explanation=stored,
        rules_scores={"handling_time": 0},
        semantic_scores=None,
        llm_scores=None,
        critical_flags=[],
    )
    settings = {"weights": {"handling_time": 2}}
    assert criteria_for({"Evaluation": row, "settings_snapshot": settings})[0].weight == 0
    del stored["handling_time"]["weight"]
    assert criteria_for({"Evaluation": row, "settings_snapshot": settings})[0].weight == 2
