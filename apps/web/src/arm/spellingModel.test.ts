import { describe, expect, it } from "vitest";
import { applySuggestion, currentIssues } from "./spellingModel";

const issue = { start: 7, end: 11, word: "улце", suggestions: ["улице"] };

describe("подсказки орфографии", () => {
  it("заменяют слово вариантом исправления", () => {
    expect(applySuggestion("ДТП на улце, д. 1", issue, "улице")).toBe(
      "ДТП на улице, д. 1",
    );
  });

  it("не трогают текст, если слово уже исправили или сдвинули", () => {
    expect(applySuggestion("ДТП на улице", issue, "улице")).toBe(
      "ДТП на улице",
    );
    expect(currentIssues("Срочно ДТП на улце", [issue])).toEqual([]);
    expect(currentIssues("ДТП на улце", [issue])).toEqual([issue]);
  });

  it("слово без вариантов тоже показывают — в оценке это ошибка", () => {
    const unknown = { ...issue, suggestions: [] };
    expect(currentIssues("ДТП на улце", [unknown])).toEqual([unknown]);
  });
});
