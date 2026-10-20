// Память заявителя на разговор с карточкой (HQ-019): переживает отбой, удержание и перезвон
// в этой вкладке — заявитель помнит, что уже сказал. Отметка `caller_said` — в журнал
// карточки: по ней оценка знает, когда прозвучало сведение (HQ-020), а разбор — паузы и отбой.
import type { CardEvent } from "../../../shared/api";
import { freshMemory, type CallerMemory } from "./conversation";

const memories = new Map<string, CallerMemory>();

export function callerMemory(cardId: string): CallerMemory {
  return memories.get(cardId) ?? freshMemory;
}

export function rememberCaller(cardId: string, memory: CallerMemory): void {
  memories.set(cardId, memory);
}

/** Реплика заявителя `phraseId` прозвучала в звонке `callId`. */
export function callerSaid(
  callId: string,
  phraseId: string,
  at: Date = new Date(),
): CardEvent {
  return {
    client_event_id: crypto.randomUUID(),
    client_ts: at.toISOString(),
    type: "caller_said",
    payload: { call_id: callId, phrase_id: phraseId },
  };
}
