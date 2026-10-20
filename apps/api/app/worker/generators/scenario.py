"""Полный сценарий из конструктора evalcore, учебного сюжета и банка озвученных фраз.

Ход сценария, события и ловушки по уровню решает код. Реплики бригады — фразы банка
(scripts/voices/bank): под каждый доклад код отбирает несколько подходящих, модель выбирает
номер одной и пишет только карточку (заявитель, описание) и эталонный комментарий.
"""

import hashlib
import json
import random
from functools import lru_cache
from itertools import product
from typing import Any
from uuid import UUID, uuid5

from evalcore.scenario import build  # type: ignore[import-untyped]
from evalcore.validation import validate_reference  # type: ignore[import-untyped]

from app.core.config import ROOT
from app.core.contracts import validate_json
from app.worker.generators.phrases import candidates, consistent
from app.worker.generators.validation import (
    GenerationRejected,
    validate_facts,
    validate_response,
    with_victims,
)

# В банке нет нейтральной фразы прибытия для отказа (прибытие банка подтверждает
# происшествие, а отказ его опровергает). До дозаписи — текстом, без голоса.
REFUSAL_ARRIVAL = "На месте, проверяем сообщение заявителя."
FLOORS = ("второй", "третий", "четвёртый", "пятый", "шестой", "седьмой", "восьмой", "девятый")
ENTRANCES = ("первый", "второй", "третий", "четвёртый")
# Вымышленные заявители: имя выбирает код, у модели оно выходило одним и тем же.
CALLERS = (
    "Анна Соколова",
    "Игорь Лебедев",
    "Марина Кузнецова",
    "Сергей Новиков",
    "Ольга Морозова",
    "Дмитрий Волков",
    "Елена Павлова",
    "Андрей Козлов",
    "Наталья Фёдорова",
    "Павел Орлов",
    "Татьяна Никитина",
    "Михаил Захаров",
    "Светлана Белова",
    "Алексей Громов",
    "Юлия Тарасова",
    "Виктор Медведев",
    "Ирина Полякова",
    "Николай Ершов",
    "Галина Сорокина",
    "Роман Киселёв",
)


@lru_cache
def sources() -> dict[str, Any]:
    return json.loads((ROOT / "data/scenario-generation-scenes.json").read_text())


@lru_cache
def classifier() -> dict[str, Any]:
    return json.loads((ROOT / "data/classifier.json").read_text())


def _clarify(
    service_id: str, incident: str, card: dict[str, Any], seed: int
) -> dict[str, Any] | None:
    """Вопрос бригады, ответ на который есть в карточке: этаж или подъезд."""
    for ask in (("floor", "entrance"), ("entrance", "floor"))[seed % 2]:
        questions = [
            item
            for item in candidates(
                service_id, "clarify", incident, card, seed=seed, asks=frozenset({ask})
            )
            # «В заявке не указан» спорит с карточкой, где ответ есть.
            if "не указан" not in item["text"]
        ]
        if questions:
            break
    else:
        return None
    if ask == "floor":
        number = 2 + (seed // 2) % len(FLOORS)
        answer, label, note = FLOORS[number - 2], "этаж", f"Этаж: {number}."
    else:
        number = 1 + (seed // 2) % len(ENTRANCES)
        answer, label, note = ENTRANCES[number - 1], "подъезд", f"Подъезд: {number}."
    lines = {
        branch: candidates(service_id, slot, incident, card, seed=seed, limit=1)
        for branch, slot in (
            ("met", "clarify_ok"),
            ("wrong", "clarify_unknown"),
            ("late", "clarify_late"),
        )
    }
    if not all(lines.values()):
        return None
    return {
        "question": questions[0],
        "card_note": note,
        "answer": f"{answer.capitalize()} {label}",
        "lines": {branch: found[0] for branch, found in lines.items()},
    }


def _silence(service_id: str, incident: str, card: dict[str, Any], seed: int) -> dict | None:
    found = candidates(service_id, "status_working", incident, card, seed=seed, limit=2)
    return {"met": found[0], "late": found[1]} if len(found) == 2 else None


def generation_input(
    *, service_id: str, level: int, seed: int, weight: int | None = None
) -> dict[str, Any]:
    """Выбрать сюжет, исход и кандидатов фраз; код и маршрут проверяет конструктор 046_24."""
    pool = [scene for scene in sources()["scenes"] if scene["service"] == service_id]
    if not pool or not 1 <= level <= 4:
        raise GenerationRejected("Для службы или уровня нет поддерживаемого учебного сюжета.")
    scene = pool[seed % len(pool)]
    address = {
        "city": "Москва",
        "okrug": "",
        "district": "",
        "street": ("улица Пришвина", "Дубнинская улица", "Бескудниковский бульвар")[
            (seed // len(pool)) % 3
        ],
        "house": str(1 + (seed // 9) % 90),
        "building": "",
        "apartment": "",
    }
    constructor = {
        "incident_type_code": scene["code"],
        "target_service_id": service_id,
        "address": address,
        "victims": scene["victims"],
        "complications": [],
        "level": level,
        "weight": weight if weight is not None else min(10, level * 2),
        "seed": seed,
    }
    preview = build(constructor, classifier=classifier())
    card = {
        "victims": scene["victims"],
        "blocked_people": bool(scene.get("blocked_people", False)),
        # Один человек на весь сценарий: фразы о человеке другого пола не предлагаем.
        "exclude": ["victim_female" if seed % 2 else "victim_male"],
    }
    preview["scenario"]["card"]["blocked_people"] = card["blocked_people"]
    if preview["validation_errors"]:
        raise GenerationRejected("Конструктор отклонил исходные факты.")
    outcome = "refused" if level == 2 and scene["refusal"] else "completed"
    states = (
        ["responding", "arrived", "working", "completed"]
        if outcome == "completed"
        else ["responding", "arrived", "refused"]
    )
    phrases: dict[str, list[dict[str, Any] | None]] = {}
    for state in states:
        if outcome == "refused" and state == "arrived":
            phrases[state] = [None]
            continue
        found = candidates(service_id, state, scene["incident"], card, seed=seed)
        if not found:
            raise GenerationRejected(f"В банке фраз нет доклада «{state}» для сюжета.")
        phrases[state] = list(found)
    events: dict[str, Any] = {}
    if level >= 3:
        events["clarify"] = _clarify(service_id, scene["incident"], card, seed)
        if events["clarify"] is None:
            raise GenerationRejected("В банке фраз нет вопроса бригады для сюжета.")
    if level == 4:
        events["silence"] = _silence(service_id, scene["incident"], card, seed)
        if events["silence"] is None:
            raise GenerationRejected("В банке фраз нет ответа бригады о ходе работ.")
    facts = {
        "service": service_id,
        "level": level,
        "address": f"{address['city']}, {address['street']}, дом {address['house']}",
        "victims": scene["victims"],
        "outcome": outcome,
        "work_performed": outcome == "completed",
        "caller_name": CALLERS[(seed * 7 + level) % len(CALLERS)],
        "situation": (
            f"{scene['situation']} "
            f"{'Есть пострадавшие.' if scene['victims'] else 'Пострадавших нет.'}"
        ),
        "reports": [
            {
                "state": state,
                "options": [
                    REFUSAL_ARRIVAL if item is None else item["text"] for item in phrases[state]
                ],
            }
            for state in states
        ],
    }
    validate_facts(facts)
    return {
        "constructor": constructor,
        "preview": preview,
        "facts": facts,
        "card": card,
        "phrases": phrases,
        "events": events,
        "scene": scene["key"],
        "source_version": sources()["version"],
    }


def chosen_phrases(spec: dict[str, Any], response: dict[str, Any]) -> list[dict[str, Any]]:
    """Выбранные моделью фразы банка по порядку докладов; проверка связности фактов."""
    chosen = []
    for report in spec["facts"]["reports"]:
        # Модель повторяет текст фразы, а не номер: номера она путает со своим выбором.
        item = spec["phrases"][report["state"]][
            report["options"].index(response["choices"][report["state"]])
        ]
        chosen.append({"id": None, "text": REFUSAL_ARRIVAL, "facts": []} if item is None else item)
    if not consistent(chosen, spec["card"]):
        raise GenerationRejected("Выбранные фразы противоречат карточке или друг другу.")
    return chosen


def fallback_response(spec: dict[str, Any], seed: int = 0) -> dict[str, Any]:
    """Шаблонный путь: случайные согласованные фразы, не маскируется под результат LLM."""
    facts = spec["facts"]
    rng = random.Random(seed)
    orders: list[list[str]] = []
    for report in facts["reports"]:
        texts = list(report["options"])
        rng.shuffle(texts)
        orders.append(texts)
    for combination in product(*orders):
        choices = {
            report["state"]: text
            for report, text in zip(facts["reports"], combination, strict=True)
        }
        try:
            chosen_phrases(spec, {"choices": choices})
            break
        except GenerationRejected:
            continue
    else:
        raise GenerationRejected("Среди фраз банка нет согласованного набора докладов.")
    final = facts["reports"][-1]
    return {
        "status": "ready",
        "facts": {key: facts[key] for key in ("service", "address", "victims", "outcome")},
        "caller_name": facts["caller_name"],
        "description": f"{facts['address']}: {facts['situation']}",
        "tags": ["Учебный сценарий", facts["service"]],
        "choices": choices,
        "expected_comment": (
            f"{facts['situation']} {choices[final['state']]}"
            + (" Работы не проводились." if facts["outcome"] == "refused" else " Работы завершены.")
        ),
    }


def _line(scenario_id: UUID, name: str, item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(uuid5(scenario_id, f"line:{name}")),
        "version": 1,
        "text": item["text"],
        "audio": None,
    }


def build_scenario(
    spec: dict[str, Any],
    response: dict[str, Any],
    *,
    scenario_id: UUID,
    brigade_id: UUID,
    target_id: UUID,
    phone_ext: str,
    origin: str,
    auto_admit: bool,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Собрать карточку, эталон и достижимый план с техническими ссылками из БД."""
    validate_response(spec["facts"], response)
    chosen = chosen_phrases(spec, response)
    scenario = json.loads(json.dumps(spec["preview"]["scenario"]))
    scenario.update(
        id=str(scenario_id), origin=origin, status="approved" if auto_admit else "draft"
    )
    clarify = spec["events"].get("clarify")
    description = with_victims(response["description"], spec["facts"]["victims"])
    if clarify:
        # Ответ на вопрос бригады — в карточке: диспетчер берёт его оттуда.
        description += f" {clarify['card_note']}"
    scenario["card"].update(
        caller_name=response["caller_name"],
        description=description,
        tags=response["tags"],
    )
    states = [r["state"] for r in spec["facts"]["reports"]]
    flow = ["received", "accepted", *states]
    scenario["reference"].update(
        expected_flow=flow,
        expected_address=spec["constructor"]["address"],
        expected_service_ids=scenario["card"]["service_ids"],
        expected_call={
            "required": True,
            "service_id": spec["facts"]["service"],
            "phone_ext": phone_ext,
            "before_s": 180,
        },
        expected_comment=f"{spec['facts']['address']}: {response['expected_comment']}",
    )
    scenario["teacher_comment"] = (
        "Автодопуск нового сценария: структура, факты, ссылки и достижимость проверены."
        if auto_admit
        else "Полный сценарий; требуется утверждение преподавателя."
    ) + (" Применён шаблонный путь, это не результат ИИ." if origin != "llm" else "")
    message_ids = {state: str(uuid5(scenario_id, f"report:{state}")) for state in states}
    plan: dict[str, Any] = {
        "version": 1,
        "required_brigade_ids": [str(brigade_id)],
        "messages": [
            {
                "message": {
                    "id": message_ids[state],
                    "version": 1,
                    "text": item["text"],
                    "audio": None,
                },
                "brigade_id": str(brigade_id),
                "call_target_id": str(target_id),
                "available_after_s": 3 if index == 0 else 6,
                "expected_comment": item["text"],
                "requires_state": flow[index + 1],
                "justifies_state": state,
            }
            for index, (state, item) in enumerate(zip(states, chosen, strict=True))
        ],
        "observable_defects": [],
    }
    events: list[dict[str, Any]] = []
    if clarify:
        rng = random.Random(f"{scenario_id}:options")
        options = [
            {"key": "answer", "label": clarify["answer"]},
            {"key": "unknown", "label": "Не знаю, ищите на месте"},
            {"key": "later", "label": "Уточню у заявителя и перезвоню"},
        ]
        rng.shuffle(options)
        delay = [{"delay": message_ids["working"], "by_s": 60}]
        events.append(
            {
                "id": str(uuid5(scenario_id, "event:clarify")),
                "kind": "clarify",
                "trigger": {"on": "message", "message_id": message_ids["arrived"], "after_s": 1},
                "line": _line(scenario_id, "clarify", clarify["question"]),
                "expect": [{"action": "reply", "option_key": "answer", "within_s": 40}],
                "reply_options": options,
                "branches": {
                    "met": {
                        "line": _line(scenario_id, "clarify:met", clarify["lines"]["met"]),
                        "effects": [],
                    },
                    "wrong": {
                        "line": _line(scenario_id, "clarify:wrong", clarify["lines"]["wrong"]),
                        "effects": delay,
                    },
                    "late": {
                        "line": _line(scenario_id, "clarify:late", clarify["lines"]["late"]),
                        "effects": [],
                    },
                    "missed": {"line": None, "effects": delay},
                },
                "review": {
                    "label": "Бригада спросила то, что есть в карточке",
                    "critical": False,
                },
            }
        )
    silence = spec["events"].get("silence")
    if silence:
        plan["messages"][-1]["available_after_s"] = 90
        events.append(
            {
                "id": str(uuid5(scenario_id, "event:silence")),
                "kind": "silence",
                "trigger": {"on": "no_contact", "state": "working", "silent_s": 15},
                "line": None,
                "expect": [{"action": "call_brigade", "within_s": 40}],
                "branches": {
                    "met": {
                        "line": _line(scenario_id, "silence:met", silence["met"]),
                        "effects": [],
                    },
                    "late": {
                        "line": _line(scenario_id, "silence:late", silence["late"]),
                        "effects": [],
                    },
                    "missed": {
                        "line": None,
                        "effects": [{"delay": message_ids["completed"], "by_s": 45}],
                    },
                },
                "review": {"label": "Проверить ход работ при отсутствии связи", "critical": False},
            }
        )
    for event in events:
        event.update(
            version=1,
            actor="brigade",
            brigade_id=str(brigade_id),
            call_target_id=str(target_id),
            channel="brigade_call",
            priority="normal",
            injectable=False,
        )
    if events:
        plan["events"] = events
    validate_reference(scenario["reference"])
    validate_json(scenario, "https://arm112.local/contracts/scenario.schema.json")
    validate_json(plan, "urn:openapi#/components/schemas/TrainingPlan")
    reachable = {"received", "accepted"}
    for report in plan["messages"]:
        if report["requires_state"] not in reachable:
            raise GenerationRejected("Циклическое ожидание доклада и статуса.")
        reachable.add(report["justifies_state"])
    if not set(flow).issubset(reachable):
        raise GenerationRejected("Не у каждого статуса есть достижимое основание.")
    return scenario, plan


def phrase_ids(spec: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
    """id фраз банка в сценарии: по ним позже подставится запись bank-v1."""
    reports = {
        report["state"]: item["id"]
        for report, item in zip(
            spec["facts"]["reports"], chosen_phrases(spec, response), strict=True
        )
    }
    events: dict[str, str] = {}
    if clarify := spec["events"].get("clarify"):
        events["clarify"] = clarify["question"]["id"]
        events |= {f"clarify:{k}": v["id"] for k, v in clarify["lines"].items()}
    if silence := spec["events"].get("silence"):
        events |= {f"silence:{k}": v["id"] for k, v in silence.items()}
    return {"reports": reports, "events": events}


def digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()
