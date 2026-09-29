import { describe, expect, it } from "vitest";
import { timeRows } from "./timeRows";
import type { TimingResult } from "./useAnalysis";

const base = {
  snapshot_id: "s",
  reaction_normative_s: 30,
  handling_normative_s: 180,
  anomalies: [],
  evidence: [],
  lifetime_s: 190,
};

describe("строки времени разбора", () => {
  it("v3: реакция до первичного статуса, активная и полная отработка, ожидание", () => {
    const rows = timeRows({
      ...base,
      timing_version: 3,
      reaction_s: 40,
      handling_s: 170,
      waiting_s: 60,
      active_handling_s: 110,
      reaction_overdue: true,
      handling_overdue: false,
      quality: "verified",
    } as unknown as TimingResult);
    expect(rows.map((row) => [row.seconds, row.verdict])).toEqual([
      [40, "over"],
      [110, "ok"],
      [60, "info"],
      [170, "info"],
    ]);
    expect(rows[0].label).toMatch(/Принята \/ Не принята/);
  });

  it("оценочное время: сервер не выносит превышение — сравнение для ориентира", () => {
    const rows = timeRows({
      ...base,
      timing_version: 3,
      reaction_s: 9,
      handling_s: 7,
      waiting_s: 0,
      active_handling_s: 7,
      reaction_overdue: null,
      handling_overdue: null,
      quality: "estimated",
    } as unknown as TimingResult);
    expect(rows[0].verdict).toBe("ok");
  });

  it("неизвестное время — «unknown», а не ноль", () => {
    const rows = timeRows({
      ...base,
      timing_version: 3,
      reaction_s: null,
      handling_s: null,
      waiting_s: null,
      active_handling_s: null,
      reaction_overdue: null,
      handling_overdue: null,
      quality: "estimated",
    } as unknown as TimingResult);
    expect(rows[0]).toMatchObject({ seconds: null, verdict: "unknown" });
  });

  it("v2: реакция — показ → открытие, отработка — полная", () => {
    const rows = timeRows({
      ...base,
      timing_version: 2,
      reaction_s: 20,
      handling_s: 170,
      waiting_s: null,
      active_handling_s: null,
      reaction_overdue: false,
      handling_overdue: false,
      quality: "verified",
    } as unknown as TimingResult);
    expect(rows).toHaveLength(2);
    expect(rows[0].label).toMatch(/до открытия/);
  });
});
