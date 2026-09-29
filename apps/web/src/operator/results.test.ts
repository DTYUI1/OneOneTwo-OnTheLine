import { describe, expect, it } from "vitest";
import { CHOOSE_TRAINING } from "../shared/WelcomeGate";
import { exitTarget, summarize } from "./results";
import type { AttemptSummary } from "./save";

const attempt = (
  id: string,
  scenario: string,
  total: number,
): AttemptSummary => ({
  id,
  scenario_id: scenario,
  scenario_title: scenario === "lift" ? "Ребёнок застрял в лифте" : "ДТП",
  created_at: "2026-09-29T12:00:00Z",
  total,
  max_total: 100,
});

describe("экран результатов 112", () => {
  it("сводка: всего, средний и лучший процент, по звонку — раз, лучший, последний", () => {
    // Сервер отдаёт попытки новыми сверху: последняя по лифту — 91.
    const summary = summarize([
      attempt("3", "lift", 91),
      attempt("2", "dtp", 40),
      attempt("1", "lift", 67),
    ]);
    expect(summary.count).toBe(3);
    expect(summary.average).toBe(66);
    expect(summary.best).toBe(91);
    expect(summary.calls).toEqual([
      {
        scenarioId: "lift",
        title: "Ребёнок застрял в лифте",
        count: 2,
        best: 91,
        last: 91,
        max: 100,
      },
      {
        scenarioId: "dtp",
        title: "ДТП",
        count: 1,
        best: 40,
        last: 40,
        max: 100,
      },
    ]);
  });

  it("без попыток — пустая сводка", () => {
    expect(summarize([])).toEqual({
      count: 0,
      average: null,
      best: null,
      calls: [],
    });
  });

  it("крестик: обучаемый — к выбору обучения, остальные — в свой раздел", () => {
    expect(exitTarget("trainee")).toEqual({
      to: "/arm",
      state: CHOOSE_TRAINING,
    });
    expect(exitTarget("teacher")).toEqual({ to: "/teacher" });
    expect(exitTarget("admin")).toEqual({ to: "/admin" });
  });
});
