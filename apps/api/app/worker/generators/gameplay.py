"""Новая история на каркасе сценария формата 2 (HQ-001, вариант B).

Шаблон — ручной сценарий каталога `data/scenarios` (brikkerdev): от него остаются
адрес, описание и реплики событий; набор событий, моменты и допустимый исход
выбираются по seed до запроса модели. Сохраняется ввод по частям — повтор адреса бригадой
озвучен только для адресов шаблонов, поэтому генератор адрес не меняет. Новое:
- код — заявитель, телефон, номер карточки;
- модель — доклады о ходе дела: под каждый код отбирает фразы банка того же места в разговоре
  и происшествия (и реплику шаблона), модель выбирает фразы одной истории. Голос фраз — из
  манифестов `data/voices/bank-v*`. Описание заявителя — дословно шаблона: пересказ моделью
  ничего не давал, а она дописывала в него исход из докладов.

Эталонный комментарий и «что было дальше» код собирает из описания и выбранных докладов —
так же, как их пишет brikkerdev. Не прошло проверку — шаблонный путь, честно `template`.
"""

import copy
import json
import os
import random
import re
from collections import Counter
from functools import lru_cache
from itertools import combinations
from typing import Any
from uuid import UUID

from app.core.config import ROOT
from app.worker.generators.phrases import bank, candidates, conflicts, fits_card
from app.worker.generators.validation import (
    SERVICES,
    GenerationRejected,
    validate_gameplay,
    validate_gameplay_facts,
)

VOICES = ROOT / "data/voices"
PROMPT = ROOT / "apps/api/app/worker/prompts/scenario_gameplay_system.md"
CANDIDATES = 4
# Новый заявитель — того же пола, что в шаблоне: в описании бывает «хозяйка», «сама».
CALLERS_MALE = (
    "Лебедев Игорь Андреевич",
    "Новиков Сергей Олегович",
    "Волков Дмитрий Игоревич",
    "Козлов Андрей Викторович",
    "Морозов Алексей Петрович",
    "Фёдоров Михаил Сергеевич",
    "Егоров Николай Иванович",
    "Смирнов Павел Дмитриевич",
    "Захаров Роман Алексеевич",
    "Макаров Владимир Юрьевич",
)
CALLERS_FEMALE = (
    "Соколова Анна Сергеевна",
    "Кузнецова Марина Олеговна",
    "Морозова Ольга Викторовна",
    "Павлова Елена Андреевна",
    "Васильева Наталья Игоревна",
    "Попова Ирина Михайловна",
    "Новикова Юлия Петровна",
    "Фролова Светлана Николаевна",
    "Комарова Татьяна Алексеевна",
    "Орехова Людмила Ивановна",
)
PHONE_FIELDS = ("phone_aon", "phone_provided", "phone_scene")
# Места, где фраза рассказывает историю; «Принял, выезжаем» подходит к любой.
STORY_SLOTS = frozenset({"arrived", "working", "completed", "refused", "update"})
# Служебные слова не говорят о ситуации: по ним фразы не сближаем.
COMMON = frozenset(
    {
        "бригад",
        "работ",
        "диспе",
        "приня",
        "понял",
        "прибы",
        "месте",
        "сейча",
        "закон",
        "провер",
        "вызов",
        "уезжа",
        "возвр",
        "расчё",
        "расче",
        "экипа",
        "наряд",
        "механ",
        "завер",
        "проводи",
        "нужно",
        "будем",
        "очень",
        "потом",
        "тольк",
        "здесь",
        "внутр",
        "всё",
        "через",
        "после",
    }
)
# Уровни 3–4 — каркас уровня 2: у шаблонов каталога уровни 1–2, события уровня есть в них.
TEMPLATE_LEVEL = {1: 1, 2: 2, 3: 2, 4: 2}
ASKS = frozenset({"clarify", "request_service"})
HARD = frozenset({"silence", "alarm"})
# Ход, по которому генерируем: у сценария «не наша карточка» нет хода работ.
FLOWS = {
    ("responding", "arrived", "working", "completed"),
    ("responding", "arrived", "completed"),
    ("responding", "arrived", "refused"),
}


@lru_cache
def templates() -> tuple[dict[str, Any], ...]:
    from app.seed.scenarios import load_catalog

    found = load_catalog(set(SERVICES)).scenarios
    return tuple(
        data
        for data in found
        if tuple(item["justifies_state"] for item in data["plan"]) in FLOWS
        and all(phrase_of(item["line"]) for item in data["plan"])
        # Шаблоны, связные только по списку исключений линтера, — не каркас: новый
        # сценарий исключение не наследует (`AWAITING_SERVICE_MENTION`).
        and not lint_as_new(data)
    )


@lru_cache
def voices() -> dict[str, str]:
    """id фразы банка → путь записи (самый новый набор, где она есть)."""
    paths: dict[str, str] = {}
    for manifest in sorted(VOICES.glob("bank-v*/manifest.json")):
        for item in json.loads(manifest.read_text(encoding="utf-8"))["messages"]:
            paths[item["id"]] = item["path"]
    return paths


def phrase_of(line: Any) -> dict[str, Any] | None:
    """Фраза банка реплики шаблона — по имени файла записи (`<id>.ogg`)."""
    if not isinstance(line, dict) or not line.get("audio"):
        return None
    phrase_id = os.path.basename(line["audio"]).removesuffix(".ogg")
    service = phrase_id.split(".", 1)[0]
    try:
        return next(item for item in bank(service)["phrases"] if item["id"] == phrase_id)
    except (FileNotFoundError, StopIteration):
        return None


def template_candidates(
    service_id: str, level: int, categories: list[str] | tuple[str, ...] = ()
) -> list[dict[str, Any]]:
    """Каркасы службы и уровня, общие для генерации и подсказки Студии."""
    pool = [t for t in templates() if t["service_id"] == service_id]
    if not pool or not 1 <= level <= 4:
        raise GenerationRejected("Для службы нет сценария-каркаса в каталоге.")
    # Нет каркаса нужного уровня (у ЖКХ — только 1) — ближайший уровень.
    target = TEMPLATE_LEVEL[level]
    nearest = min({t["level"] for t in pool}, key=lambda value: (abs(value - target), value))
    chosen = sorted((t for t in pool if t["level"] == nearest), key=lambda t: t["code"])
    if level >= 3:
        # Уровни 3–4 у каталога своих шаблонов нет: каркас уровня 2, в котором есть события
        # уровня (level_events) — ловушка повтора адреса и вопрос бригады или просьба о службе.
        from app.worker.generators.event_pool import candidates as pool_events

        kinds = [{e["kind"] for e in [*t.get("events", []), *pool_events(t)]} for t in chosen]
        chosen = (
            [t for t, k in zip(chosen, kinds, strict=True) if "readback_error" in k and k & ASKS]
            or [t for t in chosen if t.get("traps")]
            or chosen
        )
    if categories:
        from app.worker.generators.themes import category

        chosen = [t for t in chosen if category(t) in categories] or chosen
    return chosen


def pick(
    service_id: str,
    level: int,
    seed: int,
    usage: dict[str, int] | None = None,
    categories: list[str] | tuple[str, ...] = (),
) -> dict[str, Any]:
    """Воспроизводимость задают выбранный каркас и seed, сохранённые в generation_metadata."""
    pool = template_candidates(service_id, level, categories)
    usage = usage or {}
    least = min(usage.get(t["code"], 0) for t in pool)
    chosen = [t for t in pool if usage.get(t["code"], 0) == least]
    return chosen[seed % len(chosen)]


def level_events(events: list[dict[str, Any]], level: int) -> list[list[dict[str, Any]]]:
    """Наборы событий каркаса для уровня, от лучшего к запасному.

    Правило уровней (brikkerdev, HQ-009, 18.10): 3 — два события с ветками, ловушка повтора
    адреса и вопрос бригады или просьба о службе; 4 — плюс тревога или молчание бригады
    (молчания в каркасе нет — его добавит add_silence). Без ловушки в каркасах службы (ЖКХ) —
    вопросы и просьбы шаблона. Лишнее событие убирается, а не остаётся:
    иначе уровень 3 выходит сложностью уровня 4. Последние наборы — запас на случай, когда
    урезанный каркас не проходит проверку связности.
    """
    if level < 3:
        return [events]
    readback = [e for e in events if e["kind"] == "readback_error"][:1]
    asks = [e for e in events if e["kind"] in ASKS]
    hard = [e for e in events if e["kind"] in HARD]
    cores = [[*readback, ask] for ask in asks] if readback else [asks[:2]]
    sets = cores if level == 3 else [[*core, h] for core in cores for h in hard] or cores
    sets += [[e for e in events if level == 4 or e["kind"] not in HARD], events]
    order = {id(e): index for index, e in enumerate(events)}
    unique: list[list[dict[str, Any]]] = []
    for found in sets:
        found = sorted(found, key=lambda e: order[id(e)])
        if found not in unique:
            unique.append(found)
    return unique


def event_lines(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Реплики событий и веток — как в плане после загрузки, с ветками «служба вызвана
    заранее», которые достраивает загрузчик (`service_defaults`)."""
    from app.seed.service_defaults import with_service_defaults

    data = with_service_defaults(data)
    lines = []
    for event in data.get("events", []):
        lines.append(event.get("line"))
        for branch in event["branches"].values():
            lines.append(branch.get("line"))
            # Подмена доклада веткой — тоже реплика сценария.
            lines.extend(effect.get("with") for effect in branch["effects"] if "replace" in effect)
    return [line for line in lines if line]


def replacements(data: dict[str, Any]) -> list[dict[str, list[str]]]:
    """Подмены докладов веткой события: ключ доклада плана → факты реплики, которая звучит
    вместо него («Бабушку госпитализируем» вместо «от госпитализации отказалась»)."""
    from app.seed.service_defaults import with_service_defaults

    found = []
    for event in with_service_defaults(data).get("events", []):
        for branch in event["branches"].values():
            swap = {
                effect["replace"]: sorted((phrase_of(effect["with"]) or {}).get("facts", ()))
                for effect in branch["effects"]
                if "replace" in effect
            }
            if swap:
                found.append(swap)
    return found


def fixed_facts(data: dict[str, Any]) -> set[str]:
    """Факты реплик, которые не меняются (события, ветки): с ними доклады не спорят.

    Подмена доклада веткой — не общий факт, а другой исход того же доклада: её сверяет
    `chosen_phrases` с остальными докладами (`replacements`).
    """
    from app.seed.service_defaults import with_service_defaults

    swapped = {
        json.dumps(effect["with"], sort_keys=True)
        for event in with_service_defaults(data).get("events", [])
        for branch in event["branches"].values()
        for effect in branch["effects"]
        if "replace" in effect
    }
    return {
        fact
        for line in event_lines(data)
        if json.dumps(line, sort_keys=True) not in swapped
        and (phrase := phrase_of(line)) is not None
        for fact in phrase.get("facts", ())
    }


def incident_of(data: dict[str, Any]) -> str:
    """Происшествие банка сценария — общее у всех его реплик (так их и проверяет каталог:
    фраза подходит к происшествию сценария или ко всем); нет общего — самое частое."""
    lines = [item["line"] for item in data["plan"]] + event_lines(data)
    sets = [
        set(phrase["incidents"]) - {"*"}
        for line in lines
        if (phrase := phrase_of(line)) is not None and phrase["incidents"] != ["*"]
    ]
    common = set.intersection(*sets) if sets else set()
    if common:
        return sorted(common)[0]
    found = Counter(incident for group in sets for incident in group)
    return found.most_common(1)[0][0] if found else "*"


def new_caller(template: dict[str, Any], seed: int) -> dict[str, str]:
    """Заявитель и телефон сценария вместо шаблонных (HQ-001, ответ brikkerdev 18.10).

    В репликах их нет, варианты ответа бригаде ссылаются на карточку (`{caller_name}`,
    `{caller_phone}`, `app.seed.card_fields`) — подставит загрузчик. Пол — по отчеству
    шаблона; номер — из того же вымышленного диапазона +7 900 000-…, что в каталоге."""
    card = template["card"]
    old = card.get("caller_name") or ""
    female = re.search(r"(вна|чна)$", old) is not None
    rng = random.Random(f"{seed}:{template['code']}:caller")
    name = rng.choice([n for n in (CALLERS_FEMALE if female else CALLERS_MALE) if n != old])
    phones = {card[f] for f in PHONE_FIELDS if card.get(f)}
    fresh: dict[str, str] = {}
    for phone in sorted(phones):
        number = f"+7900000{rng.randrange(1000, 10000)}"
        while number in phones or number in fresh.values():
            number = f"+7900000{rng.randrange(1000, 10000)}"
        fresh[phone] = number
    return {"caller_name": name} | {f: fresh[card[f]] for f in PHONE_FIELDS if card.get(f)}


def gameplay_input(
    *,
    service_id: str,
    level: int,
    seed: int,
    weight: int | None = None,
    usage: dict[str, int] | None = None,
    template: dict[str, Any] | None = None,
    vary: bool = True,
    prepared: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from app.worker.generators.variation import describe, select

    source = template if template is not None else pick(service_id, level, seed, usage)
    template = (
        copy.deepcopy(prepared)
        if prepared is not None
        else select(source, level, seed, enabled=vary)
    )
    card = {
        "victims": bool(template["card"].get("victims")),
        "blocked_people": bool(template["card"].get("blocked_people")),
    }
    fixed = fixed_facts(template)
    swaps = replacements(template)
    # Фраза звучит в сценарии один раз, в том числе в ветках событий.
    taken = {line["text"] if isinstance(line, dict) else line for line in event_lines(template)}
    incident = incident_of(template)
    rng = random.Random(f"{seed}:{template['code']}")
    caller = new_caller(template, seed)
    reports, phrases = [], {}
    for index, item in enumerate(template["plan"]):
        own = phrase_of(item["line"])
        assert own is not None  # templates() берёт только каркасы с репликами банка
        # Происшествие — сценария, а не фразы шаблона: у фразы их бывает несколько.
        pool = [
            phrase
            for phrase in candidates(
                service_id, own["slot"], incident, card, seed=seed + index, limit=40
            )
            if phrase["id"] != own["id"]
            and phrase["text"] not in taken
            and phrase["id"] in voices()
            and not conflicts(fixed | set(phrase.get("facts", ())))
            # Доклад звучит и в исходе ветки, которая подменяет другой доклад: с её репликой
            # он тоже не спорит.
            and not any(
                conflicts(set(phrase.get("facts", ())).union(*map(set, swap.values())))
                for swap in swaps
                if item["key"] not in swap
            )
        ]
        if own["slot"] in STORY_SLOTS:
            # Доклады о ходе дела — только про ту же ситуацию: общие значимые слова с описанием
            # заявителя или репликой шаблона («котёнок», «шахта», «зажат»). Маленькая модель
            # плохо отличает соседний сюжет того же типа, поэтому чужие ей не показываем.
            anchor = stems(template["card"]["description"]) | stems(own["text"])
            pool = [phrase for phrase in pool if len(stems(phrase["text"]) & anchor) >= 2]
        # Линтер каталога (scenario_lint) — по каждой фразе в каркасе: вызванная по просьбе
        # бригады служба в докладах упоминается, невызванной на месте нет и т. п.
        found = [phrase for phrase in pool if lint_clean(template, index, phrase)][:CANDIDATES]
        options = [own, *found]
        rng.shuffle(options)
        state = item["justifies_state"]
        phrases[state] = options
        reports.append({"state": state, "options": [phrase["text"] for phrase in options]})
    facts = {
        "kind": "gameplay",
        "service": service_id,
        "level": level,
        "victims": card["victims"],
        "caller_name": caller["caller_name"],
        "situation": template["card"]["description"],
        "reports": reports,
    }
    validate_gameplay_facts(facts)
    return {
        "template": template,
        "seed": seed,
        "base_template": source,
        "variation": describe(template, source),
        "facts": facts,
        "phrases": phrases,
        "card": card,
        "fixed": sorted(fixed),
        "replacements": swaps,
        "caller": caller,
        "scene": template["code"],
        "weight": weight,
        "source_version": f"{template['code']}:v{template['version']}",
    }


def chosen_phrases(spec: dict[str, Any], response: dict[str, Any]) -> list[dict[str, Any]]:
    chosen = []
    for report in spec["facts"]["reports"]:
        text = response["choices"][report["state"]]
        chosen.append(spec["phrases"][report["state"]][report["options"].index(text)])
    keys = [item["key"] for item in spec["template"]["plan"]]
    said = {key: set(item.get("facts", ())) for key, item in zip(keys, chosen, strict=True)}
    # Ход без подмен и каждый исход ветки, где реплика звучит вместо доклада.
    scenes = [set(spec["fixed"]) | set().union(*said.values())]
    for swap in spec["replacements"]:
        kept = [facts for key, facts in said.items() if key not in swap]
        scenes.append(set(spec["fixed"]).union(*kept, *map(set, swap.values())))
    if any(map(conflicts, scenes)) or not all(fits_card(item, spec["card"]) for item in chosen):
        raise GenerationRejected("Выбранные доклады противоречат карточке или событиям.")
    return chosen


def report_phrase_ids(data: dict[str, Any]) -> dict[str, str]:
    """Идентификаторы фактически собранных докладов, включая возврат к фразам каркаса."""
    result = {}
    for report in data["plan"]:
        phrase = phrase_of(report["line"])
        assert phrase is not None
        result[report["justifies_state"]] = phrase["id"]
    return result


def variety_input(spec: dict[str, Any], used: list[dict[str, str]]) -> dict[str, Any]:
    """Разрываем совпадающие наборы одной фразой, сохраняя шаблон и минимум два варианта."""
    result = copy.deepcopy(spec)
    own = report_phrase_ids(spec["template"])
    # Сервер исключает повторы по всей истории; лимит подсказки модели ниже не
    # ослабляет разнообразие и не удаляет родную фразу или последние два варианта.
    rejected = []
    for previous in used:
        if not all(
            previous.get(state) in {p["id"] for p in options}
            for state, options in result["phrases"].items()
        ):
            continue
        for report in result["facts"]["reports"]:
            state = report["state"]
            if len(report["options"]) <= 2 or previous[state] == own[state]:
                continue
            index = next(
                i for i, p in enumerate(result["phrases"][state]) if p["id"] == previous[state]
            )
            text = report["options"].pop(index)
            result["phrases"][state].pop(index)
            rejected.append(
                {"state": state, "text": text, "why": "Этот набор докладов уже использован."}
            )
            break
    from app.worker.generators.history import prompt_history

    result["facts"].pop("used_report_sets", None)
    result["facts"].pop("rejected", None)
    result["facts"].update(prompt_history(used, spec["phrases"], rejected))
    return result


def retry_input(spec: dict[str, Any], violations: list[dict[str, Any]]) -> dict[str, Any]:
    """Вход второй попытки после прохода связности (`check_scenario`, HQ-027).

    Фраза, на которой упала проверка (она в `line` нарушения), убирается из вариантов своего
    доклада — модель не выберет её снова; реплика шаблона остаётся (каталог её проверил).
    В `rejected` модель видит, что и почему не прошло; нарушение не про доклад (ловушка,
    событие) — только там."""
    retry = copy.deepcopy(spec)
    own = {item["justifies_state"]: item["line"]["text"] for item in spec["template"]["plan"]}
    rejected = []
    for violation in violations:
        line = violation.get("line") or ""
        state = next(
            (
                report["state"]
                for report in retry["facts"]["reports"]
                for text in report["options"]
                if text != own[report["state"]] and text in line
            ),
            None,
        )
        if state is not None:
            report = next(r for r in retry["facts"]["reports"] if r["state"] == state)
            index = next(
                i for i, t in enumerate(report["options"]) if t != own[state] and t in line
            )
            text = report["options"].pop(index)
            retry["phrases"][state].pop(index)
        else:
            text = line
        rejected.append(
            {
                "state": state,
                "text": text,
                "why": f"{violation['rule']}: {violation['detail']}"[:300],
            }
        )
    retry["facts"]["rejected"] = rejected
    return retry


def fallback_response(spec: dict[str, Any], seed: int = 0) -> dict[str, Any]:
    """Шаблонный путь: история самого шаблона (её реплики согласованы вручную) — новыми
    остаются заявитель и номер. Честно `template`, не результат ИИ."""
    return {
        "choices": {
            item["justifies_state"]: item["line"]["text"] for item in spec["template"]["plan"]
        }
    }


def build_gameplay(
    spec: dict[str, Any],
    response: dict[str, Any],
    *,
    scenario_id: UUID,
    origin: str,
    auto_admit: bool,
) -> dict[str, Any]:
    """Файл формата 2: каркас шаблона, новые заявитель и доклады — связный по линтеру.

    Сочетание фраз, которое не прошло проверку каталога (например, вызванную скорую не
    упоминает ни один доклад), чинится возвратом как можно меньшего числа докладов к
    репликам шаблона; выбор модели в остальном сохраняется.
    """
    validate_gameplay(spec["facts"], response)
    states = [r["state"] for r in spec["facts"]["reports"]]
    own = {item["justifies_state"]: item["line"]["text"] for item in spec["template"]["plan"]}
    changed = [state for state in states if response["choices"][state] != own[state]]
    first_error: GenerationRejected | None = None
    for size in range(len(changed) + 1):
        for keep_template in combinations(changed, size):
            trial = {
                "choices": {
                    state: own[state] if state in keep_template else response["choices"][state]
                    for state in states
                }
            }
            try:
                return _build(
                    spec, trial, scenario_id=scenario_id, origin=origin, auto_admit=auto_admit
                )
            except GenerationRejected as error:
                first_error = first_error or error
    raise first_error or GenerationRejected("Сценарий не собран.")


def _build(
    spec: dict[str, Any],
    response: dict[str, Any],
    *,
    scenario_id: UUID,
    origin: str,
    auto_admit: bool,
) -> dict[str, Any]:
    chosen = chosen_phrases(spec, response)
    from app.worker.generators.event_pool import comment
    from app.worker.generators.variation import describe

    template = spec["template"]
    data = copy.deepcopy(template)
    number = 90_000_000 + scenario_id.int % 10_000_000
    data.update(
        id=str(scenario_id),
        code=f"ai-{scenario_id.hex[:12]}",
        version=1,
        level=spec["facts"]["level"],
        # Вес — рекомендованный подбором уровня (recommend_level), иначе шаблона.
        weight=spec.get("weight") or template["weight"],
        title=f"{template['title']} · ИИ",
        teacher_comment=(
            f"Сгенерировано по каркасу «{template['title']}»: описание сохранено; "
            "доклады, заявитель и телефон выбраны генератором. "
            + (
                "Изменены: " + ", ".join(describe(data, spec["base_template"])["changes"]) + "."
                if describe(data, spec["base_template"])["changes"]
                else "Набор событий, моменты и исход сохранены."
            )
            + comment(data)
            + (" Применён шаблонный путь, это не результат ИИ." if origin != "llm" else "")
            + (" Автодопуск: структура и фразы проверены." if auto_admit else "")
        ),
    )
    data.pop("replaces", None)  # заменяет прежние версии шаблона — не новый сценарий
    data["card"].update(number=str(number), **spec["caller"])
    for item, phrase in zip(data["plan"], chosen, strict=True):
        item["line"] = {"text": phrase["text"], "audio": voices()[phrase["id"]]}
    reports = " ".join(phrase["text"] for phrase in chosen[1:])
    data["reference"]["expected_comment"] = f"{data['card']['description']} {chosen[-1]['text']}"
    # «Поздно» у шаблона — про его историю; у новой — общий честный исход задержки.
    outcome = {
        "people": reports,
        "late": (
            "«Принята» поставлена позже норматива: бригада выехала позже, и помощь "
            "пришла позже, чем могла."
        ),
    }
    if (template.get("outcome") or {}).get("why"):
        # «Почему важно» — о происшествии вообще, с источником; ход и «поздно» — истории шаблона.
        outcome["why"] = template["outcome"]["why"]
    data["outcome"] = outcome
    if not spec.get("catalog_fallback"):
        from app.worker.generators.addresses import change

        if change(data, spec["seed"]):
            data["teacher_comment"] += (
                " Выбран новый учебный адрес; квартира, этаж и подъезд сохранены."
            )
    check_file(data)
    return data


def check_file(data: dict[str, Any]) -> None:
    from jsonschema import Draft202012Validator, FormatChecker

    from app.core.contracts import registry
    from app.seed.scenarios import SCHEMA, problems

    validator = Draft202012Validator(
        {"$ref": SCHEMA}, registry=registry(), format_checker=FormatChecker()
    )
    errors = sorted(validator.iter_errors(data), key=lambda item: list(item.absolute_path))
    if errors:
        where = "/".join(str(part) for part in errors[0].absolute_path) or "файл"
        raise GenerationRejected(f"Сценарий не по схеме файла: {where}: {errors[0].message}")
    found = problems(data, data["code"], set(SERVICES))
    if found:
        raise GenerationRejected("Сценарий не прошёл проверку связности: " + "; ".join(found))


def numbers(text: str) -> set[str]:
    return set(re.findall(r"\d+", text))


def stems(text: str) -> set[str]:
    words = re.findall(r"[а-яё]+", text.casefold().replace("ё", "е"))
    return {word[:5] for word in words if len(word) >= 5} - COMMON


def lint_as_new(data: dict[str, Any]) -> list[str]:
    """Линтер каталога для нового сценария: без исключений по коду шаблона."""
    from app.seed.scenario_lint import lint

    return lint({**data, "code": "ai-check"})


def lint_clean(template: dict[str, Any], index: int, phrase: dict[str, Any]) -> bool:
    """Фраза на месте доклада index не добавляет каркасу нарушений связности."""
    trial = copy.deepcopy(template)
    trial["plan"][index]["line"] = {"text": phrase["text"], "audio": voices()[phrase["id"]]}
    return not lint_as_new(trial)


def add_silence(data: dict[str, Any], spec: dict[str, Any], chosen: list[dict[str, Any]]) -> None:
    """Уровень 4: бригада молчит на месте — нужно ей позвонить. Как в каталоге: молчание в
    статусе перед итоговым докладом («Прибытие» или «Проведение работ»), ответ — доклад о
    работах. Добавляется, если в каркасе молчания и тревоги нет и линтер событие пропускает."""
    events = data.setdefault("events", [])
    state = data["plan"][-1]["requires_state"]
    if any(event["kind"] in HARD for event in events) or state not in ("arrived", "working"):
        return
    used = {line["text"] if isinstance(line, dict) else line for line in event_lines(data)}
    used |= {phrase["text"] for phrase in chosen}
    lines = [
        phrase
        for phrase in candidates(
            data["service_id"],
            "status_working",
            incident_of(data),
            spec["card"],
            seed=int(data["card"]["number"]),
            limit=10,
        )
        if phrase["text"] not in used and phrase["id"] in voices()
    ][:2]
    if len(lines) < 2:
        return
    final = data["plan"][-1]["key"]
    event = {
        "key": "silence",
        "kind": "silence",
        "trigger": {"on": "no_contact", "state": state, "silent_s": 20},
        "line": None,
        "expect": [{"action": "call_brigade", "within_s": 10}],
        "branches": {
            "met": {
                "line": {"text": lines[0]["text"], "audio": voices()[lines[0]["id"]]},
                "effects": [],
            },
            "late": {
                "line": {"text": lines[1]["text"], "audio": voices()[lines[1]["id"]]},
                "effects": [],
            },
            "missed": {"line": None, "effects": [{"delay": final, "by_s": 30}]},
        },
        "review": {"label": "Бригада долго работала без доклада", "critical": False},
    }
    events.append(event)
    if lint_as_new(data):
        events.remove(event)


def correction_input(
    source: dict[str, Any],
    level: int,
    seed: int,
    note: str,
    previous: dict[str, Any],
    weight: int | None = None,
) -> dict[str, Any]:
    """Тот же каркас и seed; модель выбирает целый допустимый путь и его доклады."""
    from app.worker.generators.variant_paths import template_options

    specs = {
        key: gameplay_input(
            service_id=source["service_id"],
            level=level,
            seed=seed,
            template=source,
            prepared=data,
            weight=weight,
        )
        for key, data in template_options(source, level).items()
    }
    if not specs:
        raise GenerationRejected("У каркаса нет допустимых вариантов коррекции.")
    if re.fullmatch(r"(?:хочу\s+)?(?:другой|иной)\s+исход[.!]?", note.strip().casefold()):
        previous_outcome = (
            previous.get("constructor", {}).get("variation", {}).get("terminal_state")
        )
        if previous_outcome is None:
            raise GenerationRejected(
                "У исходного сценария не сохранён исход для сравнения. "
                "Исходный черновик сохранён. Сгенерируйте новый пакет "
                "или попросите другие доклады."
            )
        specs = {
            key: spec
            for key, spec in specs.items()
            if spec["variation"]["terminal_state"] != previous_outcome
        }
        if not specs:
            raise GenerationRejected(
                "У этой истории нет другого исхода на выбранном уровне. "
                "Исходный черновик сохранён. Попросите другие доклады "
                "или сгенерируйте новый пакет."
            )
    facts = copy.deepcopy(next(iter(specs.values()))["facts"])
    texts = {p["id"]: p["text"] for p in bank(source["service_id"])["phrases"]}
    report_sets = []
    variants = []
    for key, spec in specs.items():
        reports = spec["facts"]["reports"]
        if reports not in report_sets:
            report_sets.append(reports)
        variants.append(
            {"id": key, "variation": spec["variation"], "report_set": report_sets.index(reports)}
        )
    facts.update(
        teacher_note=note,
        previous_variation=previous.get("constructor", {}).get("variation"),
        previous_reports={
            state: texts.get(phrase, phrase)
            for state, phrase in previous.get("phrases", {}).get("reports", {}).items()
        },
        variants=variants,
        report_sets=report_sets,
    )
    for spec in specs.values():
        spec["facts"]["teacher_note"] = note
    return {"facts": facts, "variants": specs}
