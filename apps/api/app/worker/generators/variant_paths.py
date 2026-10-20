"""Учебный путь без косметических отличий: конечный набор вариантов и учёт повторов."""

import copy
import hashlib
import json
import random
from collections import Counter
from collections.abc import MutableSequence
from functools import lru_cache
from typing import Any

from app.worker.generators import pairwise, variation


def without_seconds(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: without_seconds(v) for k, v in value.items() if not k.endswith("_s")}
    if isinstance(value, list):
        return [without_seconds(v) for v in value]
    return value


def signature(data: dict[str, Any], template_code: str) -> str:
    """Каркас, статусы и действия; фразы, личные сведения и секунды не различают пути."""
    reports = {r["key"]: r["justifies_state"] for r in data["plan"]}
    events = []
    for event in data.get("events", []):
        trigger = without_seconds(event["trigger"])
        if "report" in trigger:
            trigger["report"] = reports.get(trigger["report"], trigger["report"])
        events.append(
            {
                "key": event["key"],
                "kind": event["kind"],
                "trigger": trigger,
                "expect": without_seconds(event["expect"]),
            }
        )
    value = {
        "template": template_code,
        "flow": data["reference"]["expected_flow"],
        "events": events,
    }
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


class _Choice(Exception):
    def __init__(self, count: int):
        self.count = count


class _Enumeration(random.Random):
    """Перебор всех первых вариантов shuffle; остальные — штатный запас retime."""

    def __init__(self, choices: tuple[int, ...]):
        super().__init__(0)
        self.path_choices = choices
        self.index = 0

    def shuffle(self, values: MutableSequence[Any]) -> None:
        unique = []
        for value in values:
            if value not in unique:
                unique.append(value)
        values[:] = unique
        if self.index == len(self.path_choices):
            raise _Choice(len(values))
        selected = self.path_choices[self.index]
        self.index += 1
        values.insert(0, values.pop(selected))


@lru_cache(maxsize=128)
def _options(catalog: str, code: str, level: int) -> dict[str, dict[str, Any]]:
    template = next(t for t in json.loads(catalog) if t["code"] == code)
    found: dict[str, dict[str, Any]] = {}
    sets = variation.event_sets(template, level) or variation.event_sets(
        template, level, vary=False
    )
    for base in sets:
        for outcome in variation.outcome_options(base, level):
            pending: list[tuple[int, ...]] = [()]
            while pending:
                path = pending.pop()
                try:
                    data = variation.retime(outcome, _Enumeration(path), level)
                except _Choice as choice:
                    pending.extend((*path, i) for i in range(choice.count))
                    continue
                if variation.checked(data, level):
                    found.setdefault(signature(data, code), data)
    return found


def options(
    service_id: str, level: int, categories: list[str] | tuple[str, ...] = ()
) -> dict[str, tuple[dict[str, Any], dict[str, Any]]]:
    """Перебор параметров, не подбор seed. Кэш зависит от содержимого всех каркасов."""
    from app.worker.generators import gameplay as g

    catalog = json.dumps(g.templates(), sort_keys=True, ensure_ascii=False)
    return {
        sig: (template, data)
        for template in g.template_candidates(service_id, level, categories)
        for sig, data in _options(catalog, template["code"], level).items()
    }


def usage(rows: list[Any], service_id: str, level: int) -> Counter[str]:
    """Старые метаданные task06 распознаются по сохранённой вариации, без пересчёта seed."""
    counts: Counter[str] = Counter()
    available = options(service_id, level)
    seen = set()
    for row in rows:
        if row.id in seen or row.target_service_id != service_id or row.level != level:
            continue
        seen.add(row.id)
        constructor = (row.generation_metadata or {}).get("constructor", {})
        sig = constructor.get("variant_signature")
        if sig:
            counts[sig] += 1
            continue
        code = constructor.get("template")
        stored = constructor.get("variation")
        if not stored and code:
            source = next((t for t, _ in available.values() if t["code"] == code), None)
            if source is not None:
                baseline = variation.select(source, level, 0, enabled=False)
                counts[signature(baseline, code)] += 1
                continue
        for candidate, (source, data) in available.items():
            if source["code"] != code:
                continue
            if stored and all(
                without_seconds(variation.describe(data, source)[key])
                == without_seconds(stored.get(key))
                for key in ("events", "terminal_state")
            ):
                counts[candidate] += 1
                break
    return counts


def pick(
    service_id: str,
    level: int,
    seed: int,
    counts: Counter[str],
    templates: Counter[str],
    categories: list[str] | tuple[str, ...] = (),
    *,
    profile: dict[str, Any] | None = None,
    focus: bool | None = None,
    covered_pairs: set[pairwise.Pair] | None = None,
    batch_variations: dict[str, list[dict[str, Any]]] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    available = options(service_id, level, categories)
    if batch_variations:
        scores = {
            sig: min(
                distance(variation.describe(data, source), previous)
                for previous in batch_variations[source["code"]]
            )
            for sig, (source, data) in available.items()
            if batch_variations.get(source["code"])
        }
        best_by_template = {
            code: max(
                scores[sig]
                for sig, (source, _) in available.items()
                if source["code"] == code and sig in scores
            )
            for code in {available[sig][0]["code"] for sig in scores}
        }
        available = {
            sig: value
            for sig, value in available.items()
            if sig not in scores or scores[sig] == best_by_template[value[0]["code"]]
        }
    if covered_pairs is not None:
        gains = {
            sig: len(pairwise.pairs(pairwise.features(data)) - covered_pairs)
            for sig, (_, data) in available.items()
        }
        best = max(gains.values())
        available = {sig: value for sig, value in available.items() if gains[sig] == best}
    least = min(counts[sig] for sig in available)
    pool = [
        (sig, source, data) for sig, (source, data) in available.items() if counts[sig] == least
    ]
    if (
        profile
        and any(v["rate"] > 0 for v in profile.values())
        and (focus if focus is not None else seed % 5 < 3)
    ):
        # После покрытия пар и частоты путей учитываем слабые навыки. Баланс каркасов здесь
        # не отсекает нужное осложнение, но обычные 40% сохраняют прежний подбор.
        pool.sort(key=lambda item: item[0])
        weights = [variation.weakness_weight(data, profile) for _, _, data in pool]
        _, source, data = random.Random(f"{seed}:personalization").choices(pool, weights)[0]
        return source, copy.deepcopy(data)
    fewest = min(templates[source["code"]] for _, source, _ in pool)
    pool = sorted(
        (item for item in pool if templates[item[1]["code"]] == fewest), key=lambda item: item[0]
    )
    _, source, data = pool[seed % len(pool)]
    return source, copy.deepcopy(data)


def template_options(template: dict[str, Any], level: int) -> dict[str, dict[str, Any]]:
    from app.worker.generators import gameplay as g

    catalog = json.dumps(g.templates(), sort_keys=True, ensure_ascii=False)
    return _options(catalog, template["code"], level)


def distance(a: dict[str, Any], b: dict[str, Any]) -> tuple[int, int, int, float]:
    """Сначала другой исход, затем набор событий, их привязки и секунды.

    При нескольких путях максимизируем расстояние до ближайшего: не чередуем
    два варианта, забывая про уже использованные в том же пакете.
    """
    left = {(e["key"], e["kind"]): e["trigger"] for e in a.get("events", [])}
    right = {(e["key"], e["kind"]): e["trigger"] for e in b.get("events", [])}
    common = left.keys() & right.keys()
    return (
        int(a.get("terminal_state") != b.get("terminal_state")),
        len(left.keys() ^ right.keys()),
        sum(without_seconds(left[k]) != without_seconds(right[k]) for k in common),
        sum(
            abs(left[k].get(t, 0) - right[k].get(t, 0))
            for k in common
            for t in ("after_s", "silent_s")
        ),
    )


def label(stored: dict[str, Any] | None) -> str:
    if not stored:
        return ""
    names = {
        "readback_error": "ловушка адреса",
        "clarify": "вопрос бригады",
        "request_service": "запрос службы",
        "silence": "молчание бригады",
        "alarm": "тревога",
    }
    events = []
    for event in stored.get("events", []):
        trigger = event.get("trigger", {})
        moment = trigger.get("report") or trigger.get("state")
        moments = {
            "accepted": "после принятия",
            "departure": "при выезде",
            "responding": "при выезде",
            "arrival": "по прибытии",
            "arrived": "по прибытии",
            "work": "во время работ",
            "working": "во время работ",
        }
        timing = moments.get(moment, "")
        seconds = trigger.get("after_s", trigger.get("silent_s"))
        if seconds is not None:
            timing += f" +{seconds:g} с"
        events.append(
            names.get(event["kind"], event["kind"]) + (f" ({timing.strip()})" if timing else "")
        )
    outcome = {"completed": "завершено", "refused": "отказ", "redirected": "перенаправлено"}
    terminal = stored.get("terminal_state", "")
    return (
        " + ".join(events or ["без дополнительных событий"])
        + " · "
        + outcome.get(terminal, terminal)
    )
