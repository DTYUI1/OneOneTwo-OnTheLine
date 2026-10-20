"""Вводная бригаде в тестах (GP-05): без неё бригада не выезжает и не докладывает."""

from typing import Any


def briefing_text(card: dict[str, Any]) -> str:
    """Полная вводная по карточке: адрес и повод, как их собирают по частям."""
    source = card["source"]
    address = source["address"]
    house = f", дом {address['house']}" if address.get("house") else ""
    incident = source.get("incident_class") or source["description"]
    return f"{address['street']}{house}. {incident}"


def briefing_payload(card: dict[str, Any], call_id: str, mode: str = "parts") -> dict[str, Any]:
    return {"call_id": call_id, "mode": mode, "text": briefing_text(card)}
