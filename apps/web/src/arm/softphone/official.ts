// Должностное лицо службы в разговоре (TC-03; docs/competitors/touches.md, «Исходящий звонок
// должностному лицу», п. 8, 10, 13, и «Правдоподобие»). Все реплики — фразы банка озвучки
// (bank.ts): дежурный службы 101–104 — постоянный персонаж своей книги `OFFICIAL_<служба>`
// (представляется, называет номер регистрации), остальные абоненты — общий дежурный
// `OFFICIAL`. Свой текст за собеседника здесь не пишется.
//
// - похожая улица Москвы (data/confusable_streets.json, копия — confusableStreets.json) →
//   дежурный просит повторить улицу по буквам; те же пары у сервера (evalcore.officials);
// - номер регистрации выбирается по звонку детерминированно и уходит в отбой
//   (`call_hangup.registration_number`): его сверяют с комментарием карточки;
// - одна и та же фраза подряд не звучит; «Повторите» отдаёт прошлую реплику.
// Чистые функции: окно разговора только подставляет звонок и ленту.

import pairs from "./confusableStreets.json";
import {
  BANK_BOOKS,
  OFFICIAL,
  bankPhrases,
  bankText,
  type BankPhrase,
  type OfficialSlot,
} from "./bank";
import { shuffle, type PartStep } from "./parts";
import {
  ASK_IDS,
  nextAsk,
  type AddressGap,
  type ReportAsk,
  type ReportPart,
} from "./report";

/** Книга постоянного персонажа — дежурного службы по номеру; нет такой — `null`. */
export function personaBook(
  phoneExt: string | null | undefined,
): string | null {
  if (!phoneExt) return null;
  const book = `${OFFICIAL}_${phoneExt}`;
  return BANK_BOOKS[book]?.speaker === "official" ? book : null;
}

/** Номер фразы по ключу звонка: один звонок — всегда одна и та же фраза. */
function seedIndex(seed: string, size: number): number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % Math.max(1, size);
}

function phrasesOf(book: string, slot: OfficialSlot): readonly BankPhrase[] {
  return bankPhrases(book, slot).filter((phrase) => !phrase.only);
}

function pickSeeded(phrases: readonly BankPhrase[], seed: string): BankPhrase {
  const phrase = phrases[seedIndex(seed, phrases.length)];
  if (!phrase) throw new Error("Нет фраз банка для этого места");
  return phrase;
}

/**
 * Фраза места книги, одна и та же на весь звонок (`seed` — ключ звонка): бригада или общий
 * дежурный снимает трубку и отвечает голосом банка, а не записью Piper (проверка 17.10).
 */
export function seededPhrase(
  book: string,
  slot: string,
  seed: string,
): BankPhrase {
  return pickSeeded(
    bankPhrases(book, slot).filter((phrase) => !phrase.only),
    `${seed}:${slot}`,
  );
}

/** Дежурный снимает трубку и представляется: место `answer` персонажа. */
export function answerLine(book: string, seed: string): string {
  return pickSeeded(phrasesOf(book, "answer"), `${seed}:answer`).text;
}

/** Принял доклад и назвал номер регистрации (место `registered`; номер — цифрами). */
export function registeredLine(
  book: string,
  seed: string,
): { readonly text: string; readonly number: string } {
  const phrase = pickSeeded(
    phrasesOf(book, "registered"),
    `${seed}:registered`,
  );
  if (!phrase.number) throw new Error(`У фразы ${phrase.id} нет номера`);
  return { text: phrase.text, number: phrase.number };
}

// Какой вопрос задаёт дежурный, когда части доклада нет (памятка ДДС, с. 32): у адреса и
// повода — то, чего не хватило. Фразы «по буквам» — только для похожей улицы, а не для
// пропущенного адреса.
const ASK_SLOTS: Record<ReportAsk, OfficialSlot> = {
  who: "ask_who",
  place: "ask_address",
  reason: "ask_what",
  card: "ask_card",
  change: "ask_what",
};
const SPELLING = /по буквам/i;
// Отбор — по тексту фраз книги, поэтому редакция текста может его опустошить: каждый отбор
// каждой книги OFFICIAL* сверяет official.test.ts («отборы вопросов находят фразы»).
// Адреса нет совсем: «Повторите адрес полностью», «Уточните адрес: улица, дом» — не «номер
// дома» и не «подъезд».
const WHOLE_ADDRESS = /адрес/i;
const STREET_HOUSE = /улиц[а-я]*, дом|дом какой/i;
// Что изменилось: «Что изменилось по обстановке?», «Доложите обстановку на месте», у газовой
// службы — «перекрыта ли подача газа».
const CHANGED = /изменил|обстановк|сейчас|перекрыт/i;
// Повод без догадки о происшествии: «Уточните, что именно произошло», «Уточните повод к
// вызову», «Уточните, что требуется от полиции». Вопрос с догадкой («Уточните, что горит:
// квартира, подвал?») не к месту, когда горит машина (стенд 17.10).
const REASON = /случил|произош|повод/i;
const NEED = /помощь|требует|нужн/i;
// У скорой «Уточните, что случилось с человеком» — и повод, и что изменилось.
const PERSON = /с человеком/i;
// У газовой службы все вопросы места — о газе («Уточните, что с газом: запах, хлопок?»):
// догадки о другом происшествии в них нет.
const GAS = /газ/i;

/** Отбор фраз под вопрос: первые — лучшие; `fitted = false` — не подошла ни одна. */
export interface AskChoice {
  readonly texts: readonly string[];
  readonly fitted: boolean;
}

/** Фразы, подходящие под этот вопрос; первые — лучшие. Пустой отбор — всё место книги. */
function fitting(
  phrases: readonly BankPhrase[],
  tests: readonly RegExp[],
): { readonly phrases: readonly BankPhrase[]; readonly fitted: boolean } {
  const found = tests.flatMap((test) =>
    phrases.filter((phrase) => test.test(phrase.text)),
  );
  return found.length > 0
    ? { phrases: [...new Set(found)], fitted: true }
    : { phrases, fitted: false };
}

/** Формулировки вопроса `ask` у книги по порядку перебора (`askLine`). */
export function askCandidates(book: string, ask: ReportAsk): AskChoice {
  let choice: { readonly phrases: readonly BankPhrase[]; fitted: boolean } = {
    phrases: phrasesOf(book, ASK_SLOTS[ask]).filter(
      (phrase) => !SPELLING.test(phrase.text),
    ),
    fitted: true,
  };
  // Адреса нет совсем: «Повторите номер дома» или «Уточните подъезд» тут не к месту.
  if (ask === "place")
    choice = fitting(choice.phrases, [WHOLE_ADDRESS, STREET_HOUSE]);
  // Повод — «что случилось» без догадки; что изменилось — обстановка или что нужно.
  if (ask === "reason")
    choice = fitting(
      choice.phrases.filter((phrase) => !CHANGED.test(phrase.text)),
      [REASON, NEED, PERSON, GAS],
    );
  if (ask === "change")
    choice = fitting(choice.phrases, [CHANGED, NEED, PERSON, GAS]);
  const texts = choice.phrases.map((phrase) => phrase.text);
  // Общий дежурный спрашивает сначала прежними фразами (report.ASK_IDS, GP-25).
  if (book !== OFFICIAL) return { texts, fitted: choice.fitted };
  const own = bankText(ASK_IDS[ask]);
  return {
    texts: [own, ...texts.filter((text) => text !== own)],
    fitted: choice.fitted,
  };
}

/**
 * Вопрос дежурного о недостающем в докладе — одна фраза банка о первой недостающей
 * обязательной части (`required`: карточка — только в звонке в 112) по порядку памятки
 * (`report.nextAsk`; эталон банка — «переспрос одним вопросом»). `gap` — чего не хватило в
 * адресе и поводе. `turn` — который это вопрос в звонке: формулировки перебираются, и та же
 * фраза, что прозвучала последней (`previous`), подряд не повторяется. Все части есть — `null`.
 */
export function askLine(
  book: string,
  said: Iterable<ReportPart>,
  turn: number,
  previous: string | null,
  gap: AddressGap | null = null,
  required?: readonly ReportPart[],
): string | null {
  const ask = nextAsk(said, gap, required);
  if (ask === null) return null;
  const candidates = askCandidates(book, ask).texts;
  const text = candidates[turn % Math.max(1, candidates.length)] ?? null;
  if (text !== previous) return text;
  return candidates[(turn + 1) % candidates.length] ?? text;
}

/** Просьба повторить улицу по буквам; у книги без такой фразы — `null` (нет в банке). */
export function spellLine(book: string): string | null {
  return (
    phrasesOf(book, "ask_address").find((phrase) => SPELLING.test(phrase.text))
      ?.text ?? null
  );
}

// Тип улицы — каноническим словом, как в evalcore.officials.street_key.
const STREET_TYPES: Record<string, string> = {
  улица: "улица",
  ул: "улица",
  проспект: "проспект",
  "пр-т": "проспект",
  пр: "проспект",
  переулок: "переулок",
  пер: "переулок",
  шоссе: "шоссе",
  ш: "шоссе",
  бульвар: "бульвар",
  "б-р": "бульвар",
  набережная: "набережная",
  наб: "набережная",
  площадь: "площадь",
  пл: "площадь",
  проезд: "проезд",
  "пр-д": "проезд",
  тупик: "тупик",
  аллея: "аллея",
};
const WORD = /[0-9А-Яа-яЁё]+(?:-[0-9А-Яа-яЁё]+)*/g;

/** Название улицы без типа и тип: «ул. Дубнинская» → «дубнинская», «улица». */
export function streetKey(street: string): {
  readonly name: string;
  readonly kind: string | null;
} {
  const name: string[] = [];
  let kind: string | null = null;
  for (const word of street.match(WORD) ?? []) {
    const clean = word.toLowerCase().replace(/ё/g, "е");
    const type = STREET_TYPES[clean];
    if (type) kind = type;
    else name.push(clean);
  }
  return { name: name.join(" "), kind };
}

function sameStreet(left: string, right: string): boolean {
  const a = streetKey(left);
  const b = streetKey(right);
  if (!a.name || a.name !== b.name) return false;
  return a.kind === null || b.kind === null || a.kind === b.kind;
}

/** Улица, с которой легко спутать улицу карточки; нет пары — `null`. */
export function twinStreet(street: string | null | undefined): string | null {
  if (!street) return null;
  for (const pair of pairs.pairs) {
    const [first, second] = pair;
    if (!first || !second) continue;
    if (sameStreet(street, first)) return second;
    if (sameStreet(street, second)) return first;
  }
  return null;
}

/** Название улицы по буквам: «Дубнинская улица» → «Д-у-б-н-и-н-с-к-а-я». */
export function spelled(street: string): string {
  const name = (street.match(WORD) ?? [])
    .filter((word) => !STREET_TYPES[word.toLowerCase().replace(/ё/g, "е")])
    .join(" ");
  return [...name]
    .filter((ch) => ch !== " ")
    .map((ch, index) => (index === 0 ? ch.toUpperCase() : ch.toLowerCase()))
    .join("-");
}

/** Шаг «Улица по буквам» без микрофона: улица карточки и похожая, порядок — по звонку. */
export function spellStep(
  street: string,
  twin: string,
  seed: string,
): PartStep<"spell"> {
  return {
    key: "spell",
    label: "Улица по буквам",
    options: shuffle(
      [
        { text: spelled(street), correct: true },
        { text: spelled(twin), correct: false },
      ],
      `${seed}:spell`,
    ),
  };
}

const REPEAT =
  /(?:^|[^а-яё])(?:повторите|повтори|ещё раз|еще раз|не расслышал[аи]?|не понял[аи]?)(?![а-яё])/i;

/** Диспетчер просит повторить: короткая фраза «Повторите», «Ещё раз, не расслышал». */
export function wantsRepeat(text: string): boolean {
  const words = text.match(/[\p{L}]+/gu) ?? [];
  return words.length > 0 && words.length <= 5 && REPEAT.test(text);
}
