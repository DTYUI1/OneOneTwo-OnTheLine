"""Бригада говорит по очереди: вопрос — ответ, доклад — «Как приняли?» — «Принял».

Проверка 17.10 (`docs/decisions.md`): бригада задавала второй вопрос поверх первого («Как
поняли? … выезжаем!» → сразу «Подъезд какой?»), докладывала, не дождавшись «Принял», и
отвечала на поправку после доклада о прибытии. Это не частные ошибки сценариев, а отсутствие
правила очереди реплик. Правило одно для всех сценариев:

1. **Реплика, на которую бригада ждёт ответа** (`Turn`): вопрос — реплика с вариантами ответа
   (уточнение, просьба о службе, повтор адреса) — и доклад во входящем вызове: после него
   бригада спрашивает «Как приняли?» (`asks_confirmation`; то же правило у окна телефона —
   `asksConfirmation`, общая таблица примеров `confirmRequest.cases.json`).
2. **Пока такая реплика выдана, но не прозвучала, бригада новую не начинает.** Прозвучала —
   ждёт ответа диспетчера в этом разговоре (вариант, «Принял», любая фраза) не дольше
   `ANSWER_PAUSE` (после доклада — от конца «Как приняли?»); отбой тоже конец ожидания.
   Срок ответа события при этом идёт своим ходом (`evalcore.brigade`): бригада просто не
   говорит поверх своего вопроса.
3. **Тревога очереди не ждёт** (у неё свои правила, `scenario_events.alarm_at`).

Очередь сдвигает и выдачу (`apply_world`: доклад не готов, пока бригада ждёт ответа), и
срабатывание событий (`due_events`): срок реакции идёт от того, когда бригада спросила.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID

# Сколько бригада ждёт ответа на свою реплику, прежде чем говорить дальше: как пауза окна
# телефона перед переспросом (incoming.ts `NO_REPLY_MS`, 8 с). Ответ может прийти и позже —
# до срока события, — но бригада уже не молчит в трубку.
ANSWER_PAUSE = timedelta(seconds=8)
# После доклада во входящем вызове окно телефона ещё спрашивает «Как приняли?» (около 1,5 с
# записи): пауза ответа идёт от конца вопроса, а не от конца доклада (ночной прогон 17.10:
# новая реплика звучала через 6,5–7 с после «Как приняли?»).
CONFIRM_ASK = timedelta(seconds=2)


def asks_confirmation(inbound: bool, question: bool, answer: bool) -> bool:
    """После реплики бригада спрашивает «Как приняли?»: только доклад во входящем вызове.

    Вопрос бригады (варианты ответа) и её ответ на реакцию диспетчера подтверждения не ждут
    (проверка 17.10). Правило окна телефона — `asksConfirmation` (Softphone), примеры —
    `apps/web/src/arm/softphone/brigade/confirmRequest.cases.json`.
    """
    return inbound and not question and not answer


@dataclass(frozen=True)
class Turn:
    """Реплика бригады, после которой она ждёт ответа диспетчера."""

    brigade: UUID
    # Когда прозвучала (первое предъявление); None — выдана, но ещё не прозвучала.
    heard: datetime | None
    # Первый ответ диспетчера после неё в этом разговоре или отбой; None — ещё нет.
    answered: datetime | None
    # Сколько бригада ждёт ответа: после доклада — ещё и «Как приняли?» (`CONFIRM_ASK`).
    pause: timedelta = ANSWER_PAUSE

    def released(self) -> datetime | None:
        """С какого момента бригада снова может говорить; None — реплика ещё не прозвучала."""
        if self.heard is None:
            return None
        limit = self.heard + self.pause
        return limit if self.answered is None else min(self.answered, limit)


@dataclass(frozen=True)
class Quiet:
    """Бригада молчит: ждёт, пока прозвучит её реплика (`blocked`), или до `until`."""

    blocked: bool
    until: datetime | None

    def ready(self, at: datetime | None) -> datetime | None:
        """Готовность новой реплики с учётом очереди; None — пока не готова."""
        if at is None or self.blocked:
            return None
        return at if self.until is None else max(at, self.until)


OPEN = Quiet(False, None)


def quiet(turns: Iterable[Turn]) -> dict[UUID, Quiet]:
    """Бригада → когда она может начать новую реплику (по всем её репликам с ожиданием)."""
    result: dict[UUID, Quiet] = {}
    for turn in turns:
        current = result.get(turn.brigade, OPEN)
        released = turn.released()
        if released is None:
            result[turn.brigade] = Quiet(True, current.until)
            continue
        until = released if current.until is None else max(current.until, released)
        result[turn.brigade] = Quiet(current.blocked, until)
    return result
