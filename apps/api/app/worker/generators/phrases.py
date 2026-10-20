"""Банк озвученных фраз (scripts/voices/bank): отбор кандидатов под место в разговоре.

Реплики бригад сгенерированного сценария не пишутся моделью, а берутся из банка: голос
записан заранее и во время занятия не синтезируется. Код отбирает под каждое место
несколько подходящих фраз (служба, место, происшествие, факты карточки), модель выбирает
номер одной из них. Формат и правила банка — scripts/voices/bank/README.md.
"""

import json
import random
from functools import lru_cache
from typing import Any

from app.core.config import ROOT

BANK = ROOT / "scripts/voices/bank/phrases"
CANDIDATES = 5
# Пары фактов, которые не могут быть правдой в одном сценарии.
CONFLICTS = (
    ("victims", "no_victims"),
    ("fire", "no_fire"),
    ("gas", "no_gas"),
    ("victim_male", "victim_female"),
    ("victim_child", "victim_elderly"),
    ("hospitalized", "refused_hospital"),
)
# Без пострадавших в карточке бригада не говорит о раненых, госпитализации и передаче скорой.
VICTIM_FACTS = frozenset({"victims", "hospitalized", "refused_hospital", "handed_103"})


@lru_cache
def bank(service_id: str) -> dict[str, Any]:
    return json.loads((BANK / f"{service_id}.json").read_text(encoding="utf-8"))


def phrase(service_id: str, phrase_id: str) -> dict[str, Any]:
    for item in bank(service_id)["phrases"]:
        if item["id"] == phrase_id:
            return item
    raise KeyError(phrase_id)


def conflicts(facts: set[str]) -> bool:
    return any(a in facts and b in facts for a, b in CONFLICTS)


def fits_card(item: dict[str, Any], card: dict[str, Any]) -> bool:
    facts = set(item.get("facts", ()))
    if facts & set(card.get("exclude", ())):
        return False
    if not card["victims"] and facts & VICTIM_FACTS:
        return False
    if card["victims"] and "no_victims" in facts:
        return False
    if not card.get("blocked_people") and "blocked" in facts:
        return False
    if card.get("blocked_people") and "no_blocked" in facts:
        return False
    return not conflicts(facts)


def candidates(
    service_id: str,
    slot: str,
    incident: str,
    card: dict[str, Any],
    *,
    seed: int,
    limit: int = CANDIDATES,
    asks: frozenset[str] | None = None,
) -> list[dict[str, Any]]:
    """До limit фраз места: сначала фразы происшествия, затем подходящие всегда.

    Порядок внутри групп задаёт seed, поэтому тот же вход даёт те же кандидаты.
    """
    pool = [
        item
        for item in bank(service_id)["phrases"]
        if item["slot"] == slot
        # При сборке обычного сценария условия мира ещё не наступили.
        # Условные реплики выбирает только явный обработчик соответствующего последствия.
        and not item.get("requires")
        and (incident in item["incidents"] or item["incidents"] == ["*"])
        and (asks is None or item.get("asks") in asks)
        and fits_card(item, card)
    ]
    rng = random.Random(f"{seed}:{service_id}:{slot}:{incident}")
    own = [item for item in pool if incident in item["incidents"]]
    common = [item for item in pool if item["incidents"] == ["*"]]
    rng.shuffle(own)
    rng.shuffle(common)
    return (own + common)[:limit]


def consistent(chosen: list[dict[str, Any]], card: dict[str, Any]) -> bool:
    """Выбранные фразы не спорят с карточкой и между собой."""
    facts = {fact for item in chosen for fact in item.get("facts", ())}
    return all(fits_card(item, card) for item in chosen) and not conflicts(facts)
