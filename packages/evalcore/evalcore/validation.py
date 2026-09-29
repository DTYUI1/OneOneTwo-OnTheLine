"""Проверка пригодности эталона перед утверждением и назначением."""

from evalcore.defaults import CARD_TRANSITIONS
from evalcore.models import Json


def validate_reference(reference: dict[str, Json]) -> None:
    """Отклонить эталон, по которому rules-оценщик не сможет проверить решение."""
    flow = reference.get("expected_flow")
    if not isinstance(flow, list) or not any(
        state in ("accepted", "rejected", "redirected") for state in flow
    ):
        raise ValueError("Эталон должен содержать решение о принятии, отказе или перенаправлении.")
    states = flow[1:] if flow[0] == "added" else flow
    transitions = {**CARD_TRANSITIONS, "rejected": CARD_TRANSITIONS["rejected"] | {"redirected"}}
    if (
        states[0] != "received"
        or states[-1] not in ("completed", "refused", "rejected", "redirected")
        or any(
            not isinstance(left, str)
            or not isinstance(right, str)
            or right not in transitions.get(left, set())
            for left, right in zip(states, states[1:], strict=False)
        )
    ):
        raise ValueError("Последовательность эталона не соответствует переходам карточки ДДС.")
    services = reference.get("expected_service_ids")
    if "redirected" in flow and (
        not isinstance(services, list)
        or not services
        or any(not isinstance(service, str) or not service.strip() for service in services)
    ):
        raise ValueError("Для перенаправления укажите допустимую службу-получателя.")
    call = reference.get("expected_call")
    if isinstance(call, dict) and call.get("required") is True:
        service = call.get("service_id")
        if not isinstance(service, str) or not service.strip():
            raise ValueError("Для обязательного звонка укажите службу-получателя.")
