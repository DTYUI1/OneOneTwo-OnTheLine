"""Фоновые отработанные карточки реестра (TC-07, «Живая смена»; contracts/C01_INTERFACES.md).

На старте смены в реестре ДДС уже есть карточки, которые служба отработала раньше: смена
выглядит живой. Это не `Card`: ничего не сохраняется, в занятие, выдачу, оценку, разбор и
прогресс фоновые карточки не входят. Содержание — `data/background_cards.json`, сколько — по
уровню участника, номер и время — детерминированно из участия: повторный запрос отдаёт то же.
"""

import hashlib
import json
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from fastapi import HTTPException, Request

from app.api.c01 import C01Input
from app.api.sessions import repo
from app.core.config import ROOT
from app.core.models import Participant

BACKGROUND_FILE = ROOT / "data" / "background_cards.json"
# Уровень участника → сколько фоновых карточек (touches.md, «Правдоподобие»: 0/3/6/10).
LEVEL_COUNTS = {1: 0, 2: 3, 3: 6, 4: 10}


class BackgroundCardView(C01Input):
    contract_name = "BackgroundCard"


@lru_cache(maxsize=1)
def catalog() -> dict[str, list[dict[str, Any]]]:
    data = json.loads(BACKGROUND_FILE.read_text(encoding="utf-8"))
    return {service: list(items) for service, items in data["services"].items()}


def _hash(*parts: object) -> int:
    digest = hashlib.sha256(":".join(str(part) for part in parts).encode()).hexdigest()
    return int(digest[:12], 16)


def _time(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def background_cards(
    participant_id: UUID,
    session_id: UUID,
    service_id: str,
    level: int,
    started_at: datetime,
) -> list[dict[str, Any]]:
    """Фоновые карточки участника, новые первыми; время — до начала занятия."""
    items = catalog().get(service_id, [])
    count = min(LEVEL_COUNTS.get(level, 0), len(items))
    chosen = sorted(range(len(items)), key=lambda index: _hash(participant_id, "pick", index))
    chosen = chosen[:count]
    base = _hash(participant_id, "number")
    start = started_at.replace(microsecond=0)
    cards = []
    for order, index in enumerate(chosen):
        item = items[index]
        jitter = _hash(participant_id, "time", order)
        appeared = start - timedelta(minutes=9 + 13 * order + jitter % 7, seconds=jitter % 53)
        status = min(
            appeared + timedelta(minutes=3 + jitter % 9, seconds=(jitter >> 8) % 59),
            start - timedelta(minutes=1),
        )
        source = {
            "number": f"368{(base + order * 7919) % 100000:05d}",
            "incident_type_code": item["incident_type_code"],
            "caller_name": "",
            "phone_aon": "",
            "phone_provided": "",
            "phone_scene": "",
            "address": dict(item["address"]),
            "description": item["description"],
            "tags": [],
            "victims": bool(item["victims"]),
            "ambulance_refused": False,
            "blocked_people": False,
            "emergency": False,
            "incident_class": item["incident_class"],
            "service_ids": list(item["service_ids"]),
        }
        cards.append(
            {
                "id": str(uuid5(NAMESPACE_URL, f"arm112:background:{participant_id}:{order}")),
                "session_id": str(session_id),
                "appeared_at": _time(appeared),
                "status_at": _time(status),
                "state": item["state"],
                "source": source,
            }
        )
    return cards


async def list_background(request: Request, session_id: UUID) -> list[BackgroundCardView]:
    lesson = await repo.get_session(request.state.db, session_id)
    participant: Participant | None = (
        next((item for item in lesson.participants if item.user_id == request.state.user.id), None)
        if lesson is not None
        else None
    )
    if lesson is None or participant is None:
        raise HTTPException(404, "Занятие не найдено.")
    if lesson.started_at is None:
        return []
    return [
        BackgroundCardView(item)
        for item in background_cards(
            participant.id,
            lesson.id,
            participant.dds_service_id,
            participant.level,
            lesson.started_at,
        )
    ]
