// Бригада дослушивает диспетчера: доклад звучит не сразу после ответа, а когда тот
// успел представиться. Микрофона нет — правило только по времени (`reportMayStart`).

/** Раньше этого после ответа бригада не говорит: диспетчер успевает представиться. */
export const MIN_LISTEN_MS = 2000;

export interface ListenInput {
  readonly now: number;
  /** Ответ на звонок: с этого момента бригада слушает. */
  readonly talkStartedAt: number;
}

/** Можно ли начинать доклад: не раньше 2 с после ответа. */
export function reportMayStart(input: ListenInput): boolean {
  return input.now - input.talkStartedAt >= MIN_LISTEN_MS;
}
