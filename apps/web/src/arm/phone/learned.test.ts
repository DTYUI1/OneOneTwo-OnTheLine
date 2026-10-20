import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countLearned,
  isLearned,
  learn,
  learnedCounts,
  learnedKey,
  LEARNED_AFTER,
  LEARNED_HINTS,
  parseLearned,
  subscribeLearned,
} from "./learned";

afterEach(() => vi.unstubAllGlobals());

function memoryStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  return values;
}

describe("пояснения окна телефона прячутся после N верных действий (GP-24)", () => {
  it("N задано одним числом и больше одного: «несколько раз»", () => {
    expect(LEARNED_AFTER).toBeGreaterThan(1);
  });

  it.each(LEARNED_HINTS)(
    "«%s»: видно до N-го верного действия, после — спрятано",
    (hint) => {
      let counts = {};
      for (let done = 0; done < LEARNED_AFTER; done++) {
        expect(isLearned(counts, hint)).toBe(false);
        counts = countLearned(counts, hint);
      }
      expect(isLearned(counts, hint)).toBe(true);
      // Другие пояснения от этого не прячутся.
      for (const other of LEARNED_HINTS.filter((item) => item !== hint))
        expect(isLearned(counts, other)).toBe(false);
    },
  );

  it("выученное больше не считается: счётчик не растёт", () => {
    let counts = {};
    for (let done = 0; done < LEARNED_AFTER + 5; done++)
      counts = countLearned(counts, "dial");
    expect(counts).toEqual({ dial: LEARNED_AFTER });
  });

  it("сохранённое читается с проверкой: битое и чужое — как новое", () => {
    expect(parseLearned(null)).toEqual({});
    expect(parseLearned("не json")).toEqual({});
    expect(parseLearned("[1,2]")).toEqual({});
    expect(
      parseLearned(
        JSON.stringify({
          dial: 2,
          resize: -1,
          meter: 1.5,
          other: 9,
          report: 99,
        }),
      ),
    ).toEqual({ dial: 2, report: LEARNED_AFTER });
  });

  it("счётчик у каждой учётной записи свой и переживает перезагрузку", () => {
    const values = memoryStorage();
    const user = crypto.randomUUID();
    const other = crypto.randomUUID();
    const heard = vi.fn();
    const stop = subscribeLearned(heard);
    for (let done = 0; done < LEARNED_AFTER; done++) learn(user, "resize");
    stop();
    expect(isLearned(learnedCounts(user), "resize")).toBe(true);
    expect(isLearned(learnedCounts(other), "resize")).toBe(false);
    expect(heard).toHaveBeenCalledTimes(LEARNED_AFTER);
    expect(parseLearned(values.get(learnedKey(user)) ?? null)).toEqual({
      resize: LEARNED_AFTER,
    });
    expect(values.has(learnedKey(other))).toBe(false);
  });

  it("сохранённый счёт другой вкладки или прошлого входа прячет пояснение сразу", () => {
    const values = memoryStorage();
    const user = crypto.randomUUID();
    values.set(learnedKey(user), JSON.stringify({ meter: LEARNED_AFTER }));
    expect(isLearned(learnedCounts(user), "meter")).toBe(true);
    expect(isLearned(learnedCounts(user), "dial")).toBe(false);
  });

  it("запрет storage не ломает окно: пояснения видны, счёт — до перезагрузки", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("Storage disabled");
      },
      setItem: () => {
        throw new Error("Storage disabled");
      },
    });
    const user = crypto.randomUUID();
    expect(isLearned(learnedCounts(user), "dial")).toBe(false);
    for (let done = 0; done < LEARNED_AFTER; done++) learn(user, "dial");
    expect(isLearned(learnedCounts(user), "dial")).toBe(true);
  });
});
