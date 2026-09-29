import { describe, expect, it } from "vitest";
import {
  CARD_GUIDE,
  ARM_GUIDE,
  REFERENCE_GUIDE,
  RESULTS_GUIDE,
} from "./topics";

const GUIDES = [
  ["карточка", CARD_GUIDE],
  ["список", ARM_GUIDE],
  ["результаты", RESULTS_GUIDE],
  ["материалы", REFERENCE_GUIDE],
] as const;

describe("тексты справки", () => {
  it.each(GUIDES)(
    "%s: у каждой части порядка есть текст и наоборот",
    (_, guide) => {
      expect(Object.keys(guide.topics).sort()).toEqual([...guide.order].sort());
      for (const id of guide.order) {
        const topic = guide.topics[id];
        expect(topic.title.length).toBeGreaterThan(0);
        expect(topic.text.length).toBeGreaterThan(0);
      }
    },
  );
  it("без английских слов и без капса в заголовках", () => {
    for (const [, guide] of GUIDES)
      for (const topic of Object.values(guide.topics)) {
        const text = [topic.title, topic.text].join(" ");
        // Названия клавиш — как напечатаны на клавиатуре.
        expect(text.replace(/Backspace|Enter|Esc/g, "")).not.toMatch(
          /[A-Za-z]{3,}/,
        );
        expect(topic.title).not.toMatch(/^[А-ЯЁ\s]{4,}$/);
      }
  });
});
