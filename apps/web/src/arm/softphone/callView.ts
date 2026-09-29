// Что показывает телефон в полосе и крупной строке панели. Чистые функции без
// React: Softphone.tsx только подставляет состояние, решения проверяются тестами.
import type { CallState } from "./machine";

/**
 * Сворачивать ли панель после отбоя. Направленная бригада ещё не доложила —
 * следующий звонок ей, и панель со списком бригад нужна открытой: иначе между
 * звонком службе и звонком бригаде её приходится раскрывать заново.
 */
export function shouldAutoCollapse(input: {
  readonly committed: number;
  readonly accepted: number;
  /** Вызов сброшен до ответа: итог нужно прочитать. */
  readonly aborted?: boolean;
  /** Нужна реакция обучаемого: запись не ушла, номер не принят. */
  readonly attention?: boolean;
}): boolean {
  if (input.aborted || input.attention) return false;
  return input.committed <= input.accepted;
}

export interface Phrase {
  readonly text: string;
  /** Реплики ещё нет — строка про ожидание, приглушённым стилем. */
  readonly waiting: boolean;
}

/**
 * Крупная строка панели. В разговоре с бригадой её доклад — главное на экране:
 * он и стоит в крупной строке, а не только мелким текстом под списком бригад.
 */
export function phraseFor(
  call: {
    readonly state: CallState;
    readonly inbound: boolean;
    readonly withBrigade: boolean;
    /** Текст реплики службы, если она прозвучала. */
    readonly spoken: string | null;
  },
  brigadeReport: string | null,
): Phrase {
  if (call.state === "talking" && call.withBrigade && brigadeReport)
    return { text: brigadeReport, waiting: false };
  if (call.spoken) return { text: call.spoken, waiting: false };
  return {
    text: call.inbound
      ? "Бригада на связи — слушайте доклад"
      : call.state === "dialing"
        ? "Соединение"
        : "Ждём ответа",
    waiting: true,
  };
}

/**
 * Входящий звонок не смешивается со старым итогом: пока бригада вызывает, в
 * полосе не видно «Звонок завершён» и номер прошлого разговора — только «Ответить».
 */
export function stripSummary(input: {
  readonly state: CallState;
  readonly aborted: boolean;
  readonly ringingIn: boolean;
}): { readonly label: string; readonly showExt: boolean } {
  if (input.ringingIn && (input.state === "idle" || input.state === "ended"))
    return { label: STATE_LABEL.idle, showExt: false };
  return {
    label:
      input.state === "ended" && input.aborted
        ? "Вызов сброшен"
        : STATE_LABEL[input.state],
    showExt: true,
  };
}

const STATE_LABEL: Record<CallState, string> = {
  idle: "Телефон",
  dialing: "Соединение",
  ringing: "Идёт вызов",
  talking: "Разговор",
  ended: "Звонок завершён",
};
