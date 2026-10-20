import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  it("рабочее поле ДДС: у каждой части есть ссылка на страницу памятки (GP-23)", () => {
    // Страницы памятки — разметка «=== PAGE N ===» в тексте из датасета.
    const memo = readFileSync(
      join(
        process.cwd(),
        "../../docs/dataset/Датасет/Работа с АРМ-112 для ДДС от ОКр_ГСИ.txt",
      ),
      "utf8",
    );
    const pages = new Set(
      [...memo.matchAll(/=== PAGE (\d+) ===/g)].map((match) =>
        Number(match[1]),
      ),
    );
    expect(pages.size).toBeGreaterThan(30);
    for (const guide of [ARM_GUIDE, CARD_GUIDE])
      for (const [key, topic] of Object.entries(guide.topics)) {
        expect(topic.memo, key).toBeTruthy();
        if (/^В памятке ДДС этого нет/.test(topic.memo!)) continue;
        expect(topic.memo, key).toMatch(/^Памятка ДДС, с\. \d/);
        // Все номера страниц в ссылке есть в памятке: «с. 21–22», «с. 11, … — с. 35–40».
        const cited = [...topic.memo!.matchAll(/с\. (\d+)(?:–(\d+))?/g)];
        expect(cited.length, key).toBeGreaterThan(0);
        for (const [, from, to] of cited)
          for (let page = Number(from); page <= Number(to ?? from); page++)
            expect(pages.has(page), `${key}: страницы ${page} нет`).toBe(true);
      }
  });
});
