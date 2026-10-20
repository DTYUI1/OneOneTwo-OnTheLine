"""Генератор сценариев ДДС (GP-14): файл формата 2 целиком по службе, уровню и слабому месту.

Без сети и GPU. Основа — шаблон: похожий сценарий каталога `data/scenarios` той же службы
(уровень 3–4 строится из уровня 2). Генератор меняет то, что делает карточку новой: адрес (из
справочника улиц, а если он пуст — из адресов каталога), заявителя, телефон и номер карточки.
Ловушки — по уровню и слабому месту обучаемого: с уровня 3 (или при ошибках в адресе) бригада
повторяет адрес с ошибкой, с уровня 4 (или при ошибках во времени) надолго замолкает на работах.
Языковая модель (ai_provider mock|local) пишет только повествование карточки поверх шаблона —
как пакетная генерация (`scenario_narrative_system.md`, contracts/scenario-narrative.schema.json).

Результат проверяется той же схемой и связностью, что файлы каталога (`check`); негодное
повествование отбрасывается, негодный сценарий — целиком.
"""

import json
import random
from copy import deepcopy
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

from app.core.config import ROOT
from app.core.contracts import registry
from app.seed.scenarios import SCHEMA, line_text, problems
from app.seed.world_lexicon import service_mentions

NARRATIVE_SCHEMA = "https://arm112.local/contracts/scenario-narrative.schema.json"
LEVELS = (1, 2, 3, 4)
# Слабые места, которые генератор умеет усилить (ключи критериев evalcore).
FOCUS_TRAPS = {"address": "readback", "reaction_time": "silence", "handling_time": "silence"}
# Вымышленные заявители: учебные данные без реальных людей.
CALLERS = (
    "Белова Анна Сергеевна",
    "Волков Игорь Петрович",
    "Григорьева Марина Олеговна",
    "Дмитриев Олег Николаевич",
    "Ершова Татьяна Викторовна",
    "Жуков Павел Андреевич",
    "Зайцева Ольга Михайловна",
    "Кузнецов Сергей Иванович",
    "Лебедева Наталья Юрьевна",
    "Морозов Алексей Дмитриевич",
    "Никитина Елена Васильевна",
    "Орлов Виктор Степанович",
)
# Доклад, который упоминает прежний адрес, заменяется нейтральным — по статусу, который он
# обосновывает (голос основы в этом случае не подходит, доклад уходит текстом).
NEUTRAL_LINES = {
    "responding": "Вызов принят, бригада выехала.",
    "arrived": "Бригада на месте, {street}, дом {house}.",
    "working": "Приступили к работам.",
    "completed": "Работы завершены, бригада возвращается.",
    "refused": "Работы не потребовались, бригада возвращается.",
}


def _validator(schema: str) -> Draft202012Validator:
    return Draft202012Validator(
        {"$ref": schema}, registry=registry(), format_checker=FormatChecker()
    )


def check(data: dict[str, Any], services: set[str]) -> list[str]:
    """Ошибки сценария: схема scenario-file и связность, как у файлов каталога."""
    errors = sorted(_validator(SCHEMA).iter_errors(data), key=lambda item: list(item.absolute_path))
    if errors:
        return [
            f"{'/'.join(str(part) for part in error.absolute_path) or 'файл'}: {error.message}"
            for error in errors[:5]
        ]
    return problems(data, data["code"], services)


def _stem(street: str) -> str:
    """Основа названия улицы без типа: «Бескудниковский бульвар» → «бескуд»."""
    kinds = {"улица", "проспект", "шоссе", "бульвар", "переулок", "проезд", "площадь"}
    words = [word for word in street.lower().split() if word not in kinds]
    return (words[0] if words else street.lower())[:6]


def addresses(catalog: list[dict[str, Any]], streets: list[dict[str, str]]) -> list[dict[str, str]]:
    """Улицы для подстановки: справочник улиц, а если он пуст — адреса каталога."""
    if streets:
        return [
            {"street": item["name"], "okrug": item["okrug"], "district": item["district"]}
            for item in streets
        ]
    seen: dict[str, dict[str, str]] = {}
    for data in catalog:
        address = data["card"]["address"]
        seen.setdefault(
            address["street"],
            {
                "street": address["street"],
                "okrug": address["okrug"],
                "district": address["district"],
            },
        )
    return list(seen.values())


def _bases(
    catalog: list[dict[str, Any]], service_id: str, level: int, focus: str | None
) -> list[dict[str, Any]]:
    """Шаблоны службы с самостоятельным планом докладов; 3–4 строятся из уровня 2.

    В новом каталоге события есть у всех рабочих сценариев. Генератор заменяет их своими
    ловушками, поэтому основой служит сам план: принятие и работа бригады до конца. Смена
    задачи внутри доклада пока не переносится: её эталон и факты зависят от исходной сцены.
    """
    own = [
        item
        for item in catalog
        if item["service_id"] == service_id
        and item.get("plan")
        and "accepted" in item["reference"]["expected_flow"]
        and not any(report.get("task_change") for report in item["plan"])
        and not (
            item["reference"]["expected_call"]["required"]
            and item["reference"]["expected_call"].get("contact_role")
        )
    ]
    if not own and service_id == "GKH":
        # В текущем каталоге ЖКХ только задача со звонком заявителю: её телефон добавляет
        # преподаватель. Автономный генератор использует прежнюю доверенную линейную задачу
        # с трубой — только как текстовую основу, без старого seed/id/озвучки.
        own = json.loads((ROOT / "data/generator/gkh-linear.json").read_text(encoding="utf-8"))
    target = min(level, 2)
    bases = [item for item in own if item["level"] == target] or own
    if focus == "status_flow":
        # Ход статусов — слабое место: берём сценарии с отказом от работ, где ход сложнее.
        tricky = [item for item in bases if item["reference"]["expected_flow"][-1] != "completed"]
        bases = tricky or bases
    return bases


def _readback(street: str, house: str, wrong: str, first: str, arrival: str | None) -> dict:
    effects: list[dict[str, Any]] = []
    if arrival is not None:
        effects = [
            {
                "replace": arrival,
                "with": f"Диспетчер, мы на месте: {street}, дом {wrong}. Вызова здесь нет. "
                "Проверьте адрес!",
            },
            {"delay": arrival, "by_s": 45},
        ]
    return {
        "key": "readback",
        "kind": "readback_error",
        "trigger": {"on": "message", "after_s": 1, "report": first},
        "line": f"Диспетчер, как поняли? {street}, дом {wrong}, выезжаем!",
        "expect": [{"action": "correct_readback", "option_key": "fix", "within_s": 39}],
        "reply_options": [
            {"key": "fix", "label": f"Поправка по адресу: {street}, {house}"},
            {"key": "ok", "label": "Понял"},
        ],
        "branches": {
            "met": {"line": f"Понял, {street}, дом {house}, едем.", "effects": []},
            "wrong": {"line": None, "effects": effects},
            "missed": {"line": None, "effects": effects},
        },
        "review": {"label": "Бригада повторила адрес с ошибкой", "critical": True},
    }


def _silence(state: str, last: str) -> dict:
    return {
        "key": "silence",
        "kind": "silence",
        "trigger": {"on": "no_contact", "state": state, "silent_s": 20},
        "line": None,
        "expect": [{"action": "call_brigade", "within_s": 20}],
        "branches": {
            "met": {"line": "Работы идут, доложим по завершении.", "effects": []},
            "late": {"line": "Работы продолжаются, скоро закончим.", "effects": []},
            "missed": {"line": None, "effects": [{"delay": last, "by_s": 45}]},
        },
        "review": {"label": "Бригада долго работала без доклада", "critical": False},
    }


def _parts(
    data: dict[str, Any], catalog: list[dict[str, Any]], house: str, wrong: str
) -> dict[str, list[dict[str, Any]]]:
    """Варианты частей для ввода без микрофона: один верный и похожие ошибки (эталон, 6)."""
    card = data["card"]
    street = card["address"]["street"]
    what = card["incident_class"]
    others = sorted({item["card"]["incident_class"] for item in catalog} - {what})[:2]
    people = "Есть пострадавшие" if card["victims"] else "Пострадавших нет"
    other_people = "Пострадавших нет" if card["victims"] else "Есть пострадавшие"

    def options(correct: str, *wrongs: str) -> list[dict[str, Any]]:
        values = [{"text": correct[:60], "correct": True}]
        for text in wrongs:
            if text[:60] not in {item["text"] for item in values}:
                values.append({"text": text[:60], "correct": False})
        return values[:3]

    return {
        "who": options(
            f"Диспетчер службы {data['service_id']}",
            f"Служба {data['service_id']}",
            "Это диспетчер",
        ),
        "address": options(f"{street}, {house}", f"{street}, {wrong}", f"{street}, {house}0"),
        "what": options(what, *others),
        "people": options(people, other_people),
        "decision": options("Высылаю бригаду", "Работ не требуется", "Передаю в другую службу"),
    }


def generate(
    catalog: list[dict[str, Any]],
    *,
    service_id: str,
    level: int,
    seed: int,
    streets: list[dict[str, str]] | None = None,
    focus: str | None = None,
) -> dict[str, Any]:
    """Новый сценарий формата 2 по шаблону; ValueError — у службы нет ни одного шаблона."""
    if level not in LEVELS:
        raise ValueError("Уровень сценария — с 1 по 4.")
    bases = _bases(catalog, service_id, level, focus)
    if not bases:
        raise ValueError(f"Для службы {service_id} нет сценариев-шаблонов.")
    rng = random.Random(seed)
    base = rng.choice(bases)
    data = deepcopy(base)
    for name in ("id", "replaces", "events", "traps", "input_parts", "outcome", "$comment"):
        data.pop(name, None)

    old_stem = _stem(base["card"]["address"]["street"])
    place = rng.choice(addresses(catalog, streets or []))
    house = str(rng.randint(1, 120))
    wrong = str(int(house) + rng.choice((2, 4, 10)))
    address = {**base["card"]["address"], **place, "house": house, "building": ""}
    street = address["street"]

    code = f"gen-{service_id.lower()}-{level}-{seed & 0xFFFFFFFF:08x}"
    data.update(code=code, version=1, level=level)
    data["weight"] = max(1, min(10, base["weight"] + level - base["level"]))
    card = data["card"]
    card.update(
        address=address,
        caller_name=rng.choice(CALLERS),
        phone_aon=f"+7900{rng.randrange(10**7):07d}",
        number=f"9{rng.randrange(10**7):07d}",
        tags=[],
    )
    if card.get("phone_provided"):
        card["phone_provided"] = card["phone_aon"]
    data["reference"]["expected_address"] = deepcopy(address)
    for report in data["plan"]:
        text = line_text(report["line"])
        # События шаблона удалены выше: фраза о приехавшей по их просьбе службе
        # иначе остаётся без вызова и не проходит новый линтер связности.
        external_arrived = any(item.present for item in service_mentions(text, service_id))
        if old_stem in text.lower() or external_arrived:
            neutral = NEUTRAL_LINES.get(report["justifies_state"], "Бригада на связи.")
            report["line"] = neutral.format(street=street, house=house)
    data["reference"]["expected_comment"] = (
        f"{card['description']} {line_text(data['plan'][-1]['line'])}"
    )

    traps: list[str] = []
    if level >= 3 or FOCUS_TRAPS.get(focus or "") == "readback":
        arrival = next(
            (item["key"] for item in data["plan"] if item["justifies_state"] == "arrived"), None
        )
        data.setdefault("events", []).append(
            _readback(street, house, wrong, data["plan"][0]["key"], arrival)
        )
        traps.append("readback")
    if (level >= 4 or FOCUS_TRAPS.get(focus or "") == "silence") and len(data["plan"]) > 1:
        last = data["plan"][-1]
        data.setdefault("events", []).append(_silence(last["requires_state"], last["key"]))
    if traps:
        data["traps"] = traps
    data["input_parts"] = _parts(data, catalog, house, wrong)

    what = {
        "readback": "бригада повторит адрес с ошибкой",
        "silence": "бригада надолго замолчит на работах",
    }
    extras = [what[item["key"]] for item in data.get("events", [])]
    data["teacher_comment"] = (
        f"Сгенерировано автоматически по сценарию «{base['code']}» для уровня {level}"
        + (f", слабое место — {focus}" if focus else "")
        + (f"; ловушки: {', '.join(extras)}" if extras else "")
        + ". Проверьте и утвердите или отклоните."
    )
    return data


def narrative_facts(data: dict[str, Any]) -> str:
    """Факты карточки для модели — тот же whitelist, что у пакетной генерации."""
    card = data["card"]
    facts = {
        "incident_type_code": card.get("incident_type_code"),
        "incident_class": card.get("incident_class"),
        "address": card.get("address"),
        "victims": card.get("victims"),
        "ambulance_refused": card.get("ambulance_refused"),
        "blocked_people": card.get("blocked_people"),
        "emergency": card.get("emergency"),
        "complications": data["complications"],
    }
    return json.dumps(facts, ensure_ascii=False, sort_keys=True)


def apply_narrative(data: dict[str, Any], narrative: Any) -> dict[str, Any] | None:
    """Сценарий с повествованием модели или None — повествование негодно и отброшено.

    Годно только повествование по схеме, в котором названа улица карточки: модель не должна
    уводить заявителя на другой адрес.
    """
    if not isinstance(narrative, dict) or any(_validator(NARRATIVE_SCHEMA).iter_errors(narrative)):
        return None
    street = data["card"]["address"]["street"]
    if _stem(street) not in str(narrative["description"]).lower():
        return None
    result = deepcopy(data)
    card = result["card"]
    card["caller_name"] = narrative["caller_name"]
    card["description"] = narrative["description"]
    card["tags"] = list(narrative["tags"])
    result["reference"]["expected_comment"] = (
        f"{card['description']} {line_text(result['plan'][-1]['line'])}"
    )
    return result


async def generate_checked(
    catalog: list[dict[str, Any]],
    services: set[str],
    *,
    service_id: str,
    level: int,
    seed: int,
    streets: list[dict[str, str]] | None = None,
    focus: str | None = None,
    llm: Any = None,
) -> tuple[dict[str, Any], str] | None:
    """Сценарий и его источник (`template` | `llm`) или None — сценарий не прошёл проверку.

    `llm` — провайдер с `complete_json` (worker/providers); None или выключенный — шаблон.
    """
    data = generate(
        catalog, service_id=service_id, level=level, seed=seed, streets=streets, focus=focus
    )
    origin = "template"
    if llm is not None and getattr(llm, "name", "off") != "off":
        narrated = apply_narrative(data, await llm.complete_json(narrative_facts(data)))
        if narrated is not None:
            data, origin = narrated, "llm"
    if check(data, services):
        return None
    return data, origin
