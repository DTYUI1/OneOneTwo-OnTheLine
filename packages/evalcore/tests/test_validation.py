"""Ошибочный эталон должен обнаруживаться до назначения обучаемому."""

import pytest
from evalcore.validation import validate_reference


@pytest.mark.parametrize(
    "flow",
    [
        [],
        ["received", "completed"],
        ["accepted"],
        ["received", "rejected", "accepted"],
        # Этапы только вперёд: возврат к более раннему этапу — не учебный эталон.
        ["received", "accepted", "arrived", "responding", "completed"],
        ["received", "accepted", "working", "arrived", "completed"],
        ["received", "accepted", "completed", "refused"],
    ],
)
def test_invalid_reference_flow_is_rejected(flow):
    with pytest.raises(ValueError):
        validate_reference({"expected_flow": flow})


@pytest.mark.parametrize(
    "flow",
    [
        ["received", "accepted", "responding", "completed"],
        ["received", "accepted", "responding", "arrived", "working", "completed"],
        # Памятка не требует проходить все этапы: пропуск задаёт эталон сценария.
        ["received", "accepted", "completed"],
        ["received", "accepted", "arrived", "refused"],
        ["received", "rejected", "accepted", "working", "completed"],
    ],
)
def test_universal_v3_flow_is_accepted(flow):
    validate_reference({"expected_flow": flow})


@pytest.mark.parametrize("services", [[], [""], None])
def test_redirect_requires_known_recipient_list(services):
    with pytest.raises(ValueError, match="службу-получателя"):
        validate_reference(
            {
                "expected_flow": ["received", "rejected", "redirected"],
                "expected_service_ids": services,
            }
        )


def test_reference_allows_rejection_without_redirect_and_optional_call():
    validate_reference(
        {"expected_flow": ["received", "rejected"], "expected_call": {"required": False}}
    )


def test_required_call_needs_recipient():
    with pytest.raises(ValueError, match="обязательного звонка"):
        validate_reference(
            {
                "expected_flow": ["received", "accepted", "responding", "completed"],
                "expected_call": {"required": True, "service_id": ""},
            }
        )
