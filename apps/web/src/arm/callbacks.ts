// Сколько бригада ждала ответа диспетчера (27.09, бригада звонит сама). Только показ
// в разборе: утверждённой методики нет (Q&A Q10), на балл не влияет.
import type { components } from "../api-client/schema";

export type Callback = NonNullable<
  components["schemas"]["CardTraining"]["callbacks"]
>[number];

/** Ориентир, после которого ожидание бригады отмечается в разборе, — как норматив реакции. */
export const BRIGADE_ANSWER_S = 30;

export interface BrigadeWait {
  readonly callId: string;
  readonly brigadeId: string;
  readonly startedMs: number;
  /** Ждала до ответа, до конца вызова или до `endMs`, если вызов ещё идёт. */
  readonly waitS: number;
  readonly answered: boolean;
}

export function brigadeWaits(
  callbacks: readonly Callback[],
  endMs: number,
): BrigadeWait[] {
  return callbacks.map((call) => {
    const startedMs = Date.parse(call.started_at);
    const stopMs = Date.parse(call.answered_at ?? call.ended_at ?? "") || endMs;
    return {
      callId: call.call_id,
      brigadeId: call.brigade_id,
      startedMs,
      waitS: Math.max(0, Math.round((stopMs - startedMs) / 1000)),
      answered: call.answered_at !== null,
    };
  });
}

/** Ожидания дольше ориентира — их показывают в разборе. */
export function lateAnswers(
  callbacks: readonly Callback[],
  endMs: number,
): BrigadeWait[] {
  return brigadeWaits(callbacks, endMs).filter(
    (wait) => wait.waitS > BRIGADE_ANSWER_S,
  );
}
