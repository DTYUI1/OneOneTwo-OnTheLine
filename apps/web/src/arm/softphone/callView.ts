// Строка ожидания в разговоре: чья реплика или чего ждём. Чистая функция без React:
// Softphone.tsx только подставляет состояние, решение проверяется тестами.
import type { CallState } from "./machine";

export interface Phrase {
  readonly text: string;
  /** Реплики ещё нет — строка про ожидание, приглушённым стилем. */
  readonly waiting: boolean;
}

/**
 * Строка разговора. В разговоре с бригадой её доклад — главное: он и стоит в строке;
 * пока реплики нет — строка про ожидание.
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
