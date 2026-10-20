import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LINE_WAIT_MS,
  awaitsLine,
  onPickup,
  requestLine,
  requestPickup,
  takeLine,
  takePickup,
} from "./pickup";

afterEach(() => vi.useRealTimers());

describe("срок исполнения просьб линии (PR2-10)", () => {
  it.each(["pickup", "dial", "resume"] as const)(
    "%s: граница срока совпадает с ожиданием окна",
    (kind) => {
      vi.useFakeTimers();
      vi.setSystemTime(100_000);
      const request = () =>
        kind === "pickup"
          ? requestPickup("card", "call")
          : requestLine({
              kind,
              cardId: "card",
              callId: "call",
              phoneExt: "201",
            });
      const ready = vi.fn(() => true);
      const take = () =>
        kind === "pickup" ? takePickup("card", ready) : takeLine("card", ready);
      request();
      vi.advanceTimersByTime(LINE_WAIT_MS - 1);
      expect(awaitsLine("card", Date.now())).toBe(true);
      expect(take()).not.toBeNull();
      request();
      ready.mockClear();
      vi.advanceTimersByTime(LINE_WAIT_MS);
      expect(awaitsLine("card", Date.now())).toBe(false);
      expect(take()).toBeNull();
      expect(ready).not.toHaveBeenCalled();
      // Истёкшая просьба удалена: даже откат часов её не оживляет.
      vi.setSystemTime(0);
      expect(take()).toBeNull();
      request();
      expect(take()).not.toBeNull();
    },
  );
});

describe("ответ на вызов из колонки связи (DT-20)", () => {
  it("софтфон своей карточки забирает вызов, когда знает его", () => {
    const heard = vi.fn();
    const stop = onPickup(heard);
    requestPickup("card-1", "call-1");
    expect(heard).toHaveBeenCalledTimes(1);
    // Чужая карточка и ещё не загруженный вызов — просьба ждёт.
    expect(takePickup("card-2", () => true)).toBeNull();
    expect(takePickup("card-1", () => false)).toBeNull();
    expect(takePickup("card-1", (id) => id === "call-1")).toBe("call-1");
    // Забрана один раз.
    expect(takePickup("card-1", () => true)).toBeNull();
    stop();
  });

  it("снятие с удержания и перезвон ждут софтфон своей карточки (TC-02)", () => {
    const heard = vi.fn();
    const stop = onPickup(heard);
    const resume = {
      kind: "resume",
      cardId: "card-1",
      callId: "call-1",
      phoneExt: "201",
    } as const;
    requestLine(resume);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(takeLine("card-2", () => true)).toBeNull();
    expect(takeLine("card-1", () => false)).toBeNull();
    expect(takeLine("card-1", () => true)).toEqual(resume);
    expect(takeLine("card-1", () => true)).toBeNull();
    // Новая просьба заменяет прежнюю: перезвон после снятия.
    requestLine(resume);
    requestLine({ kind: "dial", cardId: "card-1", phoneExt: "201" });
    expect(takeLine("card-1", () => true)).toMatchObject({ kind: "dial" });
    stop();
  });
});
