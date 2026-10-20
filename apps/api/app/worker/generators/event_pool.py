"""Переносимые события службы: записанные реплики и доказанные факты карточки."""

import copy
import hashlib
import json
from typing import Any

from app.seed.card_fields import FIELDS, PLACEHOLDER


def _answer_fits(event: dict[str, Any], source: dict[str, Any], target: dict[str, Any]) -> bool:
    """Без семантического угадывания: поле карточки либо неизменное описание ситуации.

    Метка «*» в банке не доказывает ответ: общий вопрос об этаже может иметь
    совершенно конкретный ответ. Статические ответы переносим только между
    карточками с теми же фактами; новые подстановки здесь не изобретаем.
    """
    expected = {e.get("option_key") for e in event["expect"] if e["action"] == "reply"}
    answers = [o["label"] for o in event.get("reply_options", []) if o["key"] in expected]
    if not answers:
        return False
    for answer in answers:
        fields = PLACEHOLDER.findall(answer)
        if fields:
            # Только известные общие ответы без дополнительного утверждения о ситуации.
            if answer not in {
                "Телефон заявителя: {caller_phone}",
                "{caller_name}, телефон в карточке",
            }:
                return False
            if any(name not in FIELDS or not FIELDS[name](target["card"]) for name in fields):
                return False
            if "телефон" in answer.lower() and not FIELDS["caller_phone"](target["card"]):
                return False
        elif any(
            source["card"].get(field) != target["card"].get(field)
            for field in ("description", "address", "victims", "blocked_people")
        ):
            return False
    return True


def _identity(event: dict[str, Any], data: dict[str, Any]) -> str:
    """Копии одного блока из нескольких каркасов не увеличивают число путей."""
    from app.worker.generators.variant_paths import without_seconds

    value = copy.deepcopy(event)
    value.pop("key", None)
    value.pop("review", None)
    reports = {r["key"]: r["justifies_state"] for r in data["plan"]}
    if "report" in value["trigger"]:
        value["trigger"]["report"] = reports.get(value["trigger"]["report"])
    for branch in value["branches"].values():
        for effect in branch["effects"]:
            for field in ("delay", "replace"):
                if field in effect:
                    effect[field] = reports.get(effect[field])
    return json.dumps(without_seconds(value), sort_keys=True, ensure_ascii=False)


def transfer(
    event: dict[str, Any], source: dict[str, Any], target: dict[str, Any]
) -> dict[str, Any] | None:
    """Привязать независимый блок к тем же статусам другого каркаса своей службы."""
    from app.worker.generators import gameplay as g

    if source["service_id"] != target["service_id"] or event["kind"] not in {
        "clarify",
        "silence",
        "alarm",
    }:
        return None
    if event["kind"] == "clarify" and not _answer_fits(event, source, target):
        return None
    incident = g.incident_of(target)
    for line in g.event_lines({**source, "events": [event]}):
        phrase = g.phrase_of(line)
        if (
            not phrase
            or phrase["id"] not in g.voices()
            or phrase["text"] != line["text"]
            or not ({"*", incident} & set(phrase["incidents"]))
            or not g.fits_card(phrase, target["card"])
        ):
            return None
    # Вопрос о конкретном наблюдении не становится общим из-за подстановки в ответе.
    if event["kind"] == "clarify":
        question = g.phrase_of(event["line"])
        if not question or "*" not in question["incidents"]:
            return None
        if "двер" in question["text"].lower() and not target["card"]["address"].get("apartment"):
            return None
    states = {r["requires_state"] for r in target["plan"]}
    reports = {r["justifies_state"]: r["key"] for r in target["plan"]}
    mapping = {r["key"]: reports.get(r["justifies_state"]) for r in source["plan"]}
    result = copy.deepcopy(event)
    trigger = result["trigger"]
    if trigger["on"] not in {"message", "state", "no_contact", "inject"}:
        return None
    if (
        trigger.get("state", trigger.get("requires_state")) not in states
        and "report" not in trigger
    ):
        return None
    if "report" in trigger:
        if not mapping.get(trigger["report"]):
            return None
        trigger["report"] = mapping[trigger["report"]]
    for branch in result["branches"].values():
        for effect in branch["effects"]:
            for field in ("delay", "replace"):
                if field in effect:
                    if not mapping.get(effect[field]):
                        return None
                    effect[field] = mapping[effect[field]]
    digest = hashlib.sha256(_identity(result, target).encode()).hexdigest()[:16]
    result["key"] = f"pool-{event['kind']}-{digest}"
    return result


def candidates(target: dict[str, Any]) -> list[dict[str, Any]]:
    """События всех каркасов службы, без дублей собственного набора и доноров."""
    from app.worker.generators import gameplay as g

    seen = {_identity(e, target) for e in target.get("events", [])}
    keys = {e["key"] for e in target.get("events", [])}
    found = []
    for source in sorted(g.templates(), key=lambda t: t["code"]):
        if source["code"] == target["code"] or source["service_id"] != target["service_id"]:
            continue
        for event in source.get("events", []):
            moved = transfer(event, source, target)
            if moved is None:
                continue
            identity = _identity(moved, target)
            if identity in seen:
                continue
            seen.add(identity)
            while moved["key"] in keys:
                moved["key"] += "-copy"
            keys.add(moved["key"])
            found.append(moved)
    return found


def comment(data: dict[str, Any]) -> str:
    """Происхождение каждого перенесённого блока видно преподавателю."""
    events = [e for e in data.get("events", []) if e["key"].startswith("pool-")]
    if not events:
        return ""
    return (
        " События из пула службы: "
        + "; ".join(f"{e['key']} — {e['review']['label']}" for e in events)
        + "."
    )
