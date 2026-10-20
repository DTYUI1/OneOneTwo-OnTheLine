import { describe, expect, it } from "vitest";
import {
  DROPPED_SHOWN_MS,
  heldFor,
  HOLD_LIMIT_MS,
  initialHold,
  reduceHold,
  type HoldEvent,
  type HoldState,
} from "./hold";
import type { ReportLog } from "../softphone/heldTalk";

const line = {
  cardId: "card-1",
  cardNumber: "70005401",
  callId: "call-1",
  kind: "brigade",
  phoneExt: "201",
  who: "Старший бригады · 201",
} as const;

const report: ReportLog = {
  callId: "call-2",
  choices: ["no_address"],
  modes: ["option"],
  parts: [["who", "card"]],
  loudness: [null],
  voiceFailures: 0,
  registration: null,
};

const service = {
  cardId: "card-2",
  cardNumber: "70005201",
  callId: "call-2",
  kind: "service",
  phoneExt: "103",
  who: "Служба 103",
  saved: { lines: [], report, said: ["who", "card"] },
} as const;

function run(events: readonly HoldEvent[], from: HoldState = initialHold) {
  let state = from;
  const effects = [];
  for (const event of events) {
    const next = reduceHold(state, event);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

describe("Удержание линий (TC-02, вкладки 17.10)", () => {
  it("на удержание — линия ждёт, таймер с момента удержания", () => {
    const { state, effects } = run([{ type: "hold", line, at: 1000 }]);
    expect(state.held).toEqual([{ ...line, heldAt: 1000 }]);
    expect(effects).toEqual([]);
    expect(heldFor(state.held[0]!, 43_000)).toBe("0:42");
    expect(heldFor(state.held[0]!, 1000 + 61_000)).toBe("1:01");
  });

  it("несколько линий сразу — любая служба, каждая со своим разговором", () => {
    const { state } = run([
      { type: "hold", line, at: 0 },
      { type: "hold", line: service, at: 5000 },
      // Та же линия дважды не встаёт, первое время удержания не теряется.
      { type: "hold", line, at: 9000 },
    ]);
    expect(state.held.map((item) => [item.callId, item.heldAt])).toEqual([
      ["call-1", 0],
      ["call-2", 5000],
    ]);
    expect(state.held[1]!.saved?.report).toBe(report);
  });

  it("снятие с удержания — именно эта линия, остальные ждут", () => {
    const { state, effects } = run([
      { type: "hold", line, at: 1000 },
      { type: "hold", line: service, at: 2000 },
      { type: "resume", callId: "call-2", at: 20_000 },
    ]);
    // Просьба не передаёт владение: обе линии ещё сохранены.
    expect(state.held.map((item) => item.callId)).toEqual(["call-1", "call-2"]);
    const accepted = reduceHold(state, { type: "resumed", callId: "call-2" });
    expect(accepted.state.held.map((item) => item.callId)).toEqual(["call-1"]);
    expect(effects).toEqual([
      { type: "resume", line: { ...service, heldAt: 2000 } },
    ]);
  });

  it("через 3 мин удержания собеседник кладёт трубку: отбой и вкладка в окне", () => {
    const before = run([
      { type: "hold", line, at: 0 },
      { type: "hold", line: service, at: 60_000 },
      { type: "tick", at: HOLD_LIMIT_MS - 1 },
    ]);
    expect(before.state.held).toHaveLength(2);
    expect(before.effects).toEqual([]);
    const { state, effects } = run(
      [{ type: "tick", at: HOLD_LIMIT_MS }],
      before.state,
    );
    expect(state.held.map((item) => item.callId)).toEqual(["call-2"]);
    expect(state.dropped).toMatchObject([
      { callId: "call-1", droppedAt: HOLD_LIMIT_MS },
    ]);
    expect(effects).toEqual([
      { type: "hangup", cardId: "card-1", callId: "call-1", report: null },
    ]);
    // Служба кладёт трубку позже — отбой уносит доклад, сказанный до удержания.
    const service2 = run([{ type: "tick", at: 60_000 + HOLD_LIMIT_MS }], state);
    expect(service2.effects).toEqual([
      { type: "hangup", cardId: "card-2", callId: "call-2", report },
    ]);
    // Отбой — один раз; вкладки гаснут сами.
    const later = run(
      [
        { type: "tick", at: 60_000 + HOLD_LIMIT_MS + 1000 },
        { type: "resume", callId: "call-1", at: 60_000 + HOLD_LIMIT_MS + 2000 },
        { type: "tick", at: 60_000 + HOLD_LIMIT_MS + DROPPED_SHOWN_MS },
      ],
      service2.state,
    );
    expect(later.effects).toEqual([]);
    expect(later.state).toEqual(initialHold);
  });

  it("снова на удержание — вкладка «не дождался» той же линии уходит", () => {
    const dropped = run([
      { type: "hold", line, at: 0 },
      { type: "tick", at: HOLD_LIMIT_MS },
    ]).state;
    const { state } = run([{ type: "hold", line, at: HOLD_LIMIT_MS }], dropped);
    expect(state.dropped).toEqual([]);
    expect(state.held).toHaveLength(1);
  });

  it("сервер закончил звонок — удерживать нечего, отбоя нет", () => {
    const held = run([{ type: "hold", line, at: 0 }]).state;
    expect(reduceHold(held, { type: "ended", callId: "other" }).state).toBe(
      held,
    );
    const { state, effects } = run(
      [
        { type: "ended", callId: "call-1" },
        { type: "tick", at: HOLD_LIMIT_MS },
      ],
      held,
    );
    expect(state).toEqual(initialHold);
    expect(effects).toEqual([]);
  });

  it("снятие после предела до следующего тика не оживляет истёкший звонок (PR3-09)", () => {
    const held = run([{ type: "hold", line: service, at: 1000 }]).state;
    const { state, effects } = reduceHold(held, {
      type: "resume",
      callId: service.callId,
      at: 1000 + HOLD_LIMIT_MS,
    });
    expect(state.held).toEqual([]);
    expect(state.dropped).toMatchObject([{ callId: service.callId }]);
    expect(effects).toEqual([
      {
        type: "hangup",
        cardId: service.cardId,
        callId: service.callId,
        report,
      },
    ]);
  });

  it("снять нечего — ничего не делает", () => {
    expect(
      reduceHold(initialHold, { type: "resume", callId: "call-1", at: 0 }),
    ).toEqual({ state: initialHold, effects: [] });
    expect(reduceHold(initialHold, { type: "tick", at: 5 }).state).toBe(
      initialHold,
    );
  });
});
