import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Stage } from "../replay/Replay";
import { buildTimeline, type TimelineInput } from "../replay/timeline";
import { criterionScoreLabel } from "../../arm/results/debrief";
import { weakestFirst, type Evaluation } from "./model";
import { recommend, typicalErrors, weakPoints } from "./reportModel";

const criterion = (key: string, weight: number, critical = false) => ({
  key,
  weight,
  score: 0,
  critical,
  evidence: [],
  explanation: "Критерий не применялся.",
});
const evaluation: Evaluation = {
  id: "evaluation",
  card_id: "card",
  trainee_id: "user",
  version: 1,
  status: "complete",
  total: 1,
  teacher_comment: "",
  model_info: { rules: "test" },
  criteria: [criterion("spelling", 0, true), criterion("routing", 1)],
};

describe("S03: критерии с сохранённым весом 0", () => {
  it("не попадают в слабые места и типичные ошибки преподавателя", () => {
    expect(weakPoints("user", [evaluation]).map((item) => item.key)).toEqual([
      "routing",
    ]);
    expect(typicalErrors([evaluation]).map((item) => item.key)).toEqual([
      "routing",
    ]);
  });
  it("не понижают рекомендацию из-за неприменимого critical", () => {
    expect(recommend(2, [evaluation, evaluation]).kind).toBe("up");
  });
  it("сохраняют подробности, но идут после оценённых критериев", () => {
    expect(weakestFirst(evaluation).map((item) => item.key)).toEqual([
      "routing",
      "spelling",
    ]);
  });
  it("список проблем отчёта не включает неприменимые критерии", () => {
    expect(weakestFirst(evaluation, true).map((item) => item.key)).toEqual([
      "routing",
    ]);
  });
  it("показывают не оценивается для любого нулевого веса, не только грамотности", () => {
    expect(criterionScoreLabel(criterion("routing", 0))).toBe("не оценивается");
    expect(criterionScoreLabel(criterion("routing", 1))).toContain("0 из 100");
  });
  it("повтор попытки сохраняет объяснение без представления неприменимого нуля как ошибки", () => {
    const input = {
      card: {
        id: "card",
        state: "completed",
        appeared_at: "2026-10-20T10:00:00Z",
        delivered_at: "2026-10-20T10:00:00Z",
        closed_at: "2026-10-20T10:01:00Z",
        source: { service_ids: ["102"] },
        current: {},
        interrupted_at: null,
        opened_at: null,
        session_id: "session",
      },
      events: [],
      services: [],
      settings: { reaction_normative_s: 30, handling_normative_s: 180 },
    } as unknown as TimelineInput;
    const html = renderToStaticMarkup(
      createElement(Stage, {
        input,
        timeline: buildTimeline(input),
        evaluation: { ...evaluation, criteria: [criterion("spelling", 0)] },
      }),
    );
    expect(html).toContain("не оценивается");
    expect(html).toContain("Критерий не применялся.");
    expect(html).not.toMatch(/class="[^"]*lost/);
  });
});
