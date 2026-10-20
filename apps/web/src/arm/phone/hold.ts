// Удержание линий телефона ДДС (TC-02; вкладки линий — проверка 17.10, «надо звонки сделать
// по вкладкам на плашке звонков и добавить удержание звонков»). Ответ на вызов или снятие
// другой линии ставит идущий разговор на удержание: он ждёт («на удержании 0:42»), после
// снятия собеседник снова на связи. Удерживается любой разговор — со старшим бригады, с
// дежурным службы или абонентом ДДС, с отделом контроля; линий на удержании может быть
// несколько, каждая помнит свой разговор (`saved`: лента и доклад службе). Через
// HOLD_LIMIT_MS удержания собеседник кладёт трубку сам. Чистая машина без React и таймеров:
// окно телефона подставляет время, эффекты исполняет ArmPage.
import type { CardEvent } from "../../shared/api";
import { formatDuration } from "../cardModel";
import type { ReportLog, SavedTalk } from "../softphone/heldTalk";

/**
 * Сколько собеседник ждёт на удержании, потом кладёт трубку. Срок один для всех: старший
 * бригады, дежурный службы и отдел контроля ждут одинаково [ДОПУЩЕНИЕ] — у эталона срока
 * для службы нет, а разные сроки обучаемому не запомнить.
 */
export const HOLD_LIMIT_MS = 180_000;
/** Сколько видна вкладка «не дождался на удержании» — потом гаснет сама. */
export const DROPPED_SHOWN_MS = 15_000;

/** Кто на линии: старший бригады, служба или абонент ДДС, отдел контроля. */
export type LineKind = "brigade" | "service" | "control";

/** Разговор на удержании: чей звонок и где его снять. */
export interface HeldLine {
  readonly cardId: string;
  /** Номер происшествия — для «по карточке …». */
  readonly cardNumber: string;
  readonly callId: string;
  readonly kind: LineKind;
  /** Номер собеседника (201, 101, 112…): снятие возвращает на линию его. */
  readonly phoneExt: string;
  /** Подпись вкладки: «Старший бригады · 201», «Служба 101», «Отдел контроля». */
  readonly who: string;
  readonly heldAt: number;
  /** Разговор до удержания (лента, доклад службе); у отдела контроля — нет. */
  readonly saved?: SavedTalk | null;
}

export interface DroppedLine extends HeldLine {
  readonly droppedAt: number;
}

export interface HoldState {
  /** Линии на удержании — в порядке удержания. */
  readonly held: readonly HeldLine[];
  /** Собеседник не дождался и положил трубку — вкладка, пока не погаснет. */
  readonly dropped: readonly DroppedLine[];
}

export type HoldEvent =
  | {
      readonly type: "hold";
      readonly line: Omit<HeldLine, "heldAt">;
      readonly at: number;
    }
  | { readonly type: "resume"; readonly callId: string; readonly at: number }
  /** Получатель синхронно принял разговор; только теперь можно удалить снимок. */
  | { readonly type: "resumed"; readonly callId: string }
  | { readonly type: "tick"; readonly at: number }
  /** Сервер закончил звонок сам (занятие завершено): удерживать нечего. */
  | { readonly type: "ended"; readonly callId: string };

export type HoldEffect =
  /**
   * Собеседник положил трубку: обычный `call_hangup` в очередь карточки; у службы — с
   * докладом, сказанным до удержания (`report`), иначе оценка его не увидит.
   */
  | {
      readonly type: "hangup";
      readonly cardId: string;
      readonly callId: string;
      readonly report: ReportLog | null;
    }
  /** Снять с удержания: открыть карточку линии, её разговор снова на связи. */
  | { readonly type: "resume"; readonly line: HeldLine };

export interface HoldStep {
  readonly state: HoldState;
  readonly effects: readonly HoldEffect[];
}

export const initialHold: HoldState = { held: [], dropped: [] };

function step(state: HoldState, effects: readonly HoldEffect[] = []): HoldStep {
  return { state, effects };
}

export function reduceHold(state: HoldState, event: HoldEvent): HoldStep {
  switch (event.type) {
    case "hold": {
      const { callId } = event.line;
      if (state.held.some((line) => line.callId === callId)) return step(state);
      return step({
        held: [...state.held, { ...event.line, heldAt: event.at }],
        dropped: state.dropped.filter((line) => line.callId !== callId),
      });
    }
    case "resume": {
      const line = state.held.find((item) => item.callId === event.callId);
      if (!line) return step(state);
      // Вкладка могла спать: не снимаем уже истёкшее удержание до ближайшего тика.
      if (event.at - line.heldAt >= HOLD_LIMIT_MS)
        return reduceHold(state, { type: "tick", at: event.at });
      return step(state, [{ type: "resume", line }]);
    }
    case "tick": {
      const gone = state.held.filter(
        (line) => event.at - line.heldAt >= HOLD_LIMIT_MS,
      );
      const shown = state.dropped.filter(
        (line) => event.at - line.droppedAt < DROPPED_SHOWN_MS,
      );
      if (gone.length === 0 && shown.length === state.dropped.length)
        return step(state);
      return step(
        {
          held: state.held.filter((line) => !gone.includes(line)),
          dropped: [
            ...shown,
            ...gone.map((line) => ({ ...line, droppedAt: event.at })),
          ],
        },
        gone.map((line) => ({
          type: "hangup",
          cardId: line.cardId,
          callId: line.callId,
          report: line.saved?.report ?? null,
        })),
      );
    }
    case "resumed":
    case "ended":
      if (!state.held.some((line) => line.callId === event.callId))
        return step(state);
      return step({
        ...state,
        held: state.held.filter((line) => line.callId !== event.callId),
      });
  }
}

/** «м:сс» — сколько линия на удержании. */
export function heldFor(held: HeldLine, now: number): string {
  return formatDuration((now - held.heldAt) / 1000, { compact: true });
}

/**
 * Отметка удержания в журнал карточки линии (HQ-033): `call_hold` — разговор встал на
 * удержание, `call_resume` — снят. Сервер ограничивает время удержания по этим событиям;
 * отметки также нужны разбору — сколько линий держали и сколько ждал собеседник.
 */
export function holdMark(
  type: "call_hold" | "call_resume",
  callId: string,
  at: Date = new Date(),
): CardEvent {
  return {
    client_event_id: crypto.randomUUID(),
    client_ts: at.toISOString(),
    type,
    payload: { call_id: callId },
  };
}
