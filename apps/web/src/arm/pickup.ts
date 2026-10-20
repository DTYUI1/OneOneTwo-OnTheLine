// Ответ на вызов бригады из колонки связи (DT-20, прототипы A и B): вызов может быть по
// другой карточке. АРМ кладёт трубку идущего разговора, открывает карточку вызова, а её
// софтфон снимает трубку. Модульное состояние, как callGuard: колонка и софтфон карточки
// живут в разных частях экрана.

import type { SavedTalk } from "./softphone/heldTalk";

let pending: { cardId: string; callId: string } | null = null;
const listeners = new Set<() => void>();
/** Когда попросили ответить или занять линию — для `awaitsLine`. */
let pendingAt = 0;
let lineAt = 0;

/**
 * Сколько софтфон может ждать сведений, чтобы исполнить просьбу: дольше — просьба уже ни о
 * чём (вызов ушёл, пока карточка загружалась), окно телефона её не ждёт.
 */
export const LINE_WAIT_MS = 10_000;

export function requestPickup(cardId: string, callId: string): void {
  pending = { cardId, callId };
  pendingAt = Date.now();
  for (const listener of listeners) listener();
}

/**
 * Вызов, который ждёт ответа в этой карточке. Забирается, только если `ready` его
 * узнал: сведения карточки могли ещё не загрузиться — тогда просьба ждёт их.
 */
export function takePickup(
  cardId: string,
  ready: (callId: string) => boolean,
): string | null {
  if (pending && Date.now() - pendingAt >= LINE_WAIT_MS) pending = null;
  if (pending?.cardId !== cardId || !ready(pending.callId)) return null;
  const { callId } = pending;
  pending = null;
  return callId;
}

/**
 * Линия из окна телефона, кроме ответа (TC-02): снять с удержания разговор карточки или
 * перезвонить старшему по пропущенному вызову. Как и ответ, просьба ждёт софтфон карточки.
 */
export type LineRequest =
  | {
      readonly kind: "resume";
      readonly cardId: string;
      readonly callId: string;
      readonly phoneExt: string;
      /** Разговор до удержания: лента и доклад службе (вкладки 17.10). */
      readonly saved?: SavedTalk | null;
      /** Передача владельцем удержания: снимок удаляется лишь после успешного start. */
      readonly accept?: (start: () => boolean) => boolean;
    }
  | {
      readonly kind: "dial";
      readonly cardId: string;
      readonly phoneExt: string;
    };

let line: LineRequest | null = null;

/** Отменяет лишь просьбу; удержанный разговор остаётся у useHold. */
export function cancelLine(callId?: string): void {
  if (!callId || (line?.kind === "resume" && line.callId === callId))
    line = null;
}

export function requestLine(request: LineRequest): void {
  line = request;
  lineAt = Date.now();
  for (const listener of listeners) listener();
}

/** Просьба для этой карточки, если софтфон готов (`ready`) её исполнить; забирается раз. */
export function takeLine(
  cardId: string,
  ready: (request: LineRequest) => boolean,
): LineRequest | null {
  if (line && Date.now() - lineAt >= LINE_WAIT_MS) line = null;
  if (line?.cardId !== cardId || !ready(line)) return null;
  const taken = line;
  line = null;
  return taken;
}

/**
 * Ждёт ли софтфон карточки, чтобы снять трубку или занять линию (сведения о бригадах ещё
 * грузятся): от ответа до начала разговора окно телефона уже отдано этой карточке.
 */
export function awaitsLine(cardId: string, now: number): boolean {
  return (
    (pending?.cardId === cardId && now - pendingAt < LINE_WAIT_MS) ||
    (line?.cardId === cardId && now - lineAt < LINE_WAIT_MS)
  );
}

/** Софтфон открытой карточки слушает просьбы ответить. */
export function onPickup(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
