// Проверка обращения в текстах телефона для человека (TX-02): «вы», а не «ты»,
// без неформальных побуждений. Стенды (stand*.tsx) — служебные страницы для
// разработки, их читает не обучаемый, поэтому они не проверяются.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = dirname(fileURLToPath(import.meta.url));

const SKIP_FILES = new Set(["stand.tsx", "stand-live.tsx"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx"))
      continue;
    if (SKIP_FILES.has(entry.name)) continue;
    out.push(full);
  }
  return out;
}

// Тот же список, что у TX-01 (progress.txt, «Правила текстов интерфейса»).
const FORBIDDEN = [
  "ты",
  "тебя",
  "тебе",
  "твой",
  "твоя",
  "твоё",
  "твои",
  "твоего",
  "твоей",
  "твоим",
  "твоих",
  "твоею",
  "нажми",
  "открой",
  "выбери",
  "введи",
  "позвони",
  "закрой",
  "поставь",
  "проверь",
  "напиши",
  "укажи",
  "отметь",
  "перейди",
  "вернись",
  "выйди",
  "дождись",
  "заполни",
  "сохрани",
  "отправь",
  "кликни",
];

const PATTERN = new RegExp(
  `(?<![а-яёА-ЯЁ])(${FORBIDDEN.join("|")})(?![а-яёА-ЯЁ])`,
  "giu",
);

describe("тексты телефона: обращение на «вы»", () => {
  for (const file of sourceFiles(DIR)) {
    it(`без «ты» и неформальных побуждений: ${file.slice(DIR.length + 1)}`, () => {
      const text = readFileSync(file, "utf-8");
      expect(text.match(PATTERN) ?? []).toEqual([]);
    });
  }
});
