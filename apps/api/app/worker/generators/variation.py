"""Вариации учебного хода: только допустимые наборы, моменты и каталожные исходы."""

import copy
import random
from itertools import combinations
from typing import Any

from app.worker.generators.validation import GenerationRejected


def describe(data: dict[str, Any], source: dict[str, Any]) -> dict[str, Any]:
    """Фактически собранный ход для constructor, включая откат после неудачной попытки."""
    events = [
        {"key": e["key"], "kind": e["kind"], "trigger": copy.deepcopy(e["trigger"])}
        for e in data.get("events", [])
    ]
    original = {e["key"]: e for e in source.get("events", [])}
    changes = []
    if [e["key"] for e in events] != list(original):
        changes.append("набор или порядок событий")
    if any(e["trigger"] != original.get(e["key"], {}).get("trigger") for e in events):
        changes.append("моменты событий")
    terminal = data["plan"][-1]["justifies_state"]
    if terminal != source["plan"][-1]["justifies_state"]:
        changes.append("исход")
    return {"events": events, "terminal_state": terminal, "changes": changes}


def level_ok(events: list[dict[str, Any]], level: int) -> bool:
    if level < 3:
        return True
    kinds = [e["kind"] for e in events]
    return (
        kinds.count("readback_error") == 1
        and sum(k in {"clarify", "request_service"} for k in kinds) == 1
        and sum(k in {"silence", "alarm"} for k in kinds) == (level == 4)
        and len(kinds) == (3 if level == 4 else 2)
    )


def checked(data: dict[str, Any], level: int) -> bool:
    from app.worker.generators import gameplay as g

    if not level_ok(data.get("events", []), level):
        return False
    reports = {r["key"]: r for r in data["plan"]}
    states = {r["requires_state"] for r in data["plan"]}
    for event in data.get("events", []):
        if (
            event["trigger"]["on"] in {"state", "no_contact"}
            and event["trigger"]["state"] not in states
        ):
            return False
        for branch in event["branches"].values():
            for effect in branch["effects"]:
                if "replace" not in effect:
                    continue
                report = reports.get(effect["replace"])
                if (
                    event["kind"] == "readback_error"
                    and report
                    and report["justifies_state"] == "arrived"
                ):
                    continue
                phrase = g.phrase_of(effect["with"])
                # Повтор адреса — единственное разрешённое исключение места подмены.
                if (
                    not report
                    or not phrase
                    or (
                        phrase["slot"] != report["justifies_state"]
                        and not (
                            event["kind"] == "readback_error" and phrase["slot"] == "wrong_place"
                        )
                    )
                ):
                    return False
    phrases = [p for r in data["plan"] if (p := g.phrase_of(r["line"])) is not None]
    if len(phrases) != len(data["plan"]) or any(not g.fits_card(p, data["card"]) for p in phrases):
        return False
    fixed = g.fixed_facts(data)
    if g.conflicts(fixed | {f for p in phrases for f in p.get("facts", [])}):
        return False
    for swap in g.replacements(data):
        if g.conflicts(
            fixed
            | set().union(*map(set, swap.values()))
            | {
                f
                for r, p in zip(data["plan"], phrases, strict=True)
                if r["key"] not in swap
                for f in p.get("facts", [])
            }
        ):
            return False
    try:
        g.check_file({**data, "code": "ai-check", "level": level})
    except GenerationRejected:
        return False
    return True


def event_sets(template: dict[str, Any], level: int, *, vary: bool = True) -> list[dict[str, Any]]:
    """Базовые наборы уровня; зависимости и просьбы о службах проверяет check_file."""
    from app.worker.generators import gameplay as g
    from app.worker.generators.event_pool import candidates

    pool = template.get("events", [])
    if vary and level >= 2:
        pool = [*pool, *candidates(template)]
    sets = g.level_events(pool, level)
    if vary and level >= 3:
        # Пул расширяет пути: сохраняем и прежний вариант с add_silence.
        sets += g.level_events(template.get("events", []), level)
    if level == 2 and vary:
        sets = [list(group) for size in (1, 2) for group in combinations(pool, size)]
    result = []
    for events in sets:
        data = copy.deepcopy(template)
        data["events"] = copy.deepcopy(events)
        data["traps"] = [key for key in data.get("traps", []) if key in {e["key"] for e in events}]
        if level == 4:
            g.add_silence(
                data,
                {"card": data["card"]},
                [p for r in data["plan"] if (p := g.phrase_of(r["line"])) is not None],
            )
        if checked(data, level) and data not in result:
            result.append(data)
    return result


def outcome_options(data: dict[str, Any], level: int) -> list[dict[str, Any]]:
    """Другой исход берём целым ходом из каталога, а не одной противоречащей ему фразой.

    Одинаковое описание и факты карточки — намеренно узкое условие. Без такого образца
    нельзя надёжно решить, что «пожар потушили» совместимо с «ложный вызов».
    """
    from app.worker.generators import gameplay as g

    result = [data]
    for donor in g.templates():
        if (
            donor["service_id"] != data["service_id"]
            or donor["incident_type_code"] != data["incident_type_code"]
            or any(
                donor["card"].get(field) != data["card"].get(field)
                for field in (
                    "description",
                    "victims",
                    "blocked_people",
                    "ambulance_refused",
                    "service_ids",
                )
            )
            or donor["plan"][-1]["justifies_state"] == data["plan"][-1]["justifies_state"]
            or g.incident_of(donor) != g.incident_of(data)
        ):
            continue
        # Образец отказа должен быть озвучен именно для происшествия, не общей отпиской.
        refusal = donor if donor["plan"][-1]["justifies_state"] == "refused" else data
        phrase = g.phrase_of(refusal["plan"][-1]["line"])
        if (
            not phrase
            or phrase["id"] not in g.voices()
            or g.incident_of(data) not in phrase["incidents"]
        ):
            continue
        trial = copy.deepcopy(data)
        mapping = {data["plan"][-1]["key"]: donor["plan"][-1]["key"]}
        trial["plan"] = copy.deepcopy(donor["plan"])
        trial["reference"]["expected_flow"] = copy.deepcopy(donor["reference"]["expected_flow"])
        trial["outcome"] = copy.deepcopy(donor.get("outcome", {}))
        for event in trial.get("events", []):
            trigger = event["trigger"]
            if "report" in trigger:
                trigger["report"] = mapping.get(trigger["report"], trigger["report"])
            for branch in event["branches"].values():
                for effect in branch["effects"]:
                    for field in ("delay", "replace"):
                        if field in effect:
                            effect[field] = mapping.get(effect[field], effect[field])
        if checked(trial, level):
            result.append(trial)
    return result


def retime(data: dict[str, Any], rng: random.Random, level: int) -> dict[str, Any]:
    """Меняем момент по одному событию, каждый раз проверяя полный вариант."""
    from app.seed.world_lexicon import STAGE_AFTER, stage_conflict

    result = copy.deepcopy(data)
    for index, event in enumerate(result.get("events", [])):
        trigger = event["trigger"]
        if event["kind"] == "readback_error" or trigger["on"] in {"event", "inject"}:
            continue
        options = [copy.deepcopy(trigger)]
        within = max((e.get("within_s", 0) for e in event["expect"]), default=0)
        if trigger["on"] in {"message", "state"}:
            anchors = [trigger]
            if event["kind"] == "clarify":
                # Переносим вопрос из дороги на прибытие, но не местное наблюдение в дорогу.
                current = trigger.get("report")
                report = next((r for r in result["plan"] if r["key"] == current), None)
                if report and report["justifies_state"] == "responding":
                    anchors += [
                        {"on": "message", "report": r["key"]}
                        for r in result["plan"]
                        if r["justifies_state"] == "arrived"
                    ]
            options += [
                {**anchor, "after_s": seconds}
                for anchor in anchors
                for seconds in (2, 5, 8)
                if seconds + within <= 40
            ]
        elif trigger["on"] == "no_contact":
            options += [
                {"on": "no_contact", "state": state, "silent_s": seconds}
                for state in ("arrived", "working")
                if any(r["requires_state"] == state for r in result["plan"])
                for seconds in (10, 15, 20)
                if seconds + within <= 40
            ]
        rng.shuffle(options)
        for option in options:
            trial = copy.deepcopy(result)
            changed = trial["events"][index]
            changed["trigger"] = option
            if option.get("report") != trigger.get("report") and event["kind"] == "clarify":
                # Вопрос перенесён на прибытие: поиск сведений задерживает уже работы,
                # а не прозвучавший доклад о прибытии. Содержательные подмены не переносим.
                anchor = next(r for r in trial["plan"] if r["key"] == option["report"])
                following = next(
                    (r for r in trial["plan"] if r["requires_state"] == anchor["justifies_state"]),
                    None,
                )
                if following is None or any(
                    "replace" in effect
                    for b in changed["branches"].values()
                    for effect in b["effects"]
                ):
                    continue
                for branch in changed["branches"].values():
                    for effect in branch["effects"]:
                        if effect.get("delay") == option["report"]:
                            effect["delay"] = following["key"]
            if option["on"] == "no_contact":
                target = next(r for r in trial["plan"] if r["requires_state"] == option["state"])
                lines = [b.get("line") for b in changed["branches"].values()]
                if any(
                    stage_conflict(line["text"], STAGE_AFTER[option["state"]])
                    for line in lines
                    if line
                ):
                    continue
                for branch in changed["branches"].values():
                    for effect in branch["effects"]:
                        if "delay" in effect:
                            effect["delay"] = target["key"]
            if checked(trial, level):
                result = trial
                break
    order = {r["key"]: i for i, r in enumerate(result["plan"])}
    states = {r["justifies_state"]: i for i, r in enumerate(result["plan"])}

    def position(event: dict[str, Any]) -> tuple[int, int]:
        t = event["trigger"]
        return (
            order.get(t.get("report"), states.get(t.get("state"), len(order))),
            t.get("after_s", t.get("silent_s", 0)),
        )

    result["events"].sort(key=position)
    return result if checked(result, level) else data


def select(
    template: dict[str, Any], level: int, seed: int, *, enabled: bool = True
) -> dict[str, Any]:
    """Тот же каркас и seed дают тот же ход; невалидная вариация откатывается к базовой."""
    baseline_sets = event_sets(template, level, vary=False)
    if not baseline_sets:
        # У каркаса может быть только повтор адреса: обязательный вопрос даёт пул.
        baseline_sets = event_sets(template, level)
    if not baseline_sets:
        raise GenerationRejected("Каркас не содержит допустимого набора событий уровня.")
    baseline = baseline_sets[0]
    if not enabled:
        return baseline
    variants = event_sets(template, level) or [baseline]
    rng = random.Random(f"{seed}:{template['code']}:variation")
    selected = rng.choice(variants)
    selected = rng.choice(outcome_options(selected, level))
    trial = retime(selected, rng, level)
    return trial if checked(trial, level) else baseline


def weakness_weight(data: dict[str, Any], profile: dict[str, Any]) -> float:
    """Вес меняет выбор готового допустимого пути, но не сам сценарий и его уровень."""
    from app.worker.generators.personalization import matched

    return 1.0 + 8.0 * max((profile[s]["rate"] for s in matched(data, profile)), default=0.0)
