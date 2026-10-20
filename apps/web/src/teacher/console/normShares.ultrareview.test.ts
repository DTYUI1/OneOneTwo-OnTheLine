import { describe, expect, it } from "vitest";
import type { Evaluation } from "./model";
import { normShares } from "./reportModel";

const evaluation = (criteria: Evaluation["criteria"]): Evaluation => ({
  id: "evaluation",
  card_id: "card",
  trainee_id: "user",
  version: 1,
  status: "complete",
  total: 0.4,
  teacher_comment: "",
  model_info: { rules: "test" },
  criteria,
});
const criterion = (key: string, weight: number) => ({
  key,
  weight,
  score: 0,
  critical: true,
  evidence: [],
  explanation: "Критерий времени.",
});
const attempts = (overdue: boolean | null) =>
  [
    {
      card_id: "card",
      timing: { reaction_overdue: overdue, handling_overdue: overdue },
    },
  ] as unknown as NonNullable<Parameters<typeof normShares>[2]>;

const kinds = ["reaction", "handling"] as const;
describe("S03: применимость критерия в долях нормативов", () => {
  for (const kind of kinds) {
    for (const overdue of [false, true]) {
      it(`${kind}: вес 0 исключён при overdue=${overdue}`, () => {
        const result = normShares(
          [evaluation([criterion(`${kind}_time`, 0)])],
          new Map(),
          attempts(overdue),
        );
        expect(result[kind]).toEqual({ ok: 0, total: 0 });
        const other = kind === "reaction" ? "handling" : "reaction";
        expect(result[other]).toEqual({ ok: Number(!overdue), total: 1 });
        expect(result.passed).toEqual({ ok: 0, total: 1 });
      });

      for (const mode of ["positive", "missing-weight", "absent"] as const) {
        it(`${kind}: ${mode} сохраняет учёт при overdue=${overdue}`, () => {
          const legacy: Partial<ReturnType<typeof criterion>> = criterion(
            `${kind}_time`,
            1,
          );
          delete legacy.weight;
          const criteria =
            mode === "positive"
              ? [criterion(`${kind}_time`, 1)]
              : mode === "missing-weight"
                ? ([legacy] as unknown as Evaluation["criteria"])
                : [];
          expect(
            normShares([evaluation(criteria)], new Map(), attempts(overdue))[
              kind
            ],
          ).toEqual({ ok: Number(!overdue), total: 1 });
        });
      }
    }
  }

  it("не меняет исходные данные, общий зачёт и решение преподавателя", () => {
    const excluded = evaluation([
      criterion("reaction_time", 1),
      criterion("handling_time", 0),
    ]);
    const assessed = { ...excluded, card_id: "assessed", criteria: [] };
    const unscored = {
      ...excluded,
      card_id: "unscored",
      model_info: { rules: "unavailable:test" },
    };
    const samples = [
      ...attempts(false),
      { ...attempts(true)[0], card_id: "assessed" },
      { ...attempts(false)[0], card_id: "unscored" },
      { ...attempts(false)[0], card_id: "unmatched" },
    ];
    const evaluations = [excluded, assessed, unscored];
    const totals = new Map([["card", 0.9]]);
    const before = JSON.stringify([evaluations, samples, [...totals]]);
    expect(normShares(evaluations, totals, samples)).toEqual({
      reaction: { ok: 1, total: 2 },
      handling: { ok: 0, total: 1 },
      passed: { ok: 1, total: 2 },
    });
    expect(JSON.stringify([evaluations, samples, [...totals]])).toBe(before);
  });

  it("не считает отсутствие достоверного времени выполненным нормативом", () => {
    expect(normShares([evaluation([])], new Map(), attempts(null))).toEqual({
      reaction: { ok: 0, total: 0 },
      handling: { ok: 0, total: 0 },
      passed: { ok: 0, total: 1 },
    });
  });
});
