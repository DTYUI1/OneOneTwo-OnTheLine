import { describe, expect, it } from "vitest";
import cases from "./conversation.cases.json";
import hearingCases from "./hearing.cases.json";
import {
  CALLER_BOOKS,
  CALLER_PLOTS,
  callerBook,
  type CallerCharacter,
} from "./book";
import {
  freshMemory,
  hungUp,
  pickUp,
  reply,
  silence,
  type CallerMemory,
  type CallerTurn,
} from "./conversation";
import { hear, numbersIn, type Ask, type Fact } from "./hearing";

// Правила заявителя общие с прогоном связности (apps/api/app/tools/coherence/caller.py): одни
// таблицы примеров — разговора и распознавания — проверяются здесь и в pytest
// (test_coherence_caller.py).

interface Step {
  readonly pickup?: boolean;
  readonly silence?: boolean;
  readonly hungup?: boolean;
  readonly say?: {
    readonly asks: readonly string[];
    readonly service: boolean;
    readonly reason: boolean;
    readonly yes: boolean;
  };
}

function ask(text: string): Ask {
  if (text.startsWith("readback:")) {
    const [, house, flat] = text.split(":");
    return { kind: "readback", house: house || null, flat: flat || null };
  }
  if (text === "come" || text === "bye" || text === "other" || text === "again")
    return { kind: text };
  return { kind: "fact", fact: text as Fact };
}

/** Реплики шагов примера: «место.номер» фразы, HANGUP — заявитель кладёт трубку. */
export function run(character: string, steps: readonly Step[]): string[][] {
  const book = callerBook(character as CallerCharacter, cases.plot);
  if (!book) throw new Error("нет книги заявителя");
  let memory: CallerMemory = freshMemory;
  const out: string[][] = [];
  for (const step of steps) {
    let turn: CallerTurn | null = null;
    if (step.pickup) turn = pickUp(book, memory);
    else if (step.silence) turn = silence(book, memory);
    else if (step.hungup !== undefined) memory = hungUp(memory, step.hungup);
    else if (step.say)
      turn = reply(
        book,
        memory,
        { ...step.say, asks: step.say.asks.map(ask) },
        cases.address,
      );
    if (!turn) {
      out.push([]);
      continue;
    }
    memory = turn.memory;
    const said = turn.lines.map((line) => {
      const [, slot, , n] = line.id.split(".");
      return `${slot}.${n}`;
    });
    out.push(turn.hangup ? [...said, "HANGUP"] : said);
  }
  return out;
}

describe("заявитель: примеры, общие с прогоном связности", () => {
  for (const item of cases.cases as {
    name: string;
    character: string;
    steps: Step[];
    expect?: string[][];
  }[])
    it(item.name, () => {
      expect(run(item.character, item.steps)).toEqual(item.expect);
    });
});

/** Вопрос, как его пишет таблица примеров: сведение, `readback:<дом>:<кв>`, come, bye… */
function askText(item: Ask): string {
  if (item.kind === "fact") return item.fact;
  if (item.kind === "readback")
    return `readback:${item.house ?? ""}:${item.flat ?? ""}`;
  return item.kind;
}

describe("заявитель: распознавание, общее с прогоном связности", () => {
  const book = callerBook("calm", hearingCases.plot);
  for (const item of hearingCases.cases as {
    text: string;
    asks: string[];
    service: boolean;
    reason: boolean;
    yes: boolean;
    numbers?: number[];
  }[])
    it(item.text || "(пусто)", () => {
      if (!book) throw new Error("нет книги заявителя");
      const heard = hear(item.text, book.story, hearingCases.street);
      expect({ ...heard, asks: heard.asks.map(askText) }).toEqual({
        asks: item.asks,
        service: item.service,
        reason: item.reason,
        yes: item.yes,
      });
      if (item.numbers)
        expect(numbersIn(item.text).map((n) => n.value)).toEqual(item.numbers);
    });
});

describe("заявитель: числительные — только целые слова (PR2-01)", () => {
  it.each([
    "дверь",
    "двери",
    "однако",
    "одинокий",
    "однокомнатная",
    "вторник",
    "трижды",
    "первенство",
    "четвертинка",
    "седьмица",
    "восьмерка",
  ])("«%s» — не номер дома или квартиры", (word) => {
    expect(numbersIn(word)).toEqual([]);
  });

  it("просьба открыть дверь на улице не превращается в чтение адреса", () => {
    const book = callerBook("calm", hearingCases.plot)!;
    const heard = hear(
      "Откройте дверь на улице",
      book.story,
      hearingCases.street,
    );
    expect(heard.asks).toContainEqual({ kind: "come" });
    expect(heard.asks.some((ask) => ask.kind === "readback")).toBe(false);
  });

  it.each([
    ["один одна одно первый первая первого", [1, 1, 1, 1, 1, 1]],
    ["два две второй вторую второго", [2, 2, 2, 2, 2]],
    ["три третий третья третью третьего", [3, 3, 3, 3, 3]],
    ["четыре четвертый четвертая четвертом", [4, 4, 4, 4]],
    ["семь седьмая восемь восьмой", [7, 7, 8, 8]],
    ["двадцать два пятьдесят восьмая", [22, 58]],
  ])("сохраняет числа и склонения: %s", (text, values) => {
    expect(numbersIn(text as string).map((item) => item.value)).toEqual(values);
  });
});

describe("заявитель: сюжеты", () => {
  for (const plot of Object.keys(CALLER_PLOTS))
    it(`${plot}: книга каждого характера, вопросы кнопок узнаются как задуманы`, () => {
      for (const character of Object.keys(CALLER_BOOKS) as CallerCharacter[]) {
        const book = callerBook(character, plot);
        // Без книги звонок заявителю ушёл бы дежурному службы (OFFICIAL).
        expect(book, `${character}: нет книги сюжета ${plot}`).not.toBeNull();
        if (!book) continue;
        for (const { fact, ask } of book.story.facts)
          expect(hear(ask, book.story).asks.map(askText), ask).toEqual([fact]);
        expect(hear(book.story.come, book.story).asks.map(askText)).toEqual([
          "come",
        ]);
      }
    });
});
