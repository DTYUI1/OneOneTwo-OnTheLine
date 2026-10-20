"""Политики диспетчера для прогона: эталон, каждая ветка каждого события, типовые отклонения.

Политика — набор ручек поведения, а не сценарий действий: когда отвечать на вызов, как скоро
ставить статус, подтверждать ли доклад, куда метить в каждом событии (`aims`: ключ события →
ветка). Так одна политика годится любому сценарию, а ветки сценария получаются перебором
ключей его событий.
"""

from dataclasses import dataclass, field, replace
from typing import Any

# Ветка, в которую метит политика по событию, — по смыслу действия диспетчера:
# met — верно и в срок, late — верно после срока, wrong — не тот ответ, missed — ничего;
# already / surprise / told — служба вызвана заранее (GP-28): сказал на просьбу «уже едут»,
# промолчал, сказал бригаде до просьбы.
AIMS = ("met", "late", "wrong", "missed", "already", "surprise", "told")


@dataclass(frozen=True)
class Policy:
    name: str
    title: str
    # Карточка «не наша»: «Не принята» и перенаправление; иначе — «Принята».
    reject: bool = False
    accept_after_s: float = 4.0
    # Вводная: верный адрес или ошибка в номере дома.
    briefing: str = "ok"
    # Через сколько отвечать на входящий вызов; None — не отвечать, перезванивать самому.
    ring_answer_s: float | None = 2.0
    # Статус после доклада, который его обосновывает.
    status_after_s: float = 2.0
    # «Принял» на «Как приняли?»; None — молчать и положить трубку через 8 с.
    confirm_after_s: float | None = 1.5
    # Положить трубку сразу, как доклад прозвучал (не дождавшись «Как приняли?»).
    hangup_after_report: bool = False
    reply_after_s: float = 3.0
    aims: dict[str, str] = field(default_factory=dict)
    default_aim: str = "met"
    # Позвонить бригаде, если она без связи столько секунд (табло сил); None — не звонить.
    check_in_after_s: float | None = 20.0
    # Вызвав службу по просьбе бригады, перезвонить ей: «Скорую вызвал, едет» (HQ-055).
    tell_after_call: bool = True
    # Не класть трубку бригаде, а поставить её на удержание, позвонить в службу и вернуться
    # на линию (окно телефона, `phone/hold.ts`); `told_text` — что сказать вместо фразы с
    # названием службы («Отправил, ждите» — о той, что просили, HQ-055).
    tell_via_hold: bool = False
    told_text: str | None = None
    # С удержанием: вернуться к бригаде, пока звонок в службу ещё идёт (служба ответила —
    # она на удержании, срока вести ещё нет), сказать и вернуться к службе с докладом.
    tell_during_service: bool = False
    # Вопрос бригады с вариантами ответа (`reply`): не отвечать сразу, а поставить бригаду на
    # удержание, позвонить заявителю (живой заявитель сценария) или в службу из просьбы
    # сценария, снять с удержания и ответить на повторённый вопрос (HQ-058).
    ask_via_hold: bool = False
    # Вводная преподавателя: вид события → после какого статуса подать.
    injects: dict[str, str] = field(default_factory=dict)
    # Живой заявитель (HQ-019): ask — спрашивает, silent — молчит в трубку до отбоя
    # заявителя и перезванивает; характер у абонента занятия (None — как в сценарии).
    caller: str = "ask"
    caller_character: str | None = None
    # Ловушка повтора адреса (`correct_readback`): ответить «Понял» и следом сказать бригаде
    # верный адрес фразой, без «поправка по адресу» (HQ-024) — поправка голосом до срока.
    # Шаблон фразы, `{address}` — адрес карточки; пусто — так не поправляет.
    fix_phrase: str = ""

    def aim(self, event_key: str) -> str:
        return self.aims.get(event_key, self.default_aim)


REFERENCE = Policy("эталон", "Эталонный диспетчер: всё верно и в срок")

# Типовые человеческие отклонения (не ветки событий, а манера работы).
DEVIATIONS = (
    Policy("медленно_отвечает", "Отвечает на вызов бригады через 20 с", ring_answer_s=20.0),
    Policy("не_берёт_трубку", "Не берёт входящие, перезванивает бригаде сам", ring_answer_s=None),
    Policy(
        "кладёт_трубку_после_доклада",
        "Кладёт трубку, как только доклад прозвучал",
        hangup_after_report=True,
    ),
    Policy("не_подтверждает", "Молчит на «Как приняли?» и кладёт трубку", confirm_after_s=None),
    Policy("статус_сразу", "Ставит статус сразу после доклада", status_after_s=0.2),
    Policy("статус_медленно", "Ставит статус через 15 с после доклада", status_after_s=15.0),
    Policy(
        "отвечает_не_то", "На каждый вопрос бригады отвечает не тем вариантом", default_aim="wrong"
    ),
    Policy("не_отвечает", "Не отвечает на вопросы и просьбы бригады", default_aim="missed"),
    Policy("не_звонит_бригаде", "Не звонит бригаде, когда она долго молчит", check_in_after_s=None),
    Policy(
        "не_сообщает_о_службе",
        "Вызвав службу по просьбе бригады, не сообщает бригаде, что служба едет",
        tell_after_call=False,
    ),
    Policy(
        "сообщает_с_удержания",
        "Ставит бригаду на удержание, звонит в службу, возвращается: «Отправил, ждите»",
        tell_via_hold=True,
        told_text="Отправил, ждите.",
    ),
    Policy(
        "сообщает_во_время_звонка_в_службу",
        "Бригада на удержании, служба ответила — к бригаде: «Отправил, ждите», потом доклад службе",
        tell_via_hold=True,
        told_text="Отправил, ждите.",
        tell_during_service=True,
    ),
    Policy("неверный_адрес", "Во вводной ошибка в номере дома", briefing="wrong_address"),
)


def _branches(event: dict[str, Any]) -> list[str]:
    names = [name for name in event["branches"] if name in AIMS]
    if event["kind"] == "request_service":
        names += [name for name in ("already", "surprise", "told") if name not in names]
    return names


def _branch_policies(reference: Policy, data: dict[str, Any]) -> list[Policy]:
    """По политике на каждую ветку каждого события. Ветка, которую проходит и эталон (met без
    вводной и без события-родителя в другой ветке), отдельно не гоняется."""
    result = []
    for event in data.get("events", []):
        key = event["key"]
        trigger = event["trigger"]
        injects = {}
        if trigger["on"] == "inject":
            injects = {event["kind"]: trigger.get("requires_state") or "arrived"}
        for branch in _branches(event):
            aims = {key: branch}
            if trigger["on"] == "event":
                # Страховочная реплика приходит только после пропуска события-родителя.
                aims[trigger["event"]] = trigger["branch"]
            if not injects and all(aim == reference.default_aim for aim in aims.values()):
                continue
            result.append(
                replace(
                    reference,
                    name=f"{key}:{branch}",
                    title=f"Событие «{key}» — ветка {branch}",
                    aims=aims,
                    injects=injects,
                )
            )
    return result


def _reference(data: dict[str, Any]) -> tuple[Policy, bool]:
    not_ours = "rejected" in data["reference"]["expected_flow"]
    return replace(REFERENCE, reject=not_ours), not_ours


# Звонок живому заявителю (HQ-019, docs/dds_caller.md): характер и тишина диспетчера.
CALLER_POLICIES = (
    Policy(
        "заявитель_растерянная",
        "Заявитель растерянная (преподаватель сменил характер): уточняет срок",
        caller_character="confused",
    ),
    Policy(
        "заявитель_молчит",
        "Молчит в трубку заявителю: «Алло, вы тут?» дважды, отбой, перезвон",
        caller="silent",
    ),
)


# Уточнение с удержания (HQ-058): только сценариям, где есть вопрос с вариантами и есть кому
# позвонить (`hold_call_target`).
ASKS_VIA_HOLD = Policy(
    "уточняет_с_удержания",
    "На вопрос бригады — удержание, звонок заявителю или в службу, снятие, ответ на повтор",
    ask_via_hold=True,
)


# Поправка ловушки повтора адреса фразой (HQ-024): только сценариям с такой ловушкой.
# Во фразе бывает и просьба доложить: бригада всё равно подтверждает поправку, а не
# «Еду. Доложу с места.».
FIXES_BY_PHRASE = (
    Policy(
        "поправляет_фразой",
        "На повтор адреса с ошибкой — «Понял», следом верный адрес фразой: «Нет, …»",
        fix_phrase="Нет, {address}.",
    ),
    Policy(
        "поправляет_фразой_доложите",
        "На повтор адреса с ошибкой — «Понял», следом «…, доложите по прибытии»",
        fix_phrase="{address}, доложите по прибытии.",
    ),
)


def hold_call_target(data: dict[str, Any]) -> str | None:
    """Кому звонит диспетчер, уточняя вопрос бригады с удержания: `caller` — живому заявителю
    сценария, иначе номер службы первой просьбы бригады (`request_service`); некому — None."""
    if data.get("caller"):
        return "caller"
    for event in data.get("events", []):
        if event["kind"] != "request_service":
            continue
        for expect in event["expect"]:
            if expect["action"] == "call_service":
                exts = [str(ext) for ext in expect["phone_exts"]]
                return next((ext for ext in exts if ext != "112"), exts[0])
    return None


def _asks(data: dict[str, Any]) -> bool:
    return any(
        event.get("reply_options") and event["expect"][0]["action"] == "reply"
        for event in data.get("events", [])
    )


def _readback_trap(data: dict[str, Any]) -> bool:
    return any(
        event["expect"][0]["action"] == "correct_readback" for event in data.get("events", [])
    )


def policies_for(data: dict[str, Any]) -> list[Policy]:
    """Эталон, каждая ветка каждого события и типовые отклонения — для одного сценария;
    сценарию с вопросом бригады и тем, кому позвонить, — уточнение с удержания; сценарию с
    живым заявителем — ещё класс «звонок заявителю»; сценарию с ловушкой повтора адреса —
    поправка фразой."""
    reference, not_ours = _reference(data)
    if not_ours:
        return [reference, Policy("приняли_не_нашу", "Принял не свою карточку")]
    callers = CALLER_POLICIES if data.get("caller") else ()
    holds = (ASKS_VIA_HOLD,) if _asks(data) and hold_call_target(data) else ()
    fixes = FIXES_BY_PHRASE if _readback_trap(data) else ()
    return [
        reference,
        *_branch_policies(reference, data),
        *DEVIATIONS,
        *holds,
        *fixes,
        *callers,
    ]
