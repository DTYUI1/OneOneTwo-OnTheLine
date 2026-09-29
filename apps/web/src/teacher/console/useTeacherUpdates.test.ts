import { describe, expect, it } from "vitest";
import { teacherQueryKeys } from "./useTeacherUpdates";

describe("обновления пульта по WS", () => {
  it.each(["evaluation.partial", "evaluation.complete"])(
    "%s обновляет вердикт, отчёт, аналитику и реплей",
    (type) => {
      expect(teacherQueryKeys(type)).toEqual([
        "evaluations",
        "report",
        "analytics",
        "replay",
      ]);
    },
  );
  it("переподключение восстанавливает все связанные представления", () => {
    expect(teacherQueryKeys("snapshot")).toEqual([
      "sessions",
      "session",
      "assignments",
      "cards",
      "evaluations",
      "report",
      "analytics",
      "replay",
    ]);
  });
  it("старт обновляет выбранное занятие, карточка — список и разбор", () => {
    expect(teacherQueryKeys("session.started")).toContain("session");
    expect(teacherQueryKeys("session.finished")).toContain("report");
    expect(teacherQueryKeys("card.appeared")).toContain("cards");
    expect(teacherQueryKeys("card.updated")).toContain("replay");
    // Время и слои оценки попытки меняются вместе с карточкой.
    expect(teacherQueryKeys("card.updated")).toContain("analytics");
  });
  it("часы и presence не вызывают лишних HTTP-запросов", () => {
    expect(teacherQueryKeys("clock.pong")).toEqual([]);
    expect(teacherQueryKeys("presence")).toEqual([]);
  });
});
