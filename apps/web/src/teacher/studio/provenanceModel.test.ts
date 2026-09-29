import { describe, expect, it } from "vitest";
import { provenanceLines, type ScenarioContent } from "./provenanceModel";

const content = (
  provenance: Partial<ScenarioContent["provenance"]>,
): ScenarioContent => ({
  scenario_id: "00000000-0000-4000-8000-000000000100",
  version: 1,
  provenance: {
    author_kind: "system",
    author_id: null,
    source_kind: "template",
    source_id: null,
    source_version: null,
    sha256: null,
    synthetic: true,
    ...provenance,
  },
  training_plan: null,
});

describe("provenanceLines", () => {
  it("синтетическое задание из шаблона команды", () => {
    const lines = provenanceLines(content({}));
    expect(lines[0].value).toBe("синтетическое задание · шаблон команды");
    expect(lines[1].value).toBe("команда (встроенный набор)");
  });

  it("билет из материалов — с идентификатором и версией источника", () => {
    const lines = provenanceLines(
      content({
        synthetic: false,
        source_kind: "imported",
        source_id: "Билет 7",
        source_version: "2",
        author_kind: "teacher",
        sha256: "a".repeat(64),
      }),
    );
    expect(lines[0].value).toBe(
      "билет/задача из материалов · импорт («Билет 7», версия 2)",
    );
    expect(lines[1].value).toBe(
      "преподаватель · контрольная сумма aaaaaaaaaaaa…",
    );
  });

  it("проверка преподавателем не выдумывается", () => {
    const last = provenanceLines(content({})).at(-1);
    expect(last?.label).toBe("Проверка преподавателем");
    expect(last?.value).toMatch(/не считается проверенным/);
  });
});
