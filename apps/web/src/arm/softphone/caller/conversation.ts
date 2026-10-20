// Разговор с живым заявителем (HQ-019, docs/dds_caller.md, разделы 2–3): что заявитель
// отвечает на фразу диспетчера и на его молчание. Чистые функции без React, звука и таймеров:
// окно телефона подставляет книгу, услышанное и время, исполняет ответ (реплики, отбой).
//
// Память — на разговор с карточкой, а не на звонок: перезвонив, диспетчер говорит с тем же
// человеком, который помнит, что уже сказал (повторы считаются по всему разговору).
import type { BankPhrase } from "../bank";
import type { CallerBook } from "./book";
import type { Ask, Fact, Heard } from "./hearing";

/** Тишина диспетчера после реплики заявителя, после которой он переспрашивает (раздел 3). */
export const NO_REPLY_MS = 8000;
/** Какая по счёту пауза подряд кончается отбоем заявителя. */
export const HANGUP_PAUSE = 3;
/** Спокойная отвечает на все вопросы фразы, но не больше стольких подряд. */
const MAX_ANSWERS = 3;

export interface CallerMemory {
  /** Что заявитель уже сказал о сведении: неполно (`first`) или полностью (`full`). */
  readonly facts: Readonly<Partial<Record<Fact, "first" | "full">>>;
  /** Сколько раз повторяла уже сказанное (у растерянной первый повтор и следующие разные). */
  readonly repeats: number;
  /** Диспетчер называл службу и повод (за весь разговор). */
  readonly service: boolean;
  readonly reason: boolean;
  /** Сколько раз переспросила, кто звонит. */
  readonly askedWho: number;
  /** Вопросы, на которые не ответила, пока не узнала, кто звонит. */
  readonly pending: readonly Ask[];
  /** Пауз диспетчера подряд в идущем звонке. */
  readonly silence: number;
  /** Отвеченных звонков с этой карточкой. */
  readonly calls: number;
  /** Прошлый звонок оборвался без прощания: на перезвон — «это опять вы?». */
  readonly dropped: boolean;
  /** Счётчик для перебора взаимозаменяемых фраз места. */
  readonly turn: number;
  /** Последняя реплика — на «повторите». */
  readonly last: readonly BankPhrase[];
  /** Диспетчер прочитал адрес вслух (верно или с ошибкой) — переспрашивать его незачем. */
  readonly readback: boolean;
  /** Заявитель согласился подойти после требуемых полных сведений. */
  readonly came: boolean;
}

export const freshMemory: CallerMemory = {
  facts: {},
  repeats: 0,
  service: false,
  reason: false,
  askedWho: 0,
  pending: [],
  silence: 0,
  calls: 0,
  dropped: false,
  turn: 0,
  last: [],
  readback: false,
  came: false,
};

export interface CallerTurn {
  readonly memory: CallerMemory;
  /** Реплики заявителя по порядку; пусто — молчит, ждёт вопроса. */
  readonly lines: readonly BankPhrase[];
  /** Заявитель кладёт трубку, договорив. */
  readonly hangup: boolean;
}

/** Адрес карточки — с ним заявитель сверяет адрес, прочитанный диспетчером. */
export interface CallerAddress {
  readonly house: string;
  readonly flat: string;
}

function pick(
  phrases: readonly BankPhrase[],
  memory: CallerMemory,
): BankPhrase | null {
  if (phrases.length === 0) return null;
  // Взаимозаменяемые фразы по кругу: одна и та же подряд не звучит.
  const last = memory.last[memory.last.length - 1]?.id;
  for (let shift = 0; shift < phrases.length; shift += 1) {
    const phrase = phrases[(memory.turn + shift) % phrases.length]!;
    if (phrase.id !== last || phrases.length === 1) return phrase;
  }
  return phrases[0]!;
}

function staged(phrases: readonly BankPhrase[], on: "first" | "again") {
  return phrases.filter((phrase) => phrase.on === on);
}

/** Снял трубку: «Алло, слушаю» или, если прошлый разговор оборвался, «это опять вы?». */
export function pickUp(book: CallerBook, memory: CallerMemory): CallerTurn {
  const again = memory.calls > 0 && memory.dropped;
  const phrase = pick(book.slot(again ? "answer_again" : "answer"), memory);
  const lines = phrase ? [phrase] : [];
  return {
    memory: {
      ...memory,
      calls: memory.calls + 1,
      silence: 0,
      dropped: false,
      turn: memory.turn + 1,
      last: lines,
    },
    lines,
    hangup: false,
  };
}

/** Снят с удержания: снова «Да, алло» — тот же звонок, без «это опять вы?». */
export function backOnLine(book: CallerBook, memory: CallerMemory): CallerTurn {
  const phrase = pick(book.slot("answer"), memory);
  const lines = phrase ? [phrase] : [];
  return {
    memory: { ...memory, silence: 0, turn: memory.turn + 1, last: lines },
    lines,
    hangup: false,
  };
}

/** Звонок кончился: без прощания — следующий звонок начнётся с «это опять вы?». */
export function hungUp(memory: CallerMemory, farewell: boolean): CallerMemory {
  return { ...memory, silence: 0, dropped: !farewell };
}

/**
 * Пауза диспетчера `NO_REPLY_MS` после реплики заявителя: первая и вторая подряд —
 * «Алло, вы тут?» (`no_reply` по порядку книги), третья — `hangup` и отбой.
 */
export function silence(book: CallerBook, memory: CallerMemory): CallerTurn {
  const streak = memory.silence + 1;
  if (streak >= HANGUP_PAUSE) {
    const phrase = pick(book.slot("hangup"), memory);
    const lines = phrase ? [phrase] : [];
    return {
      memory: { ...memory, silence: 0, dropped: true, last: lines },
      lines,
      hangup: true,
    };
  }
  const asks = book.slot("no_reply");
  const phrase = asks[Math.min(streak, asks.length) - 1] ?? null;
  const lines = phrase ? [phrase] : [];
  return {
    memory: { ...memory, silence: streak, last: lines },
    lines,
    hangup: false,
  };
}

/** Ответ на сведение: полный сразу, у растерянной на часть — сначала неполный. */
function tell(
  book: CallerBook,
  memory: CallerMemory,
  fact: Fact,
): { lines: BankPhrase[]; memory: CallerMemory } {
  const phrases = book.slot(`tell_${fact}`);
  const first = staged(phrases, "first");
  const again = staged(phrases, "again");
  const full = again.length > 0 ? again : phrases.filter((p) => !p.on);
  const said = memory.facts[fact];
  if (said === undefined && first.length > 0) {
    const phrase = pick(first, memory);
    return {
      lines: phrase ? [phrase] : [],
      memory: { ...memory, facts: { ...memory.facts, [fact]: "first" } },
    };
  }
  const answer = pick(full, memory);
  const lines: BankPhrase[] = [];
  let next = memory;
  // Уже ответила полностью — это повтор вопроса; после неполного — уточнение, без упрёка.
  if (said === "full") {
    const repeats = book.slot("repeat");
    const ordered =
      staged(repeats, "first").length > 0
        ? staged(repeats, memory.repeats === 0 ? "first" : "again")
        : repeats;
    const repeat = pick(ordered, memory);
    if (repeat) lines.push(repeat);
    next = { ...next, repeats: memory.repeats + 1 };
  }
  if (answer) lines.push(answer);
  return {
    lines,
    memory: { ...next, facts: { ...next.facts, [fact]: "full" } },
  };
}

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

/** Адрес, прочитанный вслух: верный — подтверждает, с ошибкой — поправляет (дом важнее). */
function readback(
  book: CallerBook,
  memory: CallerMemory,
  ask: Extract<Ask, { kind: "readback" }>,
  address: CallerAddress,
): BankPhrase | null {
  const wrongHouse =
    ask.house !== null && digits(ask.house) !== digits(address.house);
  const wrongFlat =
    ask.flat !== null && digits(ask.flat) !== digits(address.flat);
  const wrong = wrongHouse ? "house" : wrongFlat ? "flat" : null;
  if (wrong === null) return pick(book.slot("confirm_address"), memory);
  return (
    book.slot("correct_address").find((phrase) => phrase.wrong === wrong) ??
    pick(book.slot("correct_address"), memory)
  );
}

/** Полные сведения, без которых нельзя обещать встречу с бригадой. */
export function missingComeFacts(
  book: CallerBook,
  memory: CallerMemory,
): readonly Fact[] {
  return (book.story.comeRequires ?? []).filter(
    (fact) => memory.facts[fact] !== "full",
  );
}

function answer(
  book: CallerBook,
  memory: CallerMemory,
  ask: Ask,
  address: CallerAddress,
): { lines: BankPhrase[]; memory: CallerMemory; hangup?: boolean } {
  const one = (phrase: BankPhrase | null) => ({
    lines: phrase ? [phrase] : [],
    memory,
  });
  switch (ask.kind) {
    case "fact":
      return tell(book, memory, ask.fact);
    case "readback": {
      const phrase = readback(book, memory, ask, address);
      return {
        lines: phrase ? [phrase] : [],
        memory: {
          ...memory,
          readback: true,
          facts: { ...memory.facts, address: "full" },
        },
      };
    }
    case "come":
      if (missingComeFacts(book, memory).length > 0) return one(null);
      return {
        ...one(pick(book.slot("agree"), memory)),
        memory: { ...memory, came: true },
      };
    case "bye":
      if (book.story.comeRequires && !memory.came)
        return { ...one(null), hangup: true };
      return { ...one(pick(book.slot("end_call"), memory)), hangup: true };
    case "other":
      return one(pick(book.slot("unknown"), memory));
    case "again":
      return { lines: [...memory.last], memory };
  }
}

/** Кто звонит: растерянная — пока не узнает службу и повод, спокойная — один раз. */
function asksWho(
  book: CallerBook,
  memory: CallerMemory,
  heard: Heard,
): BankPhrase | null {
  const service = memory.service || heard.service;
  const reason = memory.reason || heard.reason;
  const known = book.character === "confused" ? service && reason : service;
  if (known) return null;
  if (book.character === "calm" && memory.askedWho > 0) return null;
  const phrases = book.slot("ask_who");
  // Растерянная: услышала повод без службы — догадка «Это из аварийной, что ли? Насчёт …?»
  // (вторая фраза места), иначе «Кто это? Откуда звоните?» (первая; поле `when` книги).
  if (reason && !service && phrases.length > 1) return phrases[1]!;
  return phrases[0] ?? null;
}

/** Что заявитель отвечает на фразу диспетчера. */
export function reply(
  book: CallerBook,
  memory: CallerMemory,
  heard: Heard,
  address: CallerAddress,
): CallerTurn {
  // «Да» на догадку (вторая фраза `ask_who`) — служба и повод названы.
  const guess = book.slot("ask_who")[1]?.id;
  const guessed =
    heard.yes && memory.last.some((phrase) => phrase.id === guess);
  let next: CallerMemory = {
    ...memory,
    silence: 0,
    service: memory.service || heard.service || guessed,
    reason: memory.reason || heard.reason || guessed,
  };
  const who = asksWho(book, memory, {
    ...heard,
    service: next.service,
    reason: next.reason,
  });
  if (who) {
    const lines = [who];
    return {
      memory: {
        ...next,
        askedWho: next.askedWho + 1,
        pending: [
          ...next.pending,
          ...heard.asks.filter((ask) => ask.kind !== "again"),
        ],
        turn: next.turn + 1,
        last: lines,
      },
      lines,
      hangup: false,
    };
  }
  const asks = [...next.pending, ...heard.asks];
  next = { ...next, pending: [] };
  if (asks.length === 0) {
    // Представился и ничего не спросил — ждёт вопроса; «да» без вопроса — тоже.
    if (heard.service || heard.reason || heard.yes)
      return { memory: next, lines: [], hangup: false };
    const phrase = pick(book.slot("not_understood"), next);
    const lines = phrase ? [phrase] : [];
    return {
      memory: { ...next, turn: next.turn + 1, last: lines },
      lines,
      hangup: false,
    };
  }
  // Растерянная из двух вопросов в одной фразе отвечает только на первый.
  const taken =
    book.character === "confused"
      ? asks.slice(0, 1)
      : asks.slice(0, MAX_ANSWERS);
  const lines: BankPhrase[] = [];
  let hangup = false;
  for (const ask of taken) {
    const step = answer(book, next, ask, address);
    lines.push(...step.lines);
    next = { ...step.memory, turn: step.memory.turn + 1 };
    if (step.hangup) {
      hangup = true;
      break;
    }
  }
  return {
    memory: { ...next, last: lines.length > 0 ? lines : next.last },
    lines,
    hangup,
  };
}
