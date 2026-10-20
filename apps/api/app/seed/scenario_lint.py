"""Линтер связности файла сценария: что услышит обучаемый, не должно противоречить само себе.

Загрузчик (`app.seed.scenarios.problems`) проверяет ссылки и полноту плана; здесь — смысл мира,
который можно проверить без прогона (прогон всех веток — `app.tools.coherence`). Правила —
классы несостыковок проверки 17.10 (`docs/coherence_night.md`, каталог инвариантов), чтобы
сценарий, собранный локальной ИИ, не попал в каталог ломаным:

- **этап** — фраза не противоречит месту в ходе работ: «поднимаемся» в ответе на вопрос из
  дороги, «разворачиваемся» после прибытия, «выезжаем» после выезда (`world_lexicon`);
- **повтор адреса** — ловушка `readback_error` срабатывает на докладе о выезде: её реплику
  говорит сам доклад (`scenario_events.carried_events`), на другом докладе она противоречит
  сказанному;
- **последствия вперёд** — событие задерживает или подменяет только доклад после того, на
  котором оно сработало: сказанное не отменить;
- **службы** — служба «на месте» в докладе только после звонка диспетчера: доклад ждёт её
  приезда (событие-просьба его держит) и в ветке «не вызвали» подменён; вызванная служба
  потом упоминается;
- **статусы** — каждый доклад ждёт статуса, который можно поставить: его обосновывает
  предыдущий доклад плана;
- **пауза** — исход события, которого ждёт доклад, решается не позже 40 с (GP-12);
- **повторы** — одна фраза в сценарии звучит один раз;
- **поля карточки** — в подписи варианта ответа только известные поля (`{caller_phone}`,
  `{caller_name}`, `{address}`) с непустым значением, в репликах их нет (`card_fields`);
- **заявитель** — звонок заявителю в эталоне (`contact_role: caller`) говорит с живым
  заявителем (HQ-019): у сценария есть блок `caller`, его сюжет есть в книгах обоих характеров
  заявителя и в таблице сюжета (`callers/plots/`) — иначе звонок ответил бы голосом дежурного
  службы «Информация принята».

Сообщения — по-русски, с ключами докладов и событий: автор сценария видит, что править.
"""

from typing import Any

from app.api.training.caller import caller_plots
from app.seed import card_fields
from app.seed.service_defaults import with_service_defaults
from app.seed.world_lexicon import SERVICE_EXTS, STAGE_AFTER, service_mentions, stage_conflict

# Пауза ожидания доклада (эталон, раздел 1, п. 5; `gating.MAX_REPORT_WAIT`).
REPORT_WAIT_S = 40
# Статусы, которые можно поставить без доклада плана: решение и выезд по вводной (GP-05).
FREE_STATES = ("accepted", "responding")
# Ветки, в которых диспетчер вызвал службу: она едет (`scenario_events.CALLED_BRANCHES`).
CALLED = ("met", "late", "already", "surprise")


def _text(line: str | dict[str, Any] | None) -> str | None:
    if line is None:
        return None
    return line if isinstance(line, str) else str(line["text"])


def _targets(event: dict[str, Any]) -> list[str]:
    found = []
    for body in event["branches"].values():
        for effect in body["effects"]:
            target = effect.get("delay") or effect.get("replace")
            if target and target not in found:
                found.append(str(target))
    return found


def _replaced(event: dict[str, Any], branch: str) -> dict[str, str]:
    """Доклад → текст подмены в ветке, считая последствия «не дождались звонка» (HQ-019)."""
    body = event["branches"].get(branch) or {"effects": []}
    awaits = body.get("awaits_call") or {}
    return {
        str(effect["replace"]): str(_text(effect["with"]))
        for effect in [*body["effects"], *awaits.get("otherwise", [])]
        if "replace" in effect
    }


def _service_of_ext(ext: str) -> str:
    return SERVICE_EXTS.get(ext, ext)


def _requested(event: dict[str, Any]) -> list[str]:
    """Номера служб, которые просит событие (кроме 112 — через неё вызывают любую)."""
    return [
        str(ext)
        for expect in event["expect"]
        if expect["action"] == "call_service"
        for ext in expect["phone_exts"]
        if str(ext) != "112"
    ]


def _card_exts(data: dict[str, Any]) -> set[str]:
    """Службы, которые 112 выслала по карточке сама: им вызов диспетчера не нужен."""
    back = {service: ext for ext, service in SERVICE_EXTS.items()}
    return {back.get(str(item), str(item)) for item in data["card"].get("service_ids", [])}


def stage_problems(data: dict[str, Any]) -> list[str]:
    """Фразы плана, событий и веток — на своём этапе хода работ."""
    found = []
    plan = data["plan"]
    keys = [report["key"] for report in plan]
    stage_before: dict[str, str] = {}
    stage = "dispatch"
    for report in plan:
        stage_before[report["key"]] = stage
        stage = STAGE_AFTER.get(report["justifies_state"], stage)
    justifies = {report["key"]: report["justifies_state"] for report in plan}
    for report in plan:
        key = report["key"]
        problem = stage_conflict(str(_text(report["line"])), stage_before[key], justifies[key])
        if problem:
            found.append(f"доклад «{key}»: {problem}")
    for event in data.get("events", []):
        where = f"событие «{event['key']}»"
        trigger = event["trigger"]
        report = trigger.get("report")
        if report not in justifies:
            continue
        after = STAGE_AFTER.get(justifies[report], "dispatch")
        carried = event["kind"] == "readback_error" and justifies[report] == "responding"
        line = _text(event["line"])
        if line and not carried:
            problem = stage_conflict(line, after)
            if problem:
                found.append(f"{where}: реплика звучит после доклада «{report}» — {problem}")
        for name, body in event["branches"].items():
            answer = _text(body["line"])
            if answer and name not in ("late", "surprise"):
                problem = stage_conflict(answer, after)
                if problem:
                    found.append(
                        f"{where}, ветка {name}: ответ звучит до следующего доклада после "
                        f"«{report}» — {problem}"
                    )
            for target, text in _replaced(event, name).items():
                if target not in justifies:
                    continue
                index = keys.index(target)
                problem = stage_conflict(text, stage_before[keys[index]], justifies[target])
                if problem:
                    found.append(f"{where}, ветка {name}: подмена «{target}» — {problem}")
    return found


def order_problems(data: dict[str, Any]) -> list[str]:
    """Повтор адреса — на докладе о выезде; последствия — только для докладов после триггера."""
    found = []
    keys = [report["key"] for report in data["plan"]]
    justifies = {report["key"]: report["justifies_state"] for report in data["plan"]}
    for event in data.get("events", []):
        where = f"событие «{event['key']}»"
        report = event["trigger"].get("report")
        if event["kind"] == "readback_error" and (
            event["trigger"]["on"] != "message" or justifies.get(report) != "responding"
        ):
            found.append(
                f"{where}: повтор адреса с ошибкой срабатывает только на докладе о выезде "
                "(доклад, обосновывающий «Начало реагирования») — его реплику говорит сам доклад"
            )
        if report not in keys:
            continue
        for target in _targets(event):
            if target in keys and keys.index(target) <= keys.index(report):
                found.append(
                    f"{where}: последствие для доклада «{target}», который звучит не позже "
                    f"триггера «{report}» — сказанное не отменить"
                )
    return found


def service_problems(data: dict[str, Any]) -> list[str]:
    """Служба на месте — только после вызова; вызванная служба потом упоминается."""
    found = []
    own = data["service_id"]
    keys = [report["key"] for report in data["plan"]]
    events = data.get("events", [])
    by_112 = _card_exts(data)
    for report in data["plan"]:
        for mention in service_mentions(str(_text(report["line"])), own):
            if not mention.present or mention.ext in by_112:
                continue
            guards = [
                event
                for event in events
                if mention.ext in _requested(event)
                and report["key"] in _targets(event)
                and report["key"] in _replaced(event, "missed")
            ] + [
                fallback
                for event in events
                if mention.ext in _requested(event) and report["key"] in _targets(event)
                for fallback in events
                if fallback["trigger"].get("event") == event["key"]
                and report["key"] in _replaced(fallback, "missed")
            ]
            if not guards:
                found.append(
                    f"доклад «{report['key']}»: служба {_service_of_ext(mention.ext)} на месте, "
                    "а вызвать её диспетчеру не предложено: нужна просьба о службе "
                    "(`request_service`) до этого доклада, которая его держит и в ветке "
                    "missed подменяет"
                )
    for event in events:
        for name, body in event["branches"].items():
            texts = [_text(body["line"])] + list(_replaced(event, name).values())
            for text in texts:
                for mention in service_mentions(text or "", own):
                    if mention.present and mention.ext in _requested(event) and name not in CALLED:
                        found.append(
                            f"событие «{event['key']}», ветка {name}: служба "
                            f"{_service_of_ext(mention.ext)} на месте, хотя её не вызвали"
                        )
    for event in events:
        need = _requested(event)
        if event["kind"] != "request_service" or not need or event["trigger"].get("on") == "event":
            continue
        report = event["trigger"].get("report")
        later = keys[keys.index(report) + 1 :] if report in keys else keys
        replaced = _replaced(event, "met")
        # Ответ ветки met не в счёт: вызвав службу, диспетчер сам сообщает бригаде, а бригада
        # не перезванивает ради «Понял» (HQ-055) — о службе говорит доклад после просьбы.
        texts = [replaced.get(key) or _text(_report(data, key)["line"]) for key in later]
        mentioned = any(
            mention.ext in need for text in texts for mention in service_mentions(text or "", own)
        )
        if not mentioned:
            found.append(
                f"событие «{event['key']}»: служба {_service_of_ext(need[0])} вызвана по просьбе "
                "бригады, а дальше бригада о ней ни слова — доклад после просьбы должен "
                "упомянуть совместную работу с ней (приехала, забрала, вместе)"
            )
    return found


def _report(data: dict[str, Any], key: str) -> dict[str, Any]:
    return next(report for report in data["plan"] if report["key"] == key)


def status_problems(data: dict[str, Any]) -> list[str]:
    """Доклад ждёт статуса, который можно поставить: его обосновал доклад раньше по плану."""
    found = []
    justified: set[str] = set(FREE_STATES)
    order = ("accepted", "responding", "arrived", "working", "completed", "refused")
    for report in data["plan"]:
        wanted = report["requires_state"]
        if wanted not in justified and not any(
            order.index(state) >= order.index(wanted) for state in justified if state in order
        ):
            found.append(
                f"доклад «{report['key']}» ждёт статуса «{wanted}», а его не обосновывает ни "
                "один доклад раньше по плану — карточку не закрыть"
            )
        justified.add(report["justifies_state"])
    return found


def changes_world(event: dict[str, Any], chained: set[str]) -> bool:
    """Исход события на сроке что-то меняет: доклад ждёт его, бригада отвечает репликой
    или от него срабатывает другое событие."""
    branches = event["branches"].values()
    return (
        event["key"] in chained
        or any(body["effects"] for body in branches)
        or bool((event["branches"].get("missed") or {}).get("line"))
    )


def deadline_s(event: dict[str, Any]) -> int | None:
    """Через сколько секунд от начала отсчёта мир узнаёт исход события; None — событие
    подаёт преподаватель (inject): срок идёт от его вводной, доклады её не ждут."""
    trigger = event["trigger"]
    within = max(
        (step.get("within_s", 0) for step in event["expect"] if step["action"] != "answer_call"),
        default=0,
    )
    if trigger["on"] == "no_contact":
        return int(trigger["silent_s"]) + within
    if trigger["on"] in ("message", "event"):
        return int(trigger["after_s"]) + within
    return None


def wait_problems(data: dict[str, Any]) -> list[str]:
    """Исход события, которого ждёт доклад, — не позже 40 с от начала отсчёта (GP-12)."""
    events = data.get("events", [])
    chained = {e["trigger"]["event"] for e in events if e["trigger"]["on"] == "event"}
    found = []
    for event in events:
        deadline = deadline_s(event)
        if deadline is None or not changes_world(event, chained) or deadline <= REPORT_WAIT_S:
            continue
        found.append(
            f"событие «{event['key']}» решается через {deadline} с — обучаемый ждёт доклада "
            f"дольше {REPORT_WAIT_S} с"
        )
    return found


def repeat_problems(data: dict[str, Any]) -> list[str]:
    """Одна фраза — один раз на сценарий (в том числе в разных ветках)."""
    seen: dict[str, str] = {}
    found = []

    def note(text: str | None, where: str) -> None:
        if not text:
            return
        if text in seen and seen[text] != where:
            found.append(f"фраза «{text}» звучит дважды: {seen[text]} и {where}")
        seen.setdefault(text, where)

    for report in data["plan"]:
        note(_text(report["line"]), f"доклад «{report['key']}»")
    for event in data.get("events", []):
        note(_text(event["line"]), f"событие «{event['key']}»")
        replaced: set[str] = set()
        for name, body in event["branches"].items():
            note(_text(body["line"]), f"событие «{event['key']}», ветка {name}")
            for text in _replaced(event, name).values():
                # Одна подмена на несколько веток — одна реплика (seed).
                if text not in replaced:
                    note(text, f"событие «{event['key']}», подмена в ветке {name}")
                replaced.add(text)
    return found


def caller_problems(data: dict[str, Any]) -> list[str]:
    """Звонок заявителю — разговор с живым заявителем: блок `caller` с сюжетом из книг."""
    calls = [data["reference"].get("expected_call") or {}]
    calls += [
        (report.get("task_change") or {}).get("expected_call") or {} for report in data["plan"]
    ]
    caller = data.get("caller")
    found = []
    if caller is None and any(call.get("contact_role") == "caller" for call in calls):
        found.append(
            "звонок заявителю в эталоне, а блока caller нет: заявитель ответил бы голосом "
            "дежурного службы — добавьте caller {plot, character} (docs/dds_caller.md)"
        )
    if caller is not None and caller["plot"] not in caller_plots():
        found.append(
            f"заявитель: сюжета «{caller['plot']}» нет в книгах обоих характеров и таблицах "
            "сюжетов scripts/voices/bank/callers (plots/) — окно телефона отдало бы звонок "
            "дежурному службы"
        )
    return found


def lint(data: dict[str, Any]) -> list[str]:
    """Несостыковки мира в файле сценария (уже прошедшем схему); пусто — файл связен.

    Проверяется файл с ветками, которые загрузчик достраивает сам (`with_service_defaults`):
    их реплики обучаемый тоже услышит.
    """
    full = with_service_defaults(data)
    return [
        *status_problems(full),
        *order_problems(full),
        *stage_problems(full),
        *service_problems(full),
        *wait_problems(full),
        *repeat_problems(full),
        *card_fields.problems(full),
        *caller_problems(full),
    ]
