import { describe, expect, it } from "vitest";
import { overrideDraft } from "./overrideDraft";

describe("форма решения преподавателя", () => {
  it("восстанавливает изменённый балл и причину после повторного открытия", () => {
    expect(
      overrideDraft({
        override_id: "o1",
        decision: "disagree",
        new_total: 0.42,
        reason: "Система неверно рассчитала",
        teacher_comment: "Повторить адрес",
        created_at: "2026-10-18T12:00:00Z",
      }),
    ).toEqual({
      decision: "disagree",
      choice: "miscalculated",
      otherReason: "",
      comment: "Повторить адрес",
      newTotal: "42",
    });
  });

  it("сохраняет собственное объяснение преподавателя", () => {
    const draft = overrideDraft({
      override_id: "o2",
      decision: "disagree",
      new_total: 0.8,
      reason: "Звонок был, но запись не сохранилась",
      teacher_comment: "",
      created_at: "2026-10-18T12:00:00Z",
    });
    expect(draft.choice).toBe("other");
    expect(draft.otherReason).toBe("Звонок был, но запись не сохранилась");
  });

  it("подтверждение не превращает причину согласия в причину несогласия", () => {
    const draft = overrideDraft({
      override_id: "o3",
      decision: "agree",
      new_total: null,
      reason: "Согласен с оценкой системы",
      teacher_comment: "Хорошая работа",
      created_at: "2026-10-18T12:00:00Z",
    });
    expect(draft).toMatchObject({
      decision: "agree",
      choice: "disagree",
      otherReason: "",
      comment: "Хорошая работа",
      newTotal: "",
    });
  });
});
