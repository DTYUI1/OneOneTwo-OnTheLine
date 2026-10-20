import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADDRESS_PAIRS,
  bestResult,
  lastMistakes,
  mistakeText,
  pairId,
  routingCorrect,
  routingItems,
  routingMistake,
  scoreText,
  withMissedFirst,
  type PracticeIncident,
  type SavedResult,
} from "./warmupModel";

const repo = join(process.cwd(), "../..");
const practiceDir = join(repo, "data/practice");
const incidents = readdirSync(practiceDir)
  .filter((name) => name.endsWith(".json"))
  .map(
    (name) =>
      JSON.parse(
        readFileSync(join(practiceDir, name), "utf8"),
      ) as PracticeIncident,
  );
const expected = routingItems(incidents);
const target = join(process.cwd(), "src/arm/warmup/routing.json");

if (process.env.UPDATE_WARMUP_ROUTING === "1")
  writeFileSync(target, JSON.stringify(expected, null, 2) + "\n");

const result = (
  kind: SavedResult["kind"],
  correct: number,
  duration_ms: number,
  created_at: string,
  mistakes: string[] = [],
): SavedResult => ({
  kind,
  correct,
  total: 10,
  duration_ms,
  mistakes,
  created_at,
});

describe("задания разминки", () => {
  it("«Кого направить» — копия совпадает с data/practice", () => {
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(expected);
    expect(expected.length).toBe(incidents.length);
    for (const item of expected)
      expect(item.services.length).toBeGreaterThan(0);
  });

  it("пары адресов: есть одинаковые и разные, у разных — пояснение", () => {
    expect(ADDRESS_PAIRS.some((pair) => pair.same)).toBe(true);
    expect(ADDRESS_PAIRS.filter((pair) => !pair.same).length).toBeGreaterThan(
      5,
    );
    for (const pair of ADDRESS_PAIRS) {
      if (pair.same) expect(pair.a).toBe(pair.b);
      else {
        expect(pair.a).not.toBe(pair.b);
        expect(pair.note).not.toBe("");
      }
    }
    // Ошибка хранится строкой не длиннее 300 знаков (контракт WarmupResultInput).
    for (const pair of ADDRESS_PAIRS)
      expect(pairId(pair).length).toBeLessThanOrEqual(300);
    for (const item of expected)
      expect(routingMistake(item).length).toBeLessThanOrEqual(300);
  });
});

describe("ответы и порядок", () => {
  const smoke = expected.find((item) => item.key === "smoke-apartment")!;

  it("«Кого направить» засчитан только при точном наборе служб", () => {
    expect(routingCorrect(smoke, [...smoke.services].reverse())).toBe(true);
    expect(routingCorrect(smoke, smoke.services.slice(1))).toBe(false);
    expect(routingCorrect(smoke, [...smoke.services, "MOSLIFT"])).toBe(false);
  });

  it("прошлые ошибки идут первыми — и для пар, и для происшествий", () => {
    const missedPair = pairId(ADDRESS_PAIRS[4]);
    const pairs = withMissedFirst(ADDRESS_PAIRS, pairId, [missedPair]);
    expect(pairId(pairs[0])).toBe(missedPair);
    expect(pairs).toHaveLength(ADDRESS_PAIRS.length);
    const items = withMissedFirst(expected, (item) => item.key, [
      routingMistake(smoke),
    ]);
    expect(items[0].key).toBe("smoke-apartment");
  });

  it("лучший — больше верных, при равенстве быстрее; ошибки — последней попытки", () => {
    const results = [
      result("address", 8, 60_000, "2026-10-11T10:00:00Z", ["a"]),
      result("address", 9, 90_000, "2026-10-11T11:00:00Z", ["b"]),
      result("address", 9, 70_000, "2026-10-11T09:00:00Z"),
      result("routing", 10, 10_000, "2026-10-11T12:00:00Z"),
    ];
    expect(bestResult(results, "address")?.duration_ms).toBe(70_000);
    expect(bestResult([], "routing")).toBeNull();
    expect(lastMistakes(results, "address")).toEqual(["b"]);
    expect(lastMistakes(results, "routing")).toEqual([]);
    expect(scoreText({ correct: 8, total: 10, duration_ms: 74_400 })).toBe(
      "8 из 10 за 1:14",
    );
  });
});

describe("итоги", () => {
  it("ошибка «Кого направить» — словами, а не ключом и кодами", () => {
    const names: Record<string, string> = {
      "101": "Пожарная охрана",
      "104": "Газовая служба",
    };
    const text = mistakeText(
      "gas-apartment: 101, 104",
      (id) => names[id] ?? id,
    );
    expect(text).toBe(
      "Сильный запах газа в квартире 34 на третьем этаже. Нужно: Пожарная охрана, Газовая служба.",
    );
    expect(text).not.toContain("gas-apartment");
  });

  it("ошибка в адресе показывается как есть", () => {
    const id = pairId(ADDRESS_PAIRS[0]);
    expect(mistakeText(id, (x) => x)).toBe(id);
  });
});
