"""Пометки для разбора звонка (этап 3, docs/operator_112_review/PLAN.md).

Каждый ответ заявителя получает пометку: помогло действие оператора, навредило или требует
внимания. Пометка — чистая функция от действия, исхода и паники до и после, как у прототипа
(docs/operator_112_review/prototype/). Экран кладёт её в журнал звонка, окно результата
показывает журнал лентой (contracts/operator/dialog.md, contracts/operator/evaluation.md).
"""

from dataclasses import dataclass
from typing import Literal

from app.operator.caller import ADDRESS_KEY, CallerReply, CallerState

MarkKind = Literal["good", "bad", "warn", "info"]


@dataclass(frozen=True)
class Mark:
    kind: MarkKind
    text: str


# В истерике не слышно ничего, кроме просьбы с причиной (IAED) — почему именно, зависит от
# того, что оператор попробовал.
UNHEARD: dict[str, str] = {
    "question": (
        "Вопрос не услышан: заявитель в истерике. Сначала «Успокоить» — просьба с причиной, "
        "повторять подряд."
    ),
    "calm": "Поддержку без просьбы в истерике не слышно. Нужна просьба с причиной.",
    "hold": "В истерике «Слышу, записываю» не слышно. Сначала «Успокоить».",
    "advice": "Совет в истерике не услышан. Сначала «Успокоить».",
}

MARKS: dict[str, Mark] = {
    "early": Mark("bad", "Адреса ещё нет — вопрос раньше времени. Без адреса помощь не отправить."),
    "repeated": Mark("bad", "Этот ответ уже был — повтор вопроса злит заявителя."),
    "irrelevant": Mark("bad", "Вопрос не по делу этого вызова — заявитель злится."),
    "not_understood": Mark("bad", "Вопрос не понят — заявитель переспросил."),
    # Изменение паники («Паника снизилась.») экран дописывает сам по panic_before/after.
    "calming": Mark(
        "good", "Просьба с причиной сработала, но паника ещё высокая. Повторите её подряд."
    ),
    "order": Mark("bad", "«Успокойтесь!» без причины не работает — заявитель злится."),
    "hold": Mark("good", "Контакт удержан, пока вы заполняете карточку."),
    "silence": Mark(
        "bad",
        "Долгая пауза: заявителю кажется, что связь пропала. Держите контакт — «Слышу, записываю».",
    ),
    "escalation": Mark("warn", "Ситуация ухудшилась — нужен совет из меню «Советы»."),
    "confirmed": Mark("good", "Адрес подтверждён повтором — как требует стандарт приёма вызова."),
    "corrected": Mark(
        "good", "Повтор адреса поймал ошибку на слух. Исправьте карточку и повторите адрес."
    ),
}
CALM_ANSWER = Mark("good", "Вопрос по шагу — ответ спокойный, сведения точные.")
CALM_ADDRESS = Mark("good", "Адрес назван спокойно. Внесите его в карточку и повторите вслух.")
PANIC_ANSWER = Mark("warn", "Ответ в панике — сведения неточные. Успокойте и переспросите.")
PANIC_ADDRESS = Mark(
    "warn", "Адрес назван в панике и может быть неточным. Повторите его вслух — так ловят ошибку."
)
CALMED_ADDRESS = Mark(
    "good", "Повтор той же просьбы сработал: заявитель ниже порога истерии и назвал адрес."
)
CALMED = Mark("good", "Заявитель успокоился и слушает.")
ALREADY_CALM = Mark("info", "Заявитель и так спокоен — продолжайте по шагам.")
ADVICE = Mark("good", "Совет безопасности дан.")
ADVICE_ESCALATION = Mark("good", "Совет на ухудшение дан — заявитель знает, что делать.")
UNCONFIRMED_PANIC = Mark(
    "warn", "В панике «да» ненадёжно: успокойте заявителя и повторите адрес ещё раз."
)
UNCONFIRMED_EMPTY = Mark("warn", "Сначала внесите адрес в карточку, потом повторите его вслух.")


def mark_for(
    action: str, before: CallerState, after: CallerState, reply: CallerReply
) -> Mark | None:
    """Пометка ответа заявителя для разбора; None — событие без пометки (noop)."""
    outcome = reply.outcome
    if outcome == "unheard":
        return Mark("bad", UNHEARD.get(action, UNHEARD["question"]))
    if outcome == "correct":
        address = reply.question_key == ADDRESS_KEY
        if reply.variant == "panic":
            return PANIC_ADDRESS if address else PANIC_ANSWER
        return CALM_ADDRESS if address else CALM_ANSWER
    if outcome == "calmed":
        if reply.question_key == ADDRESS_KEY:
            return CALMED_ADDRESS
        return CALMED if after.panic < before.panic else ALREADY_CALM
    if outcome == "advice":
        handled = after.escalation_handled and not before.escalation_handled
        return ADVICE_ESCALATION if handled else ADVICE
    if outcome == "unconfirmed":
        return UNCONFIRMED_PANIC if reply.line == "confirm.panic" else UNCONFIRMED_EMPTY
    return MARKS.get(outcome)
