// Пропущенные вызовы бригад (TC-02, docs/dds_touches.md; touches.md, «Входящий доклад
// бригады», 2): вызов звонит 25 с и гаснет «пропущенным», сервер пишет причину в
// `CardTraining.callbacks[].end_reason`. В окне телефона пропущенный виден, пока его доклад
// не услышан: перезвон старшему отдаёт пропущенный доклад. Второй пропуск того же доклада —
// «потерян»: бригада больше не звонит сама, доклад — только перезвоном.
import type { components } from "../../api-client/schema";

type CardTraining = components["schemas"]["CardTraining"];

/** Сколько звонит входящий бригады до «пропущенного» — как на сервере (worker, MISSED_AFTER). */
export const MISSED_AFTER_MS = 25_000;

export interface MissedCall {
  readonly callId: string;
  readonly brigadeId: string;
  readonly targetId: string;
  readonly endedAt: number;
  /** Второй пропуск того же доклада: бригада больше не звонит с ним сама. */
  readonly lost: boolean;
}

const MISSED = new Set(["missed", "lost"]);

/**
 * Пропущенные вызовы, доклад которых ещё не услышан, — по одному на бригаду, последний.
 * Бригада снова звонит — строки нет (на виду её вызов); с ней поговорили после пропуска или
 * её доклад прозвучал позже — пропущенный закрыт.
 */
export function missedCalls(
  training: Pick<CardTraining, "callbacks" | "messages" | "incoming">,
): MissedCall[] {
  const callbacks = [...(training.callbacks ?? [])].sort(
    (a, b) => Date.parse(a.started_at) - Date.parse(b.started_at),
  );
  const last = new Map<string, (typeof callbacks)[number]>();
  for (const call of callbacks) {
    if (call.answered_at !== null) last.delete(call.brigade_id);
    else if (call.end_reason && MISSED.has(call.end_reason))
      last.set(call.brigade_id, call);
  }
  const ringing = new Set(
    (training.incoming ?? []).map((call) => call.brigade_id),
  );
  return [...last.values()].flatMap((call) => {
    const endedAt = Date.parse(call.ended_at ?? "");
    if (ringing.has(call.brigade_id) || Number.isNaN(endedAt)) return [];
    const heard = training.messages.some(
      (item) =>
        item.delivery.brigade_id === call.brigade_id &&
        item.presented_at !== null &&
        Date.parse(item.presented_at) >= endedAt,
    );
    if (heard) return [];
    return [
      {
        callId: call.call_id,
        brigadeId: call.brigade_id,
        targetId: call.call_target_id,
        endedAt,
        lost: call.end_reason === "lost",
      },
    ];
  });
}
