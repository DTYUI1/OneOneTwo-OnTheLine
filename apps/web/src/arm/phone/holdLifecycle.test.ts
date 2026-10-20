import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, useEffect } from "react";
import { useHold } from "./useHold";
import { HOLD_LIMIT_MS, type HeldLine } from "./hold";
import type { ServerEvent } from "../../shared/api";

const mocks = vi.hoisted(() => ({ subscribe: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: vi.fn(),
}));
vi.mock("../../shared/session", () => ({
  useSession: () => ({
    user: { id: "user" },
    realtime: { subscribe: mocks.subscribe },
  }),
}));
const key = "dds-hold:user";
const line: HeldLine = {
  cardId: "closed-card",
  cardNumber: "100",
  callId: "call",
  kind: "brigade",
  phoneExt: "201",
  who: "Бригада",
  heldAt: 1000,
};
let storage: Map<string, string>;
beforeEach(() => {
  vi.clearAllMocks();
  storage = new Map([[key, JSON.stringify([line])]]);
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("синхронизация удержания с сервером (PR3-03/09)", () => {
  it("серверный отбой удаляет сохранённую линию без повторного локального отбоя", () => {
    const effect = vi.fn();
    let held!: ReturnType<typeof useHold>;
    function Harness() {
      held = useHold(effect);
      return null;
    }
    renderToStaticMarkup(createElement(Harness));
    // Второй эффект — подписка на сервер; первый только запускает локальные часы.
    vi.mocked(useEffect).mock.calls[1][0]();
    const receive = mocks.subscribe.mock.calls[0][0] as (
      event: ServerEvent,
    ) => void;
    receive({
      type: "call.state",
      payload: { id: line.callId, card_id: line.cardId, state: "ended" },
    } as ServerEvent);
    expect(storage.has(key)).toBe(false);
    held.dispatch({ type: "tick", at: 1000 + HOLD_LIMIT_MS });
    held.dispatch({
      type: "resume",
      callId: line.callId,
      at: 1000 + HOLD_LIMIT_MS,
    });
    expect(effect).not.toHaveBeenCalled();
  });
  it("перезагрузка не продлевает срок: истёкшая сохранённая линия завершается", () => {
    const effect = vi.fn();
    let held!: ReturnType<typeof useHold>;
    function Harness() {
      held = useHold(effect);
      return null;
    }
    renderToStaticMarkup(createElement(Harness));
    expect(held.state.held[0]?.heldAt).toBe(1000);
    held.dispatch({
      type: "resume",
      callId: line.callId,
      at: 1000 + HOLD_LIMIT_MS,
    });
    expect(effect).toHaveBeenCalledWith({
      type: "hangup",
      cardId: line.cardId,
      callId: line.callId,
      report: null,
    });
    expect(storage.has(key)).toBe(false);
  });
});
