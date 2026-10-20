// Книга живого заявителя (HQ-019, docs/dds_caller.md): фразы банка CALLER_<характер>
// (scripts/voices/bank/callers, выборка web.py) одного сюжета. Один абонент — один голос:
// заявитель говорит только фразами своей книги, чужих голосов и Piper нет.
import { BANK_BOOKS, bankAudio, type BankPhrase } from "../bank";
import data from "../bankPhrases.json";
import {
  callerStory,
  type CallerPlotSource,
  type CallerStory,
} from "./hearing";

export type CallerCharacter = "calm" | "confused";

/** Книга банка на характер (scripts/voices/bank/callers). */
export const CALLER_BOOKS: Readonly<Record<CallerCharacter, string>> = {
  calm: "CALLER_CALM",
  confused: "CALLER_CONFUSED",
};

/**
 * Где заявитель во время разговора — подложка под звонком. Книги заявителя записаны с
 * подложкой «улица» (`scripts/voices/bank/port.py`, `bed`): хозяйка вышла в магазин у дома.
 */
export const CALLER_BACKGROUND = "street";

export interface CallerBook {
  /** Книга банка: `CALLER_CALM` или `CALLER_CONFUSED`. */
  readonly id: string;
  readonly character: CallerCharacter;
  /** Сюжет — ключ происшествия в книге (`incidents`), блок `caller.plot` сценария. */
  readonly plot: string;
  /** Таблица сюжета: вопросы диспетчера и как их узнать (callers/plots/<сюжет>.json). */
  readonly story: CallerStory;
  /** Фразы места разговора по порядку банка. */
  readonly slot: (slot: string) => readonly BankPhrase[];
}

/** Таблицы сюжетов заявителя (web.py: callers/plots/). */
export const CALLER_PLOTS = (
  data as unknown as { callerPlots: Record<string, CallerPlotSource> }
).callerPlots;

/**
 * Книга заявителя характера и сюжета; нет фраз или таблицы сюжета — `null` (разговор не
 * вести). Сюжет сценария без книги ловят линтер сценариев и web.py: сюжет — во всех книгах.
 */
export function callerBook(
  character: CallerCharacter,
  plot: string,
): CallerBook | null {
  const id = CALLER_BOOKS[character];
  const book = BANK_BOOKS[id];
  const source = CALLER_PLOTS[plot];
  if (!book || book.speaker !== "caller" || !source) return null;
  const ofPlot = (phrases: readonly BankPhrase[] | undefined) =>
    (phrases ?? []).filter(
      (phrase) => !phrase.only || phrase.only.split(",").includes(plot),
    );
  const slots = new Map(
    Object.entries(book.slots).map(([slot, phrases]) => [
      slot,
      ofPlot(phrases),
    ]),
  );
  if (![...slots.values()].some((phrases) => phrases.length > 0)) return null;
  return {
    id,
    character,
    plot,
    story: callerStory(source),
    slot: (slot) => slots.get(slot) ?? [],
  };
}

/** Сведения сюжета, которые даёт реплика (`tells`); неполный ответ (`on: first`) — ничего. */
export function factsOf(phrase: BankPhrase): readonly string[] {
  if (!phrase.tells || phrase.on === "first") return [];
  return phrase.tells.split(",");
}

/** Запись реплики заявителя; нет записи — реплика текстом, держится время чтения. */
export function callerAudio(phrase: BankPhrase): string | null {
  return bankAudio(phrase.id);
}
