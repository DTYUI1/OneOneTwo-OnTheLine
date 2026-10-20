"""Каталог инвариантов связности мира и их проверка на расшифровке прогона.

Инвариант — то, что не должно нарушаться ни в одном сценарии и ни в одной ветке: если
обучаемый слышит это, мир противоречит сам себе (классы — проверка вдвоём 17.10,
`docs/coherence_night.md`). Каждая проверка — чистая функция расшифровки (`Transcript`);
нарушение называет время, реплику и что не так.
"""

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from app.seed.world_lexicon import STAGE_AFTER, service_mentions, stage_conflict, stage_window
from app.tools.coherence.caller import NO_REPLY_S
from app.tools.coherence.transcript import QUESTION_REPEAT, Line, Transcript

# Через сколько вызванная служба может быть на месте (`scenario_events.SERVICE_ARRIVAL`).
SERVICE_ARRIVAL_S = 20.0
# Бригада ждёт ответа на свой вопрос столько, прежде чем говорить дальше.
QUESTION_PAUSE_S = 8.0
# Доля срока ожидания, которую может съесть сама система (вызов, представление, реплика).
SYSTEM_SHARE = 0.25
# Пауза ожидания доклада (эталон, раздел 1, п. 5) и запас на звонок и представление.
REPORT_WAIT_S = 40.0
REPORT_WAIT_SLACK_S = 8.0


@dataclass(frozen=True)
class Violation:
    rule: str
    at: float
    detail: str


@dataclass(frozen=True)
class Invariant:
    id: str
    title: str
    check: Callable[[Transcript], list[Violation]]
    # Правило ждёт вкусового решения пользователя (развилка в `docs/coherence_night.md`):
    # нарушения попадают в отчёт отдельной сводкой и не роняют прогон.
    pending: str | None = None


# --- вспомогательное ----------------------------------------------------------------------


def _scenario(tr: Transcript) -> dict[str, Any]:
    return dict(tr.data.get("scenario") or {})


def _reports(tr: Transcript) -> dict[str, dict[str, Any]]:
    return {report["key"]: report for report in _scenario(tr).get("plan", [])}


def _events(tr: Transcript) -> dict[str, dict[str, Any]]:
    return {event["key"]: event for event in _scenario(tr).get("events", [])}


def _report_key(line: Line, tr: Transcript) -> str | None:
    """Доклад плана, который звучит в реплике (сам доклад, подмена веткой, неверный адрес)."""
    if line.source in ("plan", "wrong_address"):
        return line.key
    if line.source == "replace" and line.key:
        event = _events(tr).get(line.key.split(":", 1)[0])
        for body in (event or {}).get("branches", {}).values():
            for effect in body["effects"]:
                text = effect.get("with")
                if (
                    text is not None
                    and (text if isinstance(text, str) else text["text"]) == line.text
                ):
                    return str(effect["replace"])
    return None


def _brigade(tr: Transcript) -> list[Line]:
    return sorted(tr.brigade_speech(), key=lambda line: line.at)


def _clip(text: str, size: int = 70) -> str:
    return text if len(text) <= size else text[: size - 1] + "…"


def _targets(event: dict[str, Any]) -> set[str]:
    found: set[str] = set()
    for body in event["branches"].values():
        for effect in body["effects"]:
            target = effect.get("delay") or effect.get("replace")
            if target:
                found.add(str(target))
    return found


# --- инварианты ---------------------------------------------------------------------------


def stage_regress(tr: Transcript) -> list[Violation]:
    """Реплика противоречит пройденному этапу: «выезжаем» после доклада о выезде,
    «разворачиваемся» после прибытия, «поднимаемся» из дороги."""
    found = []
    stage = "dispatch"
    reports = _reports(tr)
    for line in _brigade(tr):
        key = _report_key(line, tr)
        justifies = reports[key]["justifies_state"] if key in reports else None
        problem = stage_conflict(line.text, stage, justifies)
        if problem is not None:
            found.append(Violation("stage_regress", line.at, f"«{_clip(line.text)}» — {problem}"))
        if justifies is not None:
            stage = STAGE_AFTER.get(justifies, stage)
    return found


def event_after_next_report(tr: Transcript) -> list[Violation]:
    """Реплика события, сработавшего на докладе X, звучит после следующего доклада плана:
    вопрос из дороги — уже с места."""
    found = []
    plan = [report["key"] for report in _scenario(tr).get("plan", [])]
    heard: dict[str, float] = {}
    for line in _brigade(tr):
        key = _report_key(line, tr)
        if key is not None:
            heard.setdefault(key, line.at)
    for line in _brigade(tr):
        if line.source != "event" or not line.key:
            continue
        event = _events(tr).get(line.key)
        trigger = (event or {}).get("trigger", {})
        report = trigger.get("report")
        if report not in plan:
            continue
        later = plan[plan.index(report) + 1 :]
        if not later:
            continue
        nxt = later[0]
        if nxt in heard and heard[nxt] < line.at:
            found.append(
                Violation(
                    "event_after_next_report",
                    line.at,
                    f"событие «{line.key}» (после доклада «{report}») прозвучало после доклада "
                    f"«{nxt}»: «{_clip(line.text)}»",
                )
            )
    return found


def answer_after_target(tr: Transcript) -> list[Violation]:
    """Ответ ветки звучит после доклада, который событие держит или подменяет («Прибыли» →
    «разворачиваемся»)."""
    found = []
    heard: dict[str, float] = {}
    for line in _brigade(tr):
        key = _report_key(line, tr)
        if key is not None:
            heard.setdefault(key, line.at)
        if line.source != "branch" or not line.key:
            continue
        event_key, branch = line.key.split(":", 1)
        if branch in ("late", "surprise"):
            continue
        event = _events(tr).get(event_key)
        if event is None:
            continue
        early = sorted(t for t in _targets(event) if t in heard and heard[t] < line.at)
        if early:
            found.append(
                Violation(
                    "answer_after_target",
                    line.at,
                    f"ответ «{_clip(line.text)}» ({line.key}) — после доклада "
                    f"«{', '.join(early)}», который событие держит или подменяет",
                )
            )
    return found


def _is_question(line: Line) -> bool:
    return bool(line.meta.get("options")) or line.key in ("confirm_request", QUESTION_REPEAT)


def _answered(question: Line, before: float, tr: Transcript) -> bool:
    """Диспетчер ответил на вопрос (вариантом, «Принял», любой фразой) до момента `before`."""
    return any(
        line.who == "Вы"
        and line.kind == "speech"
        and line.call == question.call
        and (question.end or question.at) <= line.at < before
        for line in tr.lines
    )


def talks_over_question(tr: Transcript) -> list[Violation]:
    """Бригада говорит дальше, не дождавшись ответа на свой вопрос (вопрос бригады или «Как
    приняли?»): два вопроса подряд, доклад поверх вопроса."""
    found = []
    lines = _brigade(tr)
    for index, question in enumerate(lines):
        if not _is_question(question):
            continue
        for nxt in lines[index + 1 :]:
            if nxt.call != question.call:
                break
            # Переспрос (снятая с удержания бригада повторяет вопрос) — не речь поверх вопроса.
            if nxt.source == "branch" or nxt.key in ("confirm_request", QUESTION_REPEAT):
                break
            pause = nxt.at - (question.end or question.at)
            if pause < QUESTION_PAUSE_S and not _answered(question, nxt.at, tr):
                found.append(
                    Violation(
                        "talks_over_question",
                        nxt.at,
                        f"«{_clip(nxt.text)}» через {pause:.1f} с после вопроса "
                        f"«{_clip(question.text, 40)}» без ответа",
                    )
                )
            break
    return found


def _act(text: str) -> str | None:
    window = stage_window(text)
    if window.reason is None:
        return None
    if window.lo == window.hi == "dispatch":
        return "выезд"
    stripped = text.strip(" .!").lower()
    if stripped in {"понял", "принял", "так, принял", "поняла", "приняла", "есть", "ясно"}:
        return "подтверждение"
    return None


def duplicate_meaning(tr: Transcript) -> list[Violation]:
    """Две реплики подряд об одном («выезжаем» дважды, «Принял» дважды)."""
    found = []
    lines = _brigade(tr)
    for prev, line in zip(lines, lines[1:], strict=False):
        if prev.call != line.call:
            continue
        act = _act(line.text)
        if act is not None and act == _act(prev.text):
            found.append(
                Violation(
                    "duplicate_meaning",
                    line.at,
                    f"дважды {act}: «{_clip(prev.text, 45)}» и «{_clip(line.text, 45)}»",
                )
            )
    return found


# Ответы окна телефона на сведения от диспетчера (`brigadeAnswer`): «Принял», «Понял, ждём
# скорую» — на ту же фразу мир может засчитать исход события и ответить веткой. Повтор
# доклада на «Доложите» («Повторяю…») — не такой ответ: после него бригада говорит своё.
CLIENT_ANSWERS = ("ack", "service_coming")
# Ветки, которые бригада говорит сама, а не в ответ на фразу: приезд службы без вести
# (`surprise`, GP-28) и повторная просьба на сроке (`missed`).
OWN_BRANCHES = (":surprise", ":missed")


def _branch_answers(line: Line) -> bool:
    return (
        line.source == "branch"
        and bool(line.meta.get("answer"))
        and not (line.key or "").endswith(OWN_BRANCHES)
    )


def _one_phrase_before(speech: Sequence[Line], index: int) -> bool:
    """Перед ответом окна `speech[index]` диспетчер сказал одну фразу, не вариант ответа:
    ответ ветки следом может быть только на неё. Вариант («reply:…») или две реплики подряд —
    ответ ветки мог быть на другую («Принял» окна — на вторую фразу, ветка — на вариант)."""
    said = []
    for line in reversed(speech[:index]):
        if line.call != speech[index].call:
            continue
        if line.source != "dispatcher":
            break
        said.append(line)
    return len(said) == 1 and not (said[0].key or "").startswith("reply:")


def answered_twice(tr: Transcript) -> list[Violation]:
    """На одну фразу диспетчера бригада отвечает дважды: окно телефона («Принял») и следом,
    без реплики диспетчера между ними, ответ ветки мира («Понял, Бескудниковский бульвар,
    едем»), засчитавшего ту же фразу."""
    found = []
    speech = sorted((line for line in tr.speech() if line.call), key=lambda line: line.at)
    for index, (prev, line) in enumerate(zip(speech, speech[1:], strict=False)):
        if (
            prev.call == line.call
            and prev.source == "client"
            and prev.key in CLIENT_ANSWERS
            and _branch_answers(line)
            and _one_phrase_before(speech, index)
        ):
            found.append(
                Violation(
                    "answered_twice",
                    line.at,
                    f"«{_clip(prev.text, 45)}» и следом «{_clip(line.text, 45)}»",
                )
            )
    return found


def _called(tr: Transcript, ext: str) -> list[float]:
    """Когда диспетчер звонил в службу (сам номер или 112 — через неё вызывают любую)."""
    return [at for number, at in tr.service_calls if number in (ext, "112")]


def _dispatched_by_112(tr: Transcript) -> set[str]:
    card = _scenario(tr).get("card", {})
    names = {"103": "103", "101": "101", "102": "102", "104": "104", "GKH": "105"}
    names["MOSLIFT"] = "106"
    return {names.get(str(item), str(item)) for item in card.get("service_ids", [])}


def service_presence(tr: Transcript) -> list[Violation]:
    """Служба «на месте» без вызова диспетчера или раньше, чем могла доехать."""
    found = []
    by_112 = _dispatched_by_112(tr)
    for line in _brigade(tr):
        for mention in service_mentions(line.text, tr.service):
            if not mention.present or mention.ext in by_112:
                continue
            calls = [at for at in _called(tr, mention.ext) if at <= line.at]
            if not calls:
                found.append(
                    Violation(
                        "service_uncalled",
                        line.at,
                        f"служба {mention.ext} на месте без вызова: «{_clip(line.text)}»",
                    )
                )
            elif line.at - min(calls) < SERVICE_ARRIVAL_S - 1:
                found.append(
                    Violation(
                        "service_too_early",
                        line.at,
                        f"служба {mention.ext} на месте через {line.at - min(calls):.0f} с после "
                        f"звонка: «{_clip(line.text)}»",
                    )
                )
    return found


def called_service_ignored(tr: Transcript) -> list[Violation]:
    """Вызванная по просьбе служба, о которой бригада дальше молчит (HQ-055): нет ответа на
    весть диспетчера («Понял, ждём скорую») или «внезапного» приезда (`surprise`), нет
    доклада о совместной работе со службой."""
    found = []
    for event in _events(tr).values():
        if event["kind"] != "request_service" or event["key"] not in tr.firings:
            continue
        exts = [
            str(ext)
            for expect in event["expect"]
            if expect["action"] == "call_service"
            for ext in expect["phone_exts"]
        ]
        need = next((ext for ext in exts if ext != "112"), None)
        if need is None:
            continue
        calls = [at for number, at in tr.service_calls if number in exts]
        if not calls:
            continue
        first = min(calls)
        later = [
            line
            for line in _brigade(tr)
            if line.at >= first
            and any(item.ext == need for item in service_mentions(line.text, tr.service))
        ]
        if not any(_report_key(line, tr) is None for line in later):
            found.append(
                Violation(
                    "called_service_ignored",
                    first,
                    f"вызвали службу {need} по просьбе «{event['key']}», а бригада не сказала "
                    "о ней ни «Понял, ждём», ни «подъехала»",
                )
            )
        if not any(_report_key(line, tr) is not None for line in later):
            found.append(
                Violation(
                    "called_service_ignored",
                    first,
                    f"вызвали службу {need} по просьбе «{event['key']}», а ни один доклад после "
                    "не говорит о совместной работе с ней",
                )
            )
    return found


def deadline_eaten(tr: Transcript) -> list[Violation]:
    """Срок реакции съеден системой: реплика события дошла до диспетчера поздно не по его
    вине (вызов бригады, представление, длинная реплика)."""
    found = []
    events = _events(tr)
    calls = [line for line in tr.lines if line.kind == "call"]
    for key, fired in tr.firings.items():
        event = events.get(key)
        if event is None or event.get("line") is None:
            continue
        heard = next(
            (line for line in _brigade(tr) if line.source == "event" and line.key == key), None
        )
        if heard is None:
            continue
        ring = _ring_wait(calls, heard, fired)
        end = heard.end or heard.at
        # Пока диспетчер на линии, реплика срок не ест: движок сдвигает его на это время
        # (`scenario_events.spoken_s`). Съесть его может только то, что было до разговора:
        # бригада не перезвонила сразу (звонок до ответа — время диспетчера).
        on_line = min((line.at for line in tr.speech() if line.call == heard.call), default=end)
        system = end - fired - ring - max(0.0, end - max(fired, on_line))
        for expect in event["expect"]:
            if expect["action"] not in ("call_service", "call_brigade"):
                continue
            within = float(expect["within_s"])
            if system > within * SYSTEM_SHARE:
                found.append(
                    Violation(
                        "deadline_eaten",
                        heard.at,
                        f"событие «{key}»: из срока {within:.0f} с система съела {system:.0f} с "
                        "до разговора с бригадой",
                    )
                )
    return found


def _ring_wait(calls: list[Line], heard: Line, fired: float) -> float:
    """Сколько звонил вызов бригады до ответа диспетчера (это его время, не системы)."""
    rang = [line.at for line in calls if line.text.startswith(("Входящий", "ТРЕВОЖНЫЙ"))]
    # Диспетчер связался с бригадой: ответил на вызов или, не ответив, перезвонил сам.
    answered = [
        line.at
        for line in calls
        if line.text.startswith(("Ответ на вызов", "Исходящий вызов: Бригада"))
    ]
    start = max((at for at in rang if fired - 1 <= at <= heard.at), default=None)
    if start is None:
        return 0.0
    answer = min((at for at in answered if start <= at <= heard.at), default=start)
    return answer - start


def overlapping_speech(tr: Transcript) -> list[Violation]:
    """Две реплики в одном разговоре звучат одновременно."""
    found = []
    speech = sorted((line for line in tr.speech() if line.call), key=lambda line: line.at)
    for prev, line in zip(speech, speech[1:], strict=False):
        if prev.call == line.call and prev.end is not None and line.at < prev.end - 0.05:
            found.append(
                Violation(
                    "overlapping_speech",
                    line.at,
                    f"«{_clip(line.text, 40)}» поверх «{_clip(prev.text, 40)}»",
                )
            )
    return found


def confirm_misplaced(tr: Transcript) -> list[Violation]:
    """«Как приняли?» не после доклада: после вопроса, ответа или в исходящем разговоре."""
    found = []
    lines = _brigade(tr)
    for prev, line in zip(lines, lines[1:], strict=False):
        if line.key != "confirm_request":
            continue
        if prev.call != line.call or prev.source in ("client", "readback"):
            continue
        if prev.meta.get("options") or prev.meta.get("answer") or not prev.meta.get("inbound"):
            found.append(
                Violation(
                    "confirm_misplaced",
                    line.at,
                    f"«Как приняли?» после «{_clip(prev.text, 50)}»",
                )
            )
    return found


# Ветки, ответ которых — подтверждение действия диспетчера («Понял», «Понял, ждём скорую»), а
# не новость: повторная просьба (`missed`) и приезд службы (`surprise`) — повод позвонить.
ACK_BRANCHES = ("met", "late", "already")


def _ack(line: Line) -> bool:
    return (
        bool(line.meta.get("answer"))
        and line.source == "branch"
        and (line.key or "").rsplit(":", 1)[-1] in ACK_BRANCHES
    )


def callback_without_news(tr: Transcript) -> list[Violation]:
    """Бригада перезвонила только ради ответа-подтверждения («Так, принял.») — звонок без
    повода (HQ-055: о вызванной службе бригаде сообщает диспетчер, а не она ему «Понял»)."""
    found = []
    by_call: dict[str, list[Line]] = {}
    for line in _brigade(tr):
        if line.call and line.source != "client":
            by_call.setdefault(line.call, []).append(line)
    for lines in by_call.values():
        if not lines or not lines[0].meta.get("inbound"):
            continue
        if all(_ack(line) for line in lines):
            found.append(
                Violation(
                    "callback_without_news",
                    lines[0].at,
                    "бригада позвонила только сказать: «"
                    + " / ".join(_clip(line.text, 40) for line in lines)
                    + "»",
                )
            )
    return found


def line_twice(tr: Transcript) -> list[Violation]:
    """Одна и та же реплика сценария звучит дважды."""
    found = []
    seen: dict[str, float] = {}
    for line in _brigade(tr):
        if line.source in ("client", "readback"):
            continue
        if line.meta.get("cut"):
            # Оборванная отбоем реплика прозвучит снова — это не повтор.
            continue
        if line.text in seen:
            found.append(Violation("line_twice", line.at, f"повтор «{_clip(line.text)}»"))
        seen.setdefault(line.text, line.at)
    return found


def confirm_unanswered(tr: Transcript) -> list[Violation]:
    """Эталон отвечает «Принял» (`report_confirmed`) на каждое «Как приняли?» — в том числе
    переспрошенное после удержания и когда служба ответила позже (решение капитана 18.10,
    HQ-058). «Принял» засчитан, если прозвучал в том же разговоре раньше следующего доклада
    бригады и сервер его принял."""
    if tr.policy != "эталон":
        return []
    found = [
        Violation("confirm_unanswered", 0.0, _clip(item, 160))
        for item in tr.errors
        if "report_confirmed →" in item
    ]
    speech = sorted(tr.speech(), key=lambda line: line.at)
    for index, asked in enumerate(speech):
        if not (asked.spoken_by_brigade and asked.key == "confirm_request"):
            continue
        answered = False
        for nxt in speech[index + 1 :]:
            if nxt.call != asked.call:
                continue
            if nxt.who == "Вы" and nxt.key == "confirm":
                answered = True
                break
            if nxt.spoken_by_brigade and nxt.source != "client":
                break
        if not answered:
            found.append(
                Violation(
                    "confirm_unanswered",
                    asked.at,
                    f"на «{_clip(asked.text, 40)}» эталон не ответил «Принял»",
                )
            )
    return found


def not_closed(tr: Transcript) -> list[Violation]:
    """Карточку не закрыть: доклада, которого ждёт статус, нет или он не приходит."""
    found = [Violation("not_closed", 0.0, item) for item in tr.errors if "не закрыть" in item]
    for item in tr.errors:
        if "report_required" in item:
            found.append(Violation("status_refused", 0.0, _clip(item, 160)))
    return found


def report_wait(tr: Transcript) -> list[Violation]:
    """Обучаемый ждёт доклада дольше 40 с (эталон, раздел 1, п. 5) — без своей вины."""
    if tr.policy not in ("эталон",) and ":" not in tr.policy:
        return []
    found = []
    # Действие диспетчера — и отбой по его воле: промолчав на вопрос бригады и положив трубку,
    # он сам выбрал ждать, пока выйдет срок ответа.
    actions = sorted(
        line.at
        for line in tr.lines
        if line.who == "Вы" or (line.kind == "call" and "диспетчер положил трубку" in line.text)
    )
    previous = None
    for line in _brigade(tr):
        if _report_key(line, tr) is None:
            continue
        if previous is not None:
            since = max([previous] + [at for at in actions if at <= line.at])
            wait = line.at - since
            if wait > REPORT_WAIT_S + REPORT_WAIT_SLACK_S:
                found.append(
                    Violation(
                        "report_wait",
                        line.at,
                        f"доклад «{_clip(line.text, 50)}» — через {wait:.0f} с ожидания",
                    )
                )
        previous = line.end or line.at
    return found


def caller_line(tr: Transcript) -> list[Violation]:
    """Живой заявитель (HQ-019): сервер принял каждую его реплику (`caller_said`), а «Алло, вы
    тут?» звучит только после тишины диспетчера `NO_REPLY_S` в этом звонке."""
    found = [
        Violation("caller_line", 0.0, _clip(item, 160))
        for item in tr.errors
        if "caller_said" in item
    ]
    speech = tr.speech()
    for index, line in enumerate(speech):
        if line.source != "caller" or ".no_reply." not in (line.key or ""):
            continue
        before = [item.end or item.at for item in speech[:index] if item.call == line.call]
        if before and line.at - max(before) < NO_REPLY_S - 0.01:
            found.append(
                Violation(
                    "caller_line",
                    line.at,
                    f"«{_clip(line.text, 40)}» через {line.at - max(before):.1f} с тишины",
                )
            )
    return found


CATALOG: tuple[Invariant, ...] = (
    Invariant(
        "stage_regress",
        "Реплика не противоречит этапу бригады (выехали → не «выезжаем», "
        "на месте → не «разворачиваемся», в пути → не «поднимаемся»)",
        stage_regress,
    ),
    Invariant(
        "event_after_next_report",
        "Событие после доклада X звучит до следующего доклада "
        "плана (вопрос из дороги — не с места)",
        event_after_next_report,
    ),
    Invariant(
        "answer_after_target",
        "Ответ ветки не звучит после доклада, который событие держит или подменяет",
        answer_after_target,
    ),
    Invariant(
        "talks_over_question",
        "Бригада не говорит дальше, пока ждёт ответа на свой "
        "вопрос или «Как приняли?» (до ответа или паузы 8 с)",
        talks_over_question,
    ),
    Invariant(
        "duplicate_meaning",
        "Нет двух реплик подряд об одном («выезжаем» дважды)",
        duplicate_meaning,
    ),
    Invariant(
        "answered_twice",
        "На одну фразу диспетчера бригада отвечает один раз: окно телефона или ответ ветки",
        answered_twice,
    ),
    Invariant(
        "service_presence",
        "Служба на месте — только после вызова диспетчера (или "
        "112 по карточке) и не раньше, чем доехала (20 с)",
        service_presence,
    ),
    Invariant(
        "called_service_ignored",
        "Вызванная по просьбе служба — в разговоре дальше: диспетчер сообщил, бригада "
        "«Понял, ждём скорую» (не сообщил — «подъехала, могли бы и сказать»), доклад после — о "
        "совместной работе со службой (HQ-055)",
        called_service_ignored,
    ),
    Invariant(
        "deadline_eaten",
        "Срок реакции на событие не съеден системой больше чем на четверть: реплику на "
        "линии движок не засчитывает (spoken_s), съесть срок может только задержка до "
        "разговора с бригадой",
        deadline_eaten,
    ),
    Invariant(
        "overlapping_speech", "Реплики одного разговора не звучат одновременно", overlapping_speech
    ),
    Invariant(
        "confirm_misplaced",
        "«Как приняли?» — только после доклада во входящем вызове",
        confirm_misplaced,
    ),
    Invariant(
        "callback_without_news",
        "Бригада не перезванивает только ради ответа-подтверждения (ветки met, late, "
        "already): о службе ей сообщает диспетчер (HQ-055); повторная просьба и «внезапный» "
        "приезд службы — повод позвонить",
        callback_without_news,
    ),
    Invariant(
        "confirm_unanswered",
        "Эталон отвечает «Принял» на каждое «Как приняли?», в том числе после удержания и при "
        "позднем ответе службы (HQ-058)",
        confirm_unanswered,
    ),
    Invariant("line_twice", "Реплика сценария не звучит дважды", line_twice),
    Invariant(
        "not_closed",
        "Карточку можно закрыть: каждый статус — после доклада, доклад приходит",
        not_closed,
    ),
    Invariant("report_wait", "Доклада не ждут дольше 40 с не по своей вине", report_wait),
    Invariant(
        "caller_line",
        "Живой заявитель (HQ-019): сервер принял каждую его реплику, «Алло, вы тут?» — только "
        "после 8 с тишины диспетчера",
        caller_line,
    ),
)


PENDING = frozenset(item.id for item in CATALOG if item.pending)


def failing(rule: str) -> bool:
    """Нарушение роняет прогон: правило не ждёт решения пользователя."""
    return rule not in PENDING


def check(tr: Transcript) -> list[Violation]:
    found: list[Violation] = []
    for invariant in CATALOG:
        found.extend(invariant.check(tr))
    return sorted(found, key=lambda item: (item.at, item.rule))
