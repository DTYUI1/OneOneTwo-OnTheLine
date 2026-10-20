import { describe, expect, it } from "vitest";
import type { components } from "../../api-client/schema";
import { holdSpans, holdSummary, holdText } from "./holdReview";
import { holdMark } from "./hold";

type StoredEvent = components["schemas"]["StoredEvent"];

const base = Date.parse("2026-10-18T10:00:00Z");

function stored(type: string, callId: string, atS: number): StoredEvent {
  const ts = new Date(base + atS * 1000).toISOString();
  return {
    id: crypto.randomUUID(),
    card_id: "card",
    actor_id: "user",
    client_event_id: crypto.randomUUID(),
    client_ts: ts,
    server_ts: ts,
    clock_offset_ms: 0,
    type,
    payload: { call_id: callId },
  } as StoredEvent;
}

describe("Удержание в разборе (HQ-033)", () => {
  it("считает линии, ожидание и тех, кто не дождался", () => {
    const events = [
      stored("call_hold", "a", 10),
      stored("call_hold", "b", 20),
      stored("call_resume", "a", 75),
      stored("call_hangup", "b", 200),
      stored("call_hold", "a", 300),
    ];
    const spans = holdSpans(events, base + 330_000);
    expect(
      spans.map((span) => [span.callId, span.waitS, span.dropped]),
    ).toEqual([
      ["a", 65, false],
      ["b", 180, true],
      ["a", 30, false],
    ]);
    const summary = holdSummary(events, base + 330_000);
    expect(summary).toMatchObject({ lines: 2, longestS: 180, dropped: 1 });
    expect(holdText(summary!)).toBe(
      "На удержании были линии: 2, дольше всего ждали 3 мин 00 с; не дождались и положили трубку: 1.",
    );
  });
  it("без удержаний разбору нечего сказать", () => {
    expect(holdSummary([stored("call_hangup", "a", 5)], base)).toBeNull();
  });
  it("отметка удержания — событие карточки с call_id", () => {
    const at = new Date(base);
    expect(holdMark("call_hold", "a", at)).toMatchObject({
      type: "call_hold",
      client_ts: at.toISOString(),
      payload: { call_id: "a" },
    });
  });
});
