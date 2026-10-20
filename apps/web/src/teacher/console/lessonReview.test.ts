import { describe, expect, it } from "vitest";
import { totalsLine } from "./LessonReview";

const base = {
  user_id: "u",
  full_name: "Иванов",
  draft: "",
  text: null,
  released_at: null,
};

describe("totalsLine", () => {
  it("показывает оценку ИИ и итоговую, если преподаватель правил", () => {
    expect(totalsLine({ ...base, ai_total: 0.64, final_total: 0.75 })).toBe(
      "оценка ИИ 64 → итоговая 75",
    );
  });
  it("без правки — одно число", () => {
    expect(totalsLine({ ...base, ai_total: 0.5, final_total: 0.5 })).toBe(
      "оценка 50",
    );
  });
  it("без оценок — «не оценивалось»", () => {
    expect(totalsLine({ ...base, ai_total: null, final_total: null })).toBe(
      "не оценивалось",
    );
  });
});
