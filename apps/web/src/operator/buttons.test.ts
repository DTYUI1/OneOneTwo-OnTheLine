import { describe, expect, it } from "vitest";
import { BUTTON_EXPLANATIONS } from "./buttons";
import { EMPTY_JOURNAL, mergeTalkJournal, notifySenior } from "./journal";
import { OPERATOR_GUIDE } from "./help/topics";

describe("Кнопки АРМ", () => {
  it("объясняет каждый элемент и ссылается на существующую справку", () => {
    expect(Object.keys(BUTTON_EXPLANATIONS)).toHaveLength(11);
    for (const text of Object.values(BUTTON_EXPLANATIONS)) {
      expect(text.arm.trim().length).toBeGreaterThan(10);
      expect(text.trainer.trim().length).toBeGreaterThan(10);
      if (text.help) expect(OPERATOR_GUIDE.topics[text.help]).toBeDefined();
    }
  });
  it("записывает вызов старшего один раз за звонок", () => {
    const first = notifySenior(EMPTY_JOURNAL, 4);
    expect(first.events).toEqual([
      { t: 4, action: "senior_called", note: "позвал старшего" },
    ]);
    expect(notifySenior(first, 7)).toBe(first);
    expect(notifySenior(EMPTY_JOURNAL, 1).events).toHaveLength(1);
  });
  it("сохраняет отметку при следующих ответах и ответе на запрос, начатый до нажатия", () => {
    const first = notifySenior(EMPTY_JOURNAL, 4);
    const merged = mergeTalkJournal(first, {
      events: [
        { t: 2, action: "calm" },
        { t: 6, action: "hold" },
      ],
      steps: [{ step: 1, t: 6 }],
    });
    expect(merged.events.map((event) => event.action)).toEqual([
      "calm",
      "senior_called",
      "hold",
    ]);
    expect(merged.steps).toEqual([{ step: 1, t: 6 }]);
    expect(notifySenior(merged, 9)).toBe(merged);
  });
});
