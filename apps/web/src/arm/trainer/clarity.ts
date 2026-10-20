// Понятный комментарий (TC-08, docs/competitors/touches.md, «Подсказки и состояния»): его читает
// следующее звено, поэтому «ок», «отпр бр» и слова, набранные в английской раскладке
// («ghbyznf» вместо «принята»), стоит поправить до «Подтвердить». Подсказка — только во «Вместе»,
// у строки статуса (решение 17.10), и ничего не блокирует: сохранять можно и так, поле комментария не меняется само.
//
// Всё считается локально по правилам ниже, без словаря и без сети. Ложное срабатывание
// безвредно (подсказку можно не принять), поэтому правила узкие: лучше промолчать.
import type { DispatcherStatus } from "../cardModel";
import { commentHint } from "../cardModel";

/** Раскладка ЙЦУКЕН на английской клавиатуре: клавиша → буква. */
const LAYOUT: Readonly<Record<string, string>> = Object.fromEntries(
  [
    "qй",
    "wц",
    "eу",
    "rк",
    "tе",
    "yн",
    "uг",
    "iш",
    "oщ",
    "pз",
    "[х",
    "]ъ",
    "aф",
    "sы",
    "dв",
    "fа",
    "gп",
    "hр",
    "jо",
    "kл",
    "lд",
    ";ж",
    "'э",
    "zя",
    "xч",
    "cс",
    "vм",
    "bи",
    "nт",
    "mь",
    ",б",
    ".ю",
    "`ё",
  ].flatMap(([key, letter]) =>
    /[a-z]/u.test(key)
      ? [
          [key, letter],
          [key.toUpperCase(), letter.toUpperCase()],
        ]
      : [[key, letter]],
  ),
);

/** Буквы, которые в английской раскладке стоят на знаках препинания. */
const PUNCTUATION_LETTERS = new Set(["[", "]", ";", "'", "`", ",", "."]);

const VOWELS = /[аеёиоуыэюя]/u;

/** «ghbyznf» → «принята»; null — это не слово в английской раскладке. */
export function fromEnglishLayout(text: string): string | null {
  const tokens = text.trim().split(/\s+/u);
  let words = 0;
  const converted = tokens.map((token) => {
    // Знак в конце слова — знак препинания, а не буква («ghbyznf.»).
    const [, head = "", tail = ""] = /^(.*?)([.,!?]*)$/u.exec(token) ?? [];
    let letters = 0;
    let out = "";
    for (const char of head) {
      const letter = LAYOUT[char];
      if (letter && (/[a-z]/iu.test(char) || PUNCTUATION_LETTERS.has(char))) {
        out += letter;
        if (/[a-z]/iu.test(char)) letters += 1;
      } else if (/[0-9\-/]/u.test(char)) out += char;
      else return null;
    }
    if (letters >= 3) words += 1;
    return out + tail;
  });
  if (words === 0 || converted.includes(null as never)) return null;
  const result = converted.join(" ");
  // Слово без гласной — не русское: так набирают случайные буквы, поправлять нечего.
  if (!VOWELS.test(result.toLowerCase())) return null;
  return capitalize(result);
}

/** Сокращения, которые диспетчер пишет в комментарии; расшифровка однозначная. */
export const ABBREVIATIONS: Readonly<Record<string, string>> = {
  отпр: "отправлена",
  бр: "бригада",
  бриг: "бригада",
  выех: "выехала",
  приб: "прибыла",
  завер: "завершены",
};

/** «отпр бр» → «Отправлена бригада»; null — сокращений нет. */
export function expandAbbreviations(text: string): string | null {
  let changed = false;
  const tokens = text
    .trim()
    .split(/\s+/u)
    .map((token) => {
      const [, head = "", tail = ""] = /^(.*?)([.,!?;:]*)$/u.exec(token) ?? [];
      const full = ABBREVIATIONS[head.toLowerCase()];
      if (!full) return token;
      changed = true;
      return full + tail;
    });
  return changed ? capitalize(tokens.join(" ")) : null;
}

/** Слова, которые ничего не сообщают следующему звену. */
const FILLER = new Set([
  "ок",
  "окей",
  "окэй",
  "ok",
  "okay",
  "ага",
  "угу",
  "да",
  "норм",
  "нормально",
  "хорошо",
  "ладно",
  "ясно",
  "понял",
  "готово",
  "+",
]);

/** Комментарий из одного-двух пустых слов («ок», «да, норм»). */
export function isFiller(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[.,!?;:]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);
  return (
    words.length > 0 && words.length <= 2 && words.every((w) => FILLER.has(w))
  );
}

/** Что показать под полем комментария. */
export interface ClarityHint {
  /** `fix` — есть исправление, его можно подставить; `short` — комментарий ничего не сообщает. */
  readonly kind: "fix" | "short";
  /** Строка для обучаемого. */
  readonly text: string;
  /** Исправленный комментарий для кнопки «Подставить»; у `short` его нет. */
  readonly suggestion: string | null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Подсказка к комментарию; null — всё понятно или комментарий пуст. Порядок: раскладка,
 * сокращения, пустые слова — первое сработавшее правило.
 */
export function commentClarity(
  text: string,
  status: DispatcherStatus | "",
  serviceId: string | null = null,
): ClarityHint | null {
  if (!text.trim()) return null;
  const fixed = fromEnglishLayout(text) ?? expandAbbreviations(text);
  if (fixed && fixed !== text.trim())
    return {
      kind: "fix",
      text: `Возможно, вы имели в виду: «${fixed}»`,
      suggestion: fixed,
    };
  if (isFiller(text)) {
    const what = status ? commentHint(status, serviceId) : null;
    return {
      kind: "short",
      text: `Комментарий читает следующее звено: «${text.trim()}» ничего ему не скажет.${
        what ? ` Напишите: ${what}.` : ""
      }`,
      suggestion: null,
    };
  }
  return null;
}
