// Предъявление учебных сведений: когда сообщение можно запросить и что считается
// предъявленным. Чистые правила без React, сети и звука — здесь живут инварианты
// I-BRIGADE, и здесь же их проверяют тесты.
//
// Главное правило: предъявлением считается только реально прозвучавшее аудио
// (событие `ended`) либо явное подтверждение прочтения видимого текста. Ни выдача
// файла, ни запрос автовоспроизведения, ни таймер предъявлением не являются.

import type { components } from "../../../api-client/schema";

export type PlannedMessage = components["schemas"]["PlannedMessage"];
export type DeliveredMessage = components["schemas"]["DeliveredMessage"];
export type InformationEvidence = components["schemas"]["InformationEvidence"];
export type PresentationReceipt = components["schemas"]["PresentationReceipt"];
export type PresentationFailure = components["schemas"]["PresentationFailure"];
export type FailureReason = PresentationFailure["reason"];

/** Состояние предъявления по контракту: проекция журнала, а не сам журнал. */
export type EvidenceState = InformationEvidence["state"];

/**
 * Почему сообщение сейчас нельзя запросить. `null` — можно.
 * Причина возвращается словами: обучаемому нужно понять, чего он ждёт.
 */
export type Unavailable =
  | "not-talking"
  | "too-early"
  | "session-finished"
  | null;

export interface AvailabilityInput {
  readonly callState: string;
  /** Момент ответа на исходящий звонок — отсчёт `available_after_s` идёт от него. */
  readonly answeredAtMs: number | null;
  readonly availableAfterS: number;
  readonly nowMs: number;
  readonly sessionFinished: boolean;
}

export function availability(input: AvailabilityInput): Unavailable {
  if (input.sessionFinished) return "session-finished";
  // Сообщение выдаётся только в разговоре: до ответа собеседника его неоткуда взять.
  if (input.callState !== "talking" || input.answeredAtMs === null)
    return "not-talking";
  const elapsedS = (input.nowMs - input.answeredAtMs) / 1000;
  return elapsedS >= input.availableAfterS ? null : "too-early";
}

/** Сколько секунд осталось ждать; `0` — уже можно. */
export function waitLeftS(input: AvailabilityInput): number {
  if (input.answeredAtMs === null) return input.availableAfterS;
  const elapsedS = (input.nowMs - input.answeredAtMs) / 1000;
  return Math.max(0, Math.ceil(input.availableAfterS - elapsedS));
}

/** Одна попытка проигрывания. `playbackId` создаётся до попытки и переживает повтор. */
export interface Attempt {
  readonly playbackId: string;
  readonly deliveryId: string;
  readonly messageVersion: number;
  readonly audioVersion: number | null;
  readonly channel: PresentationReceipt["channel"];
}

export interface Settlement {
  readonly state: EvidenceState;
  /** Что уйдёт на сервер. `null` — ничего: попытка уже учтена или исход не меняет дела. */
  readonly emit:
    | {
        readonly type: "message_presented";
        readonly payload: PresentationReceipt;
      }
    | { readonly type: "message_failed"; readonly payload: PresentationFailure }
    | null;
  /** Попытка уже разрешалась: один playback не бывает одновременно успешным и нет. */
  readonly conflict: boolean;
  readonly settled: readonly string[];
}

export interface Ledger {
  readonly state: EvidenceState;
  /** Разрешившиеся попытки — защита от двойного сообщения при повторе и обрыве. */
  readonly settled: readonly string[];
}

export const EMPTY_LEDGER: Ledger = { state: "delivered", settled: [] };

/**
 * Итог одной попытки. Правила контракта, которые здесь соблюдаются:
 *
 * - один `playback_id` разрешается ровно один раз, повтор — конфликт;
 * - после успешного предъявления поздний сбой другой попытки его не отменяет;
 * - после сбоя успешная попытка всё ещё может предъявить сведения.
 */
export function settle(
  ledger: Ledger,
  attempt: Attempt,
  outcome: "presented" | FailureReason,
): Settlement {
  if (ledger.settled.includes(attempt.playbackId))
    return {
      state: ledger.state,
      emit: null,
      conflict: true,
      settled: ledger.settled,
    };

  const settled = [...ledger.settled, attempt.playbackId];
  const base = {
    delivery_id: attempt.deliveryId,
    playback_id: attempt.playbackId,
    message_version: attempt.messageVersion,
    // Для аудио версия обязательна, для текста — null.
    audio_version: attempt.channel === "audio" ? attempt.audioVersion : null,
  };

  if (outcome === "presented")
    return {
      state: "presented",
      emit: {
        type: "message_presented",
        payload: { ...base, channel: attempt.channel },
      },
      conflict: false,
      settled,
    };

  return {
    // Успешное предъявление уже состоялось — поздний сбой его не отменяет.
    state: ledger.state === "presented" ? "presented" : "failed",
    emit: { type: "message_failed", payload: { ...base, reason: outcome } },
    conflict: false,
    settled,
  };
}

/**
 * Ручной набор бригад заменяет прежний целиком. Набор нормализуется: пустой и
 * дубли контракт запрещает, а отправлять заведомо отклоняемое событие незачем.
 */
export function normalizeBrigades(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

export function brigadesChanged(
  current: readonly string[],
  next: readonly string[],
): boolean {
  const left = normalizeBrigades(current);
  const right = normalizeBrigades(next);
  return left.length !== right.length || left.some((id, i) => id !== right[i]);
}
