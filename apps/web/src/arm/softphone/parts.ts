// Ввод без микрофона по частям (GP-06, docs/dds_gameplay.md, раздел 6): сведения
// собираются шагами, на шаге до трёх коротких вариантов — один верный и похожие ошибки,
// какие делает живой человек: буква в названии улицы, цифра в доме, другое происшествие.
// Варианты частей из файла сценария (`input_parts`) до окна разговора пока не доходят —
// ошибки строятся из карточки. Чистые функции: окно разговора только подставляет карточку.

import type { Card } from "../../shared/api";

/** Вариант части: что диспетчер говорит и верно ли это. Верный на экране не отмечается. */
export interface PartOption {
  readonly text: string;
  readonly correct: boolean;
}

export interface PartStep<K extends string = string> {
  readonly key: K;
  /** Что собирается на шаге — «Адрес», «Что случилось». */
  readonly label: string;
  readonly options: readonly PartOption[];
}

/** На шаге не больше трёх вариантов, каждый короче 60 символов (раздел 6). */
export const MAX_OPTIONS = 3;
export const MAX_OPTION_LENGTH = 59;

/** Длинное сведение карточки — по границе слова, с многоточием. */
export function short(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ").replace(/\.$/, "");
  if (clean.length <= MAX_OPTION_LENGTH) return clean;
  const cut = clean.slice(0, MAX_OPTION_LENGTH - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : cut).replace(/[\s,.:;-]+$/, "")}…`;
}

function seeded(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/** Порядок постоянен в пределах звонка и не выдаёт верный местом. */
export function shuffle<T>(items: readonly T[], seed: string): T[] {
  const random = seeded(seed);
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/**
 * Варианты шага: верный и ошибки, без повторов и пустых, не больше трёх, короткие,
 * перемешаны по звонку и шагу.
 */
export function stepOptions(
  correct: string,
  wrong: readonly (string | null)[],
  seed: string,
): PartOption[] {
  const right = short(correct);
  const seen = new Set([right.toLowerCase()]);
  const options: PartOption[] = [{ text: right, correct: true }];
  for (const item of wrong) {
    if (!item || options.length >= MAX_OPTIONS) continue;
    const text = short(item);
    if (seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    options.push({ text, correct: false });
  }
  return shuffle(options, seed);
}

// Звонкие и глухие пары и похожие на слух согласные: так ошибаются, записывая улицу на слух.
const SIMILAR: Record<string, string> = {
  б: "п",
  п: "б",
  в: "ф",
  ф: "в",
  г: "к",
  к: "г",
  д: "б",
  т: "д",
  ж: "ш",
  ш: "ж",
  з: "с",
  с: "з",
  м: "н",
  н: "м",
  л: "р",
  р: "л",
};

/** Слово улицы с одной буквой не той: `nth` — какая по счёту согласная меняется. */
export function similarWord(word: string, nth: number): string | null {
  const places = [...word]
    .map((ch, index) => (SIMILAR[ch.toLowerCase()] ? index : -1))
    .filter((index) => index >= 0);
  const at = places[nth];
  if (at === undefined) return null;
  const letters = [...word];
  const old = letters[at]!;
  const swap = SIMILAR[old.toLowerCase()]!;
  letters[at] = old === old.toLowerCase() ? swap : swap.toUpperCase();
  return letters.join("");
}

/** Дом с лишней цифрой: «12» → «124», «24» → «241»; буквы и дроби сохраняются. */
export function similarHouse(house: string): string {
  const match = /^(\d+)(.*)$/.exec(house.trim());
  if (!match) return `${house.trim()}1`;
  const digits = match[1]!;
  return `${digits}${digits.endsWith("4") ? "1" : "4"}${match[2]}`;
}

/** Номер с последней цифрой не той: так путают номер карточки. */
export function similarNumber(number: string): string {
  const match = /(\d)(\D*)$/.exec(number);
  if (!match) return `${number}1`;
  const digit = (Number(match[1]) + 1) % 10;
  return `${number.slice(0, match.index)}${digit}${match[2]}`;
}

const STREET_TYPES = new Set([
  "улица",
  "бульвар",
  "проспект",
  "шоссе",
  "переулок",
  "проезд",
  "площадь",
  "набережная",
  "тупик",
  "аллея",
  "линия",
]);

/** Название улицы без типа: в нём и ошибаются («Дубнинская» → «Бубнинская»). */
function streetName(street: string): string | null {
  const words = street
    .split(/\s+/)
    .filter((word) => word && !STREET_TYPES.has(word.toLowerCase()));
  return words.reduce<string | null>(
    (longest, word) =>
      longest === null || word.length > longest.length ? word : longest,
    null,
  );
}

type Address = Pick<Card["source"]["address"], "street" | "house" | "building">;

/** Адрес коротко, как его диктуют: «Дубнинская улица, 12, корпус 2». */
export function addressText(address: Address): string {
  return [
    address.street.trim(),
    address.house.trim(),
    address.building.trim() && `корпус ${address.building.trim()}`,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Адрес: верный и две похожие ошибки — буква в улице и лишняя цифра в доме, буква в
 * другом месте улицы и тот же дом («Дубнинская, 12» · «Бубнинская, 124» · «Дупнинская, 12»).
 */
export function addressOptions(address: Address, seed: string): PartOption[] {
  const name = streetName(address.street);
  const street = (nth: number): string | null => {
    const changed = name ? similarWord(name, nth) : null;
    return changed ? address.street.replace(name!, changed) : null;
  };
  const first = street(0);
  const second = street(1) ?? street(2);
  const house = address.house.trim() ? similarHouse(address.house) : "";
  return stepOptions(
    addressText(address),
    [
      first && addressText({ ...address, street: first, house }),
      second && addressText({ ...address, street: second }),
      // Улицу не исказить — ошибка в доме.
      house && addressText({ ...address, house }),
    ],
    `${seed}:address`,
  );
}

// Происшествия, которые путают с услышанным: другой вызов той же смены.
const OTHER_INCIDENTS = [
  "Пожар в подъезде",
  "Запах газа в подъезде",
  "Драка на улице",
  "Человеку плохо на улице",
  "Затопление квартиры",
  "Застрял лифт",
  "ДТП без пострадавших",
];

function stems(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[а-яё]{4,}/g) ?? []).map((word) =>
      word.slice(0, 4),
    ),
  );
}

/** Что случилось: повод карточки и два других происшествия без общих слов с ним. */
export function incidentOptions(incident: string, seed: string): PartOption[] {
  const own = stems(incident);
  const others = shuffle(
    OTHER_INCIDENTS.filter(
      (item) => ![...stems(item)].some((stem) => own.has(stem)),
    ),
    `${seed}:incident`,
  );
  return stepOptions(incident, others.slice(0, 2), `${seed}:what`);
}
