// Проверка памяти посреди финальной смены (HQ-033; прототип A, 02.10 — «Стоп-кадр»).
// Решение 18.10: без паузы — смена идёт дальше, звонки не ждут. Вопросы и верные ответы
// считает сервер на момент показа (POST /sessions/{id}/memory-check), здесь — когда окно
// показать, какие варианты выбраны и как итог читается из журнала карточки.

import type { components } from "../../api-client/schema";

export type MemoryCheck = components["schemas"]["MemoryCheck"];
export type MemoryQuestion = components["schemas"]["MemoryCheckQuestion"];

/**
 * [ДОПУЩЕНИЕ] Когда показать: все карточки смены пришли и прошла минута после последней —
 * обстановка уже сложилась (у прототипа — через 5 с после выезда второго расчёта).
 */
export const MEMORY_AFTER_MS = 60_000;
/**
 * Пока идёт разговор или звонят, окно ждёт (прототип показывает стоп-кадр, когда линия
 * свободна), но не дольше этого срока: при звонках внахлёст линия финальной смены свободной
 * не бывает, а проверка должна состояться. Окно не модальное и не закрывает телефон (окно
 * телефона — поверх него), поэтому ни разговору, ни ответу на вызов не мешает.
 */
export const MEMORY_LATEST_MS = 120_000;

/** Повтор запроса вопросов после сбоя связи или ответа «карточек смены ещё нет». */
export const MEMORY_RETRY_MS = 10_000;

/**
 * Отказ сервера окончательный: проверки в этой смене не будет (смена не финальная или уже не
 * идёт). Остальное — сбой связи, 5xx, `memory_check_early` — повторяется.
 */
export function memoryCheckFinal(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code: unknown }).code
      : null;
  return code === "memory_check_unavailable" || code === "session_not_running";
}

/**
 * Пора ли показать проверку: карточки смены пришли, одна ещё в работе, срок подошёл. Пока
 * звонят (тревога, вызов бригады, отдел контроля) или идёт разговор — ждём до
 * `MEMORY_LATEST_MS`: неотвеченная тревога — критическая ошибка (решение 15.10), появившееся
 * окно не должно отвлечь от ответа. После срока окно показывается и при звонке.
 */
export function memoryCheckDue({
  appearedMs,
  expected,
  openCount,
  now,
  talking,
  ringing,
}: {
  /** Время появления пришедших карточек смены. */
  readonly appearedMs: readonly number[];
  /** Сколько карточек в смене (`settings.parallel_cards`). */
  readonly expected: number;
  /** Сколько из них не закрыто: по закрытой смене вопросы о силах ни о чём. */
  readonly openCount: number;
  readonly now: number;
  /** Идёт разговор. */
  readonly talking: boolean;
  /** Звонят: входящий вызов бригады (в том числе тревога) или отдел контроля. */
  readonly ringing: boolean;
}): boolean {
  if (appearedMs.length < Math.max(1, expected) || openCount === 0)
    return false;
  const last = Math.max(...appearedMs);
  if (now < last + MEMORY_AFTER_MS) return false;
  return (!talking && !ringing) || now >= last + MEMORY_LATEST_MS;
}

/**
 * Выбор варианта. В вопросе с одним ответом вариант заменяет прежний; во «всех верных»
 * переключается, а последний вариант («Ни одна», «По всем отмечено») исключает остальные.
 */
export function pick(
  question: MemoryQuestion,
  chosen: readonly string[],
  option: string,
): string[] {
  if (!question.multiple) return [option];
  if (chosen.includes(option)) return chosen.filter((item) => item !== option);
  const none = question.options.at(-1);
  if (option === none) return [option];
  return [...chosen.filter((item) => item !== none), option];
}

/** Вид варианта после ответа: верный, выбранный неверно или прочий. */
export function optionVerdict(
  correct: readonly string[],
  chosen: readonly string[],
  option: string,
): "ok" | "bad" | null {
  if (correct.includes(option)) return "ok";
  return chosen.includes(option) ? "bad" : null;
}

interface JournalEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/** Итог проверки из журнала карточки (`memory_check_answer`), если обучаемый ответил. */
export function memoryScore(
  events: readonly JournalEvent[],
): { score: number; total: number } | null {
  const answer = events.find((event) => event.type === "memory_check_answer");
  if (!answer) return null;
  const { score, total } = answer.payload;
  return typeof score === "number" && typeof total === "number"
    ? { score, total }
    : null;
}

/** Строка разбора и ленты преподавателя. */
export function memoryText(result: { score: number; total: number }): string {
  return `Проверка памяти: ${result.score} из ${result.total}`;
}

/** Запись журнала для ленты преподавателя: показ и ответ проверки памяти. */
export function memoryEventTitle(
  event: JournalEvent,
): { title: string; detail: string | null } | null {
  if (event.type === "memory_check") {
    const questions = Array.isArray(event.payload.questions)
      ? (event.payload.questions as { text?: unknown }[])
      : [];
    return {
      title: "Проверка памяти показана",
      detail:
        questions
          .map((item) => (typeof item.text === "string" ? item.text : ""))
          .filter(Boolean)
          .join(" ") || null,
    };
  }
  const result = memoryScore([event]);
  if (event.type === "memory_check_answer" && result) {
    const answers = Array.isArray(event.payload.answers)
      ? (event.payload.answers as unknown[])
      : [];
    return {
      title: memoryText(result),
      detail:
        answers
          .map((given) =>
            Array.isArray(given) && given.length ? given.join(", ") : "—",
          )
          .join(" · ") || null,
    };
  }
  return null;
}
