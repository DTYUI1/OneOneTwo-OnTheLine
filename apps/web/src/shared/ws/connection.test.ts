import { describe, expect, it } from "vitest";
import {
  BACKOFF_FIRST_MS,
  connectionLine,
  nextBackoff,
  ONLINE,
  SHOW_AFTER_MS,
} from "./connection";

describe("Строка обрыва связи", () => {
  const since = 1_000_000;
  it("связи нет — строки нет", () => {
    expect(connectionLine(ONLINE, since)).toBeNull();
  });
  it("короткий обрыв не показываем", () => {
    const state = { online: false, since, retryAt: since + 500 };
    expect(connectionLine(state, since + SHOW_AFTER_MS - 1)).toBeNull();
  });
  it("считает секунды до попытки, не меньше одной", () => {
    const state = { online: false, since, retryAt: since + 6000 };
    expect(connectionLine(state, since + 2000)).toBe(
      "Работа не потеряна, переподключение через 4 с…",
    );
    expect(connectionLine(state, since + 5600)).toBe(
      "Работа не потеряна, переподключение через 1 с…",
    );
  });
  it("попытка идёт — «переподключаемся»", () => {
    const now = since + 3000;
    expect(
      connectionLine({ online: false, since, retryAt: since + 2000 }, now),
    ).toBe("Работа не потеряна, переподключаемся…");
    expect(connectionLine({ online: false, since, retryAt: null }, now)).toBe(
      "Работа не потеряна, переподключаемся…",
    );
  });
});

describe("Задержки переподключения", () => {
  it("0,5 → 1 → 2 → 4 → 5 с", () => {
    const steps = [BACKOFF_FIRST_MS];
    for (let i = 0; i < 5; i += 1) steps.push(nextBackoff(steps[i]));
    expect(steps).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
  });
});
