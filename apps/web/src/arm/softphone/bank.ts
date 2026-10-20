// Реплики окна телефона — фразы банка озвучки (GP-25, scripts/voices/bank/README.md): ответы
// бригады в разговоре и реплики должностного лица не пишутся в коде, а берутся из банка. Свой
// текст придумывать нельзя: нет фразы — её дописывает и озвучивает сессия озвучки.
// bankPhrases.json — выборка банка по местам разговора (scripts/voices/bank/web.py); записи этих
// фраз (GP-28) — ./bank/<id>.ogg, копии набора data/voices/bank-v1, уже «по телефону».

import data from "./bankPhrases.json";

/** Места разговора бригады, которые окно телефона говорит само (GP-11, TC-01). */
export type BrigadeSlot =
  | "answer"
  | "intro"
  | "no_reply"
  | "confirm_request"
  | "repeat_report"
  | "ack"
  | "not_understood"
  | "end_call"
  | "enroute"
  | "status_working"
  | "briefing_ask"
  | "refusal_busy"
  | "refusal_not_assigned"
  // Повтор адреса вводной — из scripts/voices/bank/addresses (текст присылает сервер).
  | "readback"
  // «Понял, ждём пожарных»: диспетчер сказал, что служба вызвана (GP-28).
  | "service_coming";

/** Места разговора должностного лица (TC-03). */
export type OfficialSlot =
  | "answer"
  | "accepted"
  | "registered"
  | "ask_who"
  | "ask_address"
  | "ask_what"
  | "ask_card"
  | "ask_victims"
  | "not_understood"
  | "end_call"
  // Звонок отдела контроля реагирования (TC-07).
  | "control_ask";

export interface BankPhrase {
  /** Постоянный ключ фразы: `<книга>.<место>.<происшествие или any>.<n>`. */
  readonly id: string;
  /** Что звучит дословно. */
  readonly text: string;
  /** Номер регистрации цифрами (место `registered`). */
  readonly number?: string;
  /** Чего не хватило во вводной (место `briefing_ask`): `address`, `what` или `both`. */
  readonly asks?: string;
  /** О какой службе фраза (место `service_coming`): `101` … `MOSLIFT`. */
  readonly needs?: string;
  /** Фраза только для этого происшествия (у дежурных — `s112`, оператор 112). */
  readonly only?: string;
  /**
   * Заявитель (HQ-019): у `tell_*` `first` — неполный ответ, `again` — ответ на уточнение; у
   * `repeat` — первый повтор и второй и дальше. Нет — фразы места взаимозаменяемы.
   */
  readonly on?: "first" | "again";
  /** Заявитель поправляет прочитанный адрес (`correct_address`): неверен дом или квартира. */
  readonly wrong?: "house" | "flat";
  /** Сведения сюжета в реплике заявителя через запятую (`plot_facts` книги). */
  readonly tells?: string;
}

interface Book {
  readonly speaker: "brigade" | "official" | "caller";
  readonly gender: "male" | "female";
  readonly character?: string;
  readonly slots: Readonly<Record<string, readonly BankPhrase[] | undefined>>;
}

// JSON выводится в литеральные типы; форму проверяет bank.test.ts по самому банку.
export const BANK_BOOKS = data.books as unknown as Readonly<
  Record<string, Book>
>;

/** Книга общего дежурного и оператора 112 (`OFFICIAL.json`). */
export const OFFICIAL = "OFFICIAL";
/** Служба без своей книги бригады отвечает голосом пожарного расчёта [ДОПУЩЕНИЕ]. */
const FALLBACK_SERVICE = "101";

const BY_ID = new Map(
  Object.values(BANK_BOOKS).flatMap((book) =>
    Object.values(book.slots).flatMap((phrases) =>
      (phrases ?? []).map((phrase) => [phrase.id, phrase] as const),
    ),
  ),
);

// Записи фраз выборки (GP-28): имя файла — ключ фразы.
const AUDIO = import.meta.glob<string>("./bank/*.ogg", {
  eager: true,
  query: "?url",
  import: "default",
});
const AUDIO_BY_ID = new Map(
  Object.entries(AUDIO).map(([path, url]) => [
    path.slice("./bank/".length, -".ogg".length),
    url,
  ]),
);

/** Запись фразы банка по ключу; записи нет — `null`, реплика остаётся текстом. */
export function bankAudio(id: string): string | null {
  return AUDIO_BY_ID.get(id) ?? null;
}

/**
 * Запись реплики по её тексту: ищется в книгах говорящего по порядку. Текст в книге уникален
 * (bank.py check), а в разных книгах может совпасть — поэтому книга говорящего первой.
 */
export function bankAudioForText(
  books: readonly string[],
  text: string,
): string | null {
  for (const book of books) {
    for (const phrases of Object.values(BANK_BOOKS[book]?.slots ?? {})) {
      const found = phrases?.find((phrase) => phrase.text === text);
      if (found) return bankAudio(found.id);
    }
  }
  return null;
}

/**
 * Записи реплики, склеенной из нескольких фраз (вопросы дежурного подряд, «Повторяю» и доклад):
 * по порядку, фразы книг говорящего и `known` — тексты со своей записью (доклад бригады).
 * Хоть один кусок без записи — `null`: чужим голосом пробел не закрывается.
 */
export function bankAudiosForText(
  books: readonly string[],
  text: string,
  known: ReadonlyMap<string, string> = new Map(),
): readonly string[] | null {
  const texts: { text: string; url: string }[] = [];
  for (const book of books)
    for (const phrases of Object.values(BANK_BOOKS[book]?.slots ?? {}))
      for (const phrase of phrases ?? []) {
        const url = bankAudio(phrase.id);
        if (url) texts.push({ text: phrase.text, url });
      }
  for (const [knownText, url] of known) texts.push({ text: knownText, url });
  const urls: string[] = [];
  let rest = text.trim();
  while (rest) {
    const next = texts
      .filter((item) => rest.startsWith(item.text))
      .sort((a, b) => b.text.length - a.text.length)[0];
    if (!next) return null;
    urls.push(next.url);
    rest = rest.slice(next.text.length).trim();
  }
  return urls.length ? urls : null;
}

/** Фраза выборки по постоянному ключу; нет такой — `null`. */
export function bankPhrase(id: string): BankPhrase | null {
  return BY_ID.get(id) ?? null;
}

/** Фраза банка по постоянному ключу; нет такой — ошибка сборки выборки, а не тихий текст. */
export function bankText(id: string): string {
  const phrase = BY_ID.get(id);
  if (!phrase) throw new Error(`Нет фразы банка ${id}`);
  return phrase.text;
}

/** Фразы места разговора в книге; фразы только для 112 — только книге 112. */
export function bankPhrases(book: string, slot: string): readonly BankPhrase[] {
  return BANK_BOOKS[book]?.slots[slot] ?? [];
}

function pick(phrases: readonly BankPhrase[], turn: number): string {
  const phrase =
    phrases[Math.abs(Math.trunc(turn)) % Math.max(1, phrases.length)];
  if (!phrase) throw new Error("Нет фраз банка для этого места");
  return phrase.text;
}

/**
 * Что говорит бригада службы на месте разговора. Бригады — службы обучаемого (101 … MOSLIFT);
 * у 103 голос женский, и фразы банка уже в её роде. `turn` перебирает фразы места, чтобы
 * одна и та же не звучала подряд.
 */
export function brigadePhrase(
  service: string | null | undefined,
  slot: BrigadeSlot,
  turn = 0,
): string {
  return pick(brigadePhrases(service, slot), turn);
}

/** Все фразы бригады службы на месте разговора — для выбора по смыслу. */
export function brigadePhrases(
  service: string | null | undefined,
  slot: BrigadeSlot,
): readonly BankPhrase[] {
  const book =
    service && BANK_BOOKS[service]?.speaker === "brigade"
      ? service
      : FALLBACK_SERVICE;
  return bankPhrases(book, slot);
}

/** Реплика общего дежурного службы (`OFFICIAL.json`), без фраз только для 112. */
export function officialPhrase(slot: OfficialSlot, turn = 0): string {
  return pick(
    bankPhrases(OFFICIAL, slot).filter((phrase) => !phrase.only),
    turn,
  );
}
