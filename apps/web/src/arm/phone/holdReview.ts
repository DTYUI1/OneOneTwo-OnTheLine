// Удержание в разборе (HQ-033, финальный сценарий): по отметкам `call_hold` / `call_resume`
// журнала карточки — сколько линий держали, сколько ждал собеседник и кто не дождался
// (`call_hangup`, пока линия на удержании: через HOLD_LIMIT_MS собеседник кладёт трубку).
// Только показ, на балл не влияет — методики оценки удержания нет. Чистые функции.
import type { components } from "../../api-client/schema";

type StoredEvent = components["schemas"]["StoredEvent"];

export interface HoldSpan {
  readonly callId: string;
  readonly startedMs: number;
  /** Сколько собеседник ждал: до снятия, отбоя или `endMs`, если линия ещё на удержании. */
  readonly waitS: number;
  /** Собеседник не дождался — отбой пришёл, пока линия была на удержании. */
  readonly dropped: boolean;
}

export interface HoldSummary {
  /** Сколько разных линий (звонков) ставили на удержание. */
  readonly lines: number;
  readonly spans: readonly HoldSpan[];
  /** Самое долгое ожидание одного удержания, с. */
  readonly longestS: number;
  readonly dropped: number;
}

function callOf(event: StoredEvent): string {
  const value = event.payload.call_id;
  return typeof value === "string" ? value : "";
}

export function holdSpans(
  events: readonly StoredEvent[],
  endMs: number,
): HoldSpan[] {
  const ordered = [...events].sort(
    (left, right) => Date.parse(left.server_ts) - Date.parse(right.server_ts),
  );
  const open = new Map<string, number>();
  const spans: HoldSpan[] = [];
  const close = (callId: string, atMs: number, dropped: boolean) => {
    const startedMs = open.get(callId);
    if (startedMs === undefined) return;
    open.delete(callId);
    spans.push({
      callId,
      startedMs,
      waitS: Math.max(0, (atMs - startedMs) / 1000),
      dropped,
    });
  };
  for (const event of ordered) {
    const callId = callOf(event);
    const atMs = Date.parse(event.server_ts);
    if (event.type === "call_hold" && !open.has(callId)) open.set(callId, atMs);
    else if (event.type === "call_resume") close(callId, atMs, false);
    else if (event.type === "call_hangup") close(callId, atMs, true);
  }
  for (const callId of [...open.keys()]) close(callId, endMs, false);
  return spans.sort((left, right) => left.startedMs - right.startedMs);
}

export function holdSummary(
  events: readonly StoredEvent[],
  endMs: number,
): HoldSummary | null {
  const spans = holdSpans(events, endMs);
  if (spans.length === 0) return null;
  return {
    lines: new Set(spans.map((span) => span.callId)).size,
    spans,
    longestS: Math.max(...spans.map((span) => span.waitS)),
    dropped: spans.filter((span) => span.dropped).length,
  };
}

function duration(seconds: number): string {
  const total = Math.round(seconds);
  return total < 60
    ? `${total} с`
    : `${Math.floor(total / 60)} мин ${String(total % 60).padStart(2, "0")} с`;
}

/** Строка разбора: «На удержании были 2 линии, дольше всего ждали 1 мин 05 с; …». */
export function holdText(summary: HoldSummary): string {
  const lines =
    summary.lines === 1 ? "была 1 линия" : `были линии: ${summary.lines}`;
  const dropped =
    summary.dropped > 0
      ? `; не дождались и положили трубку: ${summary.dropped}`
      : "";
  return `На удержании ${lines}, дольше всего ждали ${duration(summary.longestS)}${dropped}.`;
}
