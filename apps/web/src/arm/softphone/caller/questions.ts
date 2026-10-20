// Вопросы заявителю без микрофона (HQ-019, docs/dds_caller.md, раздел 2.3): «вопрос
// выбирается из списка, как варианты частей вводной». Вариант — та же фраза, что сказана
// голосом: её разбирает то же правило (`hearing.hear`). Адрес вслух — верный и с ошибкой в
// доме или квартире, как у части вводной «адрес». Вопросы о сведениях и просьба подойти — из
// таблицы сюжета (scripts/voices/bank/callers/plots/), код общий для всех сюжетов.
// Список короткий: то, что к месту сейчас, и один-два вопроса сверх (решение 19.10) — вместо
// всех шестнадцати сразу. Голосом по-прежнему можно спросить любое сведение сюжета.
import { shuffle } from "../parts";
import type { CallerBook } from "./book";
import { missingComeFacts, type CallerMemory } from "./conversation";

export interface CallerQuestion {
  /** Ключ варианта: `intro`, сведение, `readback:<n>`, `come`, `bye`. */
  readonly id: string;
  readonly text: string;
  /** Адрес вслух прочитан верно; у остальных вариантов поля нет. На экране не отмечается. */
  readonly correct?: boolean;
}

/** Квартира с переставленными цифрами («58» → «85»), иначе соседняя. */
function otherFlat(flat: string): string {
  const reversed = [...flat].reverse().join("");
  return reversed !== flat && !reversed.startsWith("0")
    ? reversed
    : String(Number(flat) + 1);
}

/** Дом без цифры («22» → «2»), однозначный — с лишней («2» → «12»). */
function otherHouse(house: string): string {
  const digits = house.replace(/\D/g, "");
  return digits.length > 1 ? digits.slice(1) : `1${digits}`;
}

/** Сколько вопросов на кнопках сразу, считая прощание (решение 19.10). */
export const MAX_QUESTIONS = 6;
/** Сколько вопросов сверх нужных сейчас остаётся в списке, и сколько вариантов адреса вслух. */
export const SPARE_QUESTIONS = 2;

export interface CallerQuestionsInput {
  readonly book: CallerBook;
  /** Своя служба (ДДС): ею диспетчер представляется. */
  readonly serviceName: string;
  readonly street: string;
  readonly house: string;
  readonly flat: string;
  readonly seed: string;
}

/** Все вопросы сюжета: по ним проверяется распознавание, на кнопках — `callerChoices`. */
export function callerQuestions(
  input: CallerQuestionsInput,
): readonly CallerQuestion[] {
  const { book, street, house, flat } = input;
  // Вопросы сюжета — из его таблицы (callers/plots/), только о том, на что есть ответ.
  const facts = book.story.facts.filter(
    ({ fact }) => book.slot(`tell_${fact}`).length > 0,
  );
  const said = (h: string, f: string) =>
    `${street}, ${h}${f ? `, кв. ${f}` : ""}, верно?`;
  const right = said(house, flat);
  const readbacks = shuffle(
    flat
      ? [right, said(house, otherFlat(flat)), said(otherHouse(house), flat)]
      : [right, said(otherHouse(house), "")],
    input.seed,
  );
  return [
    { id: "intro", text: `Диспетчер ${input.serviceName}, по вашей заявке.` },
    ...facts.map(({ fact, ask }) => ({ id: fact, text: ask })),
    ...readbacks.map((text, index) => ({
      id: `readback:${index}`,
      text,
      correct: text === right,
    })),
    { id: "come", text: book.story.come },
    { id: "bye", text: "Спасибо, до свидания." },
  ];
}

/**
 * Вопросы на кнопках: то, что к месту сейчас, один-два сверх и прощание — не больше
 * `MAX_QUESTIONS` (решение 19.10: шестнадцать кнопок разом читать невозможно).
 *
 * К месту сейчас: представиться, пока не назвал службу; сведения, ради которых звонят
 * (`key` таблицы сюжета), пока нет полного ответа; адрес вслух — после того как заявитель
 * его назвал, и пока диспетчер не повторил (верный вариант и один с ошибкой); просьба
 * подойти, пока не попросил. Сверх — следующие сведения сюжета, о которых ещё не спрашивал:
 * разговор ведёт диспетчер, а не список. Голосом можно спросить любое сведение сюжета.
 */
export function callerChoices(
  input: CallerQuestionsInput & { readonly memory: CallerMemory },
): readonly CallerQuestion[] {
  const { book, memory } = input;
  const all = callerQuestions(input);
  const missing = missingComeFacts(book, memory);
  const key = new Set([
    ...book.story.facts.filter(({ key: own }) => own).map(({ fact }) => fact),
    ...missing,
  ]);
  const asked = (id: string) => memory.facts[id] !== undefined;
  // Адрес вслух: верный вариант и один с ошибкой — порядок как в полном списке, чтобы
  // верный не стоял всегда первым.
  const address = all.filter((item) => item.id.startsWith("readback:"));
  const readbacks = address.filter(
    (item) =>
      item.correct || item === address.find((other) => other.correct !== true),
  );
  const needed = [
    ...all.filter((item) => item.id === "intro" && !memory.service),
    ...all.filter(
      (item) => key.has(item.id) && memory.facts[item.id] !== "full",
    ),
    ...(asked("address") && !memory.readback ? readbacks : []),
    ...all.filter(
      (item) => item.id === "come" && !memory.came && missing.length === 0,
    ),
  ];
  const spare = all
    .filter(
      (item) =>
        !key.has(item.id) &&
        !asked(item.id) &&
        book.story.facts.some(({ fact }) => fact === item.id),
    )
    .slice(0, SPARE_QUESTIONS);
  return [
    ...[...needed, ...spare].slice(0, MAX_QUESTIONS - 1),
    ...all.filter((item) => item.id === "bye"),
  ];
}

/** Учебный следующий шаг: согласие заявителя не заменяет передачу сведений бригаде. */
export function callerGuidance(
  book: CallerBook,
  memory: CallerMemory,
): string | null {
  if (!book.story.comeRequires) return null;
  if (memory.came)
    return "Заявитель согласился подойти. Вернитесь к бригаде и передайте полученные сведения через «По частям».";
  const missing = missingComeFacts(book, memory);
  if (missing.length > 0)
    return `Сначала уточните: ${missing.map((fact) => book.story.facts.find((item) => item.fact === fact)?.ask ?? fact).join(" ")} Неполный ответ уточните повторным вопросом.`;
  return `Сведения получены. Теперь попросите заявителя подойти: «${book.story.come}»`;
}
