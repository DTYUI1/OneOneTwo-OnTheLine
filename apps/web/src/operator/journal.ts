// Журнал звонка для разбора (этап 3, contracts/operator/evaluation.md): экран записывает
// каждое действие оператора и ответ заявителя с пометкой сервера, первую реплику и конец
// разговора; «сохранить» отправляет журнал в попытку, окно результата показывает его лентой.

import type { Action, AskResult, CallerState, Mark } from "./dialog";

export type JournalAction =
  | "opening"
  | "question"
  | "calm"
  | "hold"
  | "silence"
  | "advice"
  | "escalate"
  | "end";

export interface JournalEvent {
  /** Секунды от «Принять вызов». */
  readonly t: number;
  readonly action: JournalAction;
  readonly key?: string | null;
  readonly said?: string | null;
  readonly reply?: string | null;
  readonly note?: string | null;
  readonly outcome?: string | null;
  readonly panic_before?: number | null;
  readonly panic_after?: number | null;
  readonly mark?: Mark | null;
}

export interface StepTime {
  readonly step: number;
  readonly t: number;
}

export interface CallJournal {
  readonly events: readonly JournalEvent[];
  readonly steps: readonly StepTime[];
}

export const EMPTY_JOURNAL: CallJournal = { events: [], steps: [] };

/** Подписи пометок — как в прототипе: что помогло, что навредило, на что обратить внимание. */
export const MARK_LABELS: Readonly<Record<Mark["kind"], string>> = {
  good: "помогло",
  bad: "навредило",
  warn: "внимание",
  info: "событие",
};

/** Первая реплика: с какой паники начался звонок — событие, а не оценка оператора. */
export function openingEvent(text: string, panic: number): JournalEvent {
  const how =
    panic >= 3
      ? "заявитель в истерике"
      : panic === 2
        ? "заявитель в панике"
        : "заявитель взволнован";
  return {
    t: 0,
    action: "opening",
    reply: text,
    panic_before: panic,
    panic_after: panic,
    mark: { kind: "info", text: `Звонок начался: ${how}.` },
  };
}

function actionKey(action: Action): string | null {
  switch (action.kind) {
    case "question": {
      const question = action.question;
      if ("key" in question) return question.key;
      if ("distractor" in question) return question.distractor;
      return null;
    }
    case "calm":
      return action.calm;
    case "advice":
      return action.key;
    default:
      return null;
  }
}

/** Действие оператора и ответ заявителя — одно событие журнала. */
export function replyEvent(
  t: number,
  action: Action,
  said: string | undefined,
  before: CallerState,
  result: AskResult,
): JournalEvent {
  const key = result.reply.question_key ?? actionKey(action);
  return {
    t,
    action: action.kind,
    key,
    said: said ?? null,
    reply: result.reply.text || null,
    outcome: result.reply.outcome,
    panic_before: before.panic,
    panic_after: result.state.panic,
    mark: result.reply.mark,
  };
}

/** Конец разговора: срыв, нет контакта или карточка сохранена. */
export function endEvent(t: number, note: string): JournalEvent {
  return { t, action: "end", note };
}

/** Новые пройденные шаги — с временем, когда шаг пройден впервые. */
export function passSteps(
  steps: readonly StepTime[],
  done: readonly number[],
  t: number,
): StepTime[] {
  const known = new Set(steps.map((item) => item.step));
  return [
    ...steps,
    ...done
      .filter((step) => !known.has(step))
      .sort((a, b) => a - b)
      .map((step) => ({ step, t })),
  ];
}

/** Как изменилась паника — словами, без цифр (уровень паники обучаемому не показывается). */
export function panicChange(event: JournalEvent): string {
  const before = event.panic_before;
  const after = event.panic_after;
  if (before == null || after == null || before === after) return "";
  return after > before ? "Паника выросла." : "Паника снизилась.";
}

/** Время события в разборе: мм:сс. */
export function clock(t: number): string {
  const safe = Math.max(0, Math.floor(t));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

/** Журнал к сохранению: конец разговора дописывается, если его ещё нет. */
export function closeJournal(
  journal: CallJournal,
  t: number,
  note: string,
): CallJournal {
  const last = journal.events[journal.events.length - 1];
  if (last?.action === "end") return journal;
  // Время не убывает: часы страницы тикают раз в секунду и могут отстать от последнего события.
  const at = Math.max(t, last?.t ?? 0);
  return { ...journal, events: [...journal.events, endEvent(at, note)] };
}
