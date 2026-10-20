import { describe, expect, it } from "vitest";
import type { AttemptAnalysis } from "./useAnalysis";
import { analysisOutdated, analysisRevision } from "./useAnalysis";

describe("актуальность разбора оценки", () => {
  it("замечает изменение решения преподавателя без смены версии оценки", () => {
    const before = {
      total: 0.8,
      status: "complete",
      teacher_comment: "",
    } as const;
    expect(analysisRevision(before)).not.toBe(
      analysisRevision({ ...before, total: 0.4 }),
    );
    expect(analysisRevision(before)).not.toBe(
      analysisRevision({ ...before, teacher_comment: "Повторить" }),
    );
    expect(analysisRevision(null)).toBeNull();
  });

  it("повторяет запрос, если API разбора ещё вернул старый итог", () => {
    const analysis = {
      evaluation: {
        evaluation_id: "evaluation-1",
        evaluation_version: 1,
        effective_total: 0.8,
      },
    } as unknown as AttemptAnalysis;
    const target = {
      cardId: "card-1",
      evaluationId: "evaluation-1",
      evaluationVersion: 1,
      effectiveTotal: 0.4,
    };
    expect(analysisOutdated(analysis, target)).toBe(true);
    expect(analysisOutdated(analysis, { ...target, effectiveTotal: 0.8 })).toBe(
      false,
    );
  });
});
