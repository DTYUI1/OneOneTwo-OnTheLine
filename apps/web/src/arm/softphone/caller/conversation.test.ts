import { describe, expect, it } from "vitest";
import { callerBook, factsOf, type CallerBook } from "./book";
import {
  freshMemory,
  hungUp,
  pickUp,
  reply,
  silence,
  type CallerMemory,
} from "./conversation";
import { hear as hearWith } from "./hearing";
import { callerChoices, callerQuestions, MAX_QUESTIONS } from "./questions";

// HQ-019, проверяемые критерии docs/dds_caller.md, раздел 6 — на книгах банка заявителя.
const ADDRESS = { house: "22", flat: "58" };
const STREET = "Кировоградская улица";

function book(character: "calm" | "confused"): CallerBook {
  const found = callerBook(character, "animal_shaft");
  if (!found) throw new Error("нет книги заявителя");
  return found;
}

/** Разговор: снял трубку, затем фразы диспетчера по порядку; id реплик каждого ответа. */
function talk(
  character: "calm" | "confused",
  phrases: readonly string[],
  start: CallerMemory = freshMemory,
): { said: string[][]; memory: CallerMemory } {
  const caller = book(character);
  let { memory } = pickUp(caller, start);
  const said: string[][] = [];
  for (const text of phrases) {
    const turn = reply(caller, memory, hear(text, STREET), ADDRESS);
    said.push(turn.lines.map((line) => line.id.split(".")[1]!));
    memory = turn.memory;
  }
  return { said, memory };
}

const INTRO = "Диспетчер ЖКХ, по вашей заявке о котёнке.";
const STORY = book("calm").story;
const hear = (text: string, street = "") => hearWith(text, STORY, street);

describe("заявитель: варианты по частям", () => {
  it.each(["", "58"])(
    "адрес с квартирой «%s» перемешан детерминированно (PR2-09)",
    (flat) => {
      const input = {
        book: book("calm"),
        serviceName: "ЖКХ",
        street: STREET,
        house: "22",
        flat,
      };
      const orders = Array.from({ length: 20 }, (_, i) => {
        const seed = `call-${i}`;
        const questions = callerQuestions({ ...input, seed });
        expect(callerQuestions({ ...input, seed })).toEqual(questions);
        const readbacks = questions.filter((q) => q.id.startsWith("readback:"));
        expect(readbacks).toHaveLength(flat ? 3 : 2);
        expect(new Set(readbacks.map((q) => q.text)).size).toBe(
          readbacks.length,
        );
        const correct = `${STREET}, 22${flat ? `, кв. ${flat}` : ""}, верно?`;
        return readbacks.findIndex((q) => q.text === correct);
      });
      expect(orders).not.toContain(-1);
      expect(new Set(orders).size).toBeGreaterThan(1);
    },
  );

  // Примеры распознавания — в hearing.cases.json (общие с прогоном связности, cases.test.ts).
  it("каждый вариант по частям понят как задуман", () => {
    const caller = book("calm");
    const options = callerQuestions({
      book: caller,
      serviceName: "ЖКХ",
      street: STREET,
      house: "22",
      flat: "58",
      seed: "call",
    });
    for (const option of options) {
      const heard = hear(option.text, STREET);
      if (option.id === "intro") {
        expect(heard.service && heard.reason && heard.asks.length === 0).toBe(
          true,
        );
        continue;
      }
      expect(heard.asks, option.text).toHaveLength(1);
      const [ask] = heard.asks;
      if (option.id.startsWith("readback:")) expect(ask?.kind).toBe("readback");
      else if (option.id === "come" || option.id === "bye")
        expect(ask?.kind).toBe(option.id);
      else expect(ask).toEqual({ kind: "fact", fact: option.id });
    }
    // Адрес вслух: верный и с ошибкой в квартире и в доме — как у части вводной «адрес».
    expect(
      options
        .filter((o) => o.id.startsWith("readback:"))
        .map((o) => o.text)
        .sort(),
    ).toEqual([
      "Кировоградская улица, 2, кв. 58, верно?",
      "Кировоградская улица, 22, кв. 58, верно?",
      "Кировоградская улица, 22, кв. 85, верно?",
    ]);
  });
});

describe("заявитель: короткий список кнопок", () => {
  const input = {
    book: book("calm"),
    serviceName: "ЖКХ",
    street: STREET,
    house: "22",
    flat: "58",
    seed: "call",
  };
  const ids = (memory: CallerMemory) =>
    callerChoices({ ...input, memory }).map((item) => item.id);

  it("в начале разговора — представиться, что нужно по делу и пара вопросов сверх", () => {
    const start = ids(freshMemory);
    expect(start.length).toBeLessThanOrEqual(MAX_QUESTIONS);
    // Ключевые сведения сюжета (где она, когда подойдёт) и просьба подойти — всегда здесь.
    expect(start).toContain("intro");
    expect(start).toContain("where");
    expect(start).toContain("eta");
    expect(start).toContain("come");
    expect(start.at(-1)).toBe("bye");
    // Шестнадцати кнопок больше нет: не ключевые сведения — по одному-двум.
    expect(
      start.filter((id) => ["who", "what", "since", "box"].includes(id)),
    ).not.toHaveLength(0);
    expect(ids(freshMemory)).toEqual(start);
  });

  it("ответы и сказанное убирают вопрос из списка", () => {
    const { memory } = talk("calm", [
      `${INTRO} Где вы сейчас?`,
      "Когда вы подойдёте?",
      "Подойдите, пожалуйста, бригада ждёт у двери.",
    ]);
    const after = ids(memory);
    // Представился, срок выяснил, подойти попросил — об этом больше не спрашиваем.
    expect(after).not.toContain("intro");
    expect(after).not.toContain("where");
    expect(after).not.toContain("eta");
    expect(after).not.toContain("come");
    expect(after.at(-1)).toBe("bye");
    expect(after.length).toBeLessThanOrEqual(MAX_QUESTIONS);
  });

  it("адрес вслух — после того как заявитель его назвал, и только два варианта", () => {
    expect(ids(freshMemory).filter((id) => id.startsWith("readback:"))).toEqual(
      [],
    );
    const { memory } = talk("calm", [`${INTRO} Назовите адрес.`]);
    const shown = callerChoices({ ...input, memory }).filter((item) =>
      item.id.startsWith("readback:"),
    );
    expect(shown).toHaveLength(2);
    // Верный вариант — всегда один из двух: иначе прочитать адрес правильно нечем.
    expect(shown.filter((item) => item.correct)).toHaveLength(1);
    expect(shown.find((item) => item.correct)?.text).toBe(
      "Кировоградская улица, 22, кв. 58, верно?",
    );
    // Повторил адрес — вариантов больше нет.
    const after = talk(
      "calm",
      ["Кировоградская улица, 22, кв. 58, верно?"],
      memory,
    );
    expect(
      ids(after.memory).filter((id) => id.startsWith("readback:")),
    ).toEqual([]);
  });

  it("все вопросы сюжета остаются распознаваемыми голосом", () => {
    // `callerQuestions` — полный список: его проверяет разбор фраз выше.
    expect(callerQuestions(input).length).toBeGreaterThan(MAX_QUESTIONS);
  });
});

describe("заявитель: книги", () => {
  it("сюжета нет в книгах — живого заявителя нет", () => {
    expect(callerBook("calm", "no_such_plot")).toBeNull();
  });
});

describe("заявитель: спокойная", () => {
  it("снимает трубку своей репликой, на вопрос — полный ответ с первого раза", () => {
    const caller = book("calm");
    expect(pickUp(caller, freshMemory).lines[0]?.id).toContain(".answer.");
    const { said } = talk("calm", [
      `${INTRO} Где вы сейчас?`,
      "Когда вы подойдёте?",
      "Можно вскрыть вентиляционный короб?",
      "Есть запах газа или дым?",
      "Чей котёнок?",
      "Какая у вас погода?",
    ]);
    expect(said).toEqual([
      ["tell_where"],
      ["tell_eta"],
      ["tell_box"],
      ["tell_danger"],
      ["tell_owner"],
      ["unknown"],
    ]);
  });

  it("без службы — один раз «А кто это звонит?», потом отвечает на отложенный вопрос", () => {
    const { said } = talk("calm", [
      "Где вы сейчас?",
      "Диспетчер ЖКХ.",
      "Когда подойдёте?",
    ]);
    expect(said).toEqual([["ask_who"], ["tell_where"], ["tell_eta"]]);
  });

  it("повтор вопроса — «Повторю ещё раз» и тот же ответ", () => {
    const { said } = talk("calm", [
      INTRO,
      "Когда вы подойдёте?",
      "Когда вы подойдёте?",
    ]);
    expect(said).toEqual([[], ["tell_eta"], ["repeat", "tell_eta"]]);
  });

  it("адрес вслух: верный — подтверждение, с ошибкой — поправка дома или квартиры", () => {
    const caller = book("calm");
    const { said } = talk("calm", [
      INTRO,
      "Кировоградская, 22, кв. 58, верно?",
      "Кировоградская, 22, кв. 85, верно?",
      "Кировоградская, 2, кв. 58, верно?",
      "Кировоградская, 2, кв. 85?",
    ]);
    expect(said).toEqual([
      [],
      ["confirm_address"],
      ["correct_address"],
      ["correct_address"],
      ["correct_address"],
    ]);
    let memory = pickUp(caller, freshMemory).memory;
    const wrongs = [
      "Кировоградская, 22, кв. 85",
      "Кировоградская, 2, кв. 58",
      "дом 2, квартира 85",
    ].map((text) => {
      const turn = reply(
        caller,
        memory,
        hear(`${INTRO} ${text}`, STREET),
        ADDRESS,
      );
      memory = turn.memory;
      return turn.lines[0]?.wrong;
    });
    expect(wrongs).toEqual(["flat", "house", "house"]);
  });

  it("просьба подойти — согласие, прощание — конец звонка", () => {
    const caller = book("calm");
    const memory = pickUp(caller, freshMemory).memory;
    const come = reply(
      caller,
      memory,
      hear(`${INTRO} Подойдите, пожалуйста, бригада ждёт у двери.`),
      ADDRESS,
    );
    expect(come.lines.map((line) => line.id)).toEqual([
      expect.stringContaining(".agree."),
    ]);
    const bye = reply(
      caller,
      come.memory,
      hear("Спасибо, до свидания."),
      ADDRESS,
    );
    expect(bye.lines[0]?.id).toContain(".end_call.");
    expect(bye.hangup).toBe(true);
  });
});

describe("заявитель: растерянная", () => {
  it("переспрашивает, кто звонит, пока не назовут службу и повод", () => {
    const { said } = talk("confused", [
      "Где вы сейчас?",
      "Это насчёт котёнка.",
      "Да",
      "Когда подойдёте?",
    ]);
    // Повод без службы — «Это из аварийной, что ли? Насчёт котёнка?»; «Да» — отвечает.
    expect(said[0]).toEqual(["ask_who"]);
    expect(said[1]).toEqual(["ask_who"]);
    expect(said[2]).toEqual(["tell_where"]);
    expect(said[3]).toEqual(["tell_eta"]);
  });

  it("на адрес, опасность, срок и короб — сначала неполно, полностью на уточнение", () => {
    const caller = book("confused");
    let memory = pickUp(caller, freshMemory).memory;
    memory = reply(caller, memory, hear(INTRO), ADDRESS).memory;
    for (const question of [
      "Назовите адрес",
      "Есть запах газа?",
      "Когда подойдёте?",
      "Можно вскрыть короб?",
    ]) {
      const first = reply(caller, memory, hear(question, STREET), ADDRESS);
      expect(first.lines.map((line) => line.on)).toEqual(["first"]);
      expect(first.lines.flatMap(factsOf)).toEqual([]);
      const again = reply(
        caller,
        first.memory,
        hear(question, STREET),
        ADDRESS,
      );
      expect(again.lines.map((line) => line.on)).toEqual(["again"]);
      expect(again.lines.flatMap(factsOf)).toHaveLength(1);
      memory = again.memory;
    }
  });

  it("повтор после полного ответа: первый «Я же говорила…», дальше «Опять?»", () => {
    const caller = book("confused");
    const { said, memory } = talk("confused", [INTRO, "Где вы?", "Где вы?"]);
    expect(said.slice(1)).toEqual([["tell_where"], ["repeat", "tell_where"]]);
    const third = reply(caller, memory, hear("Где вы?"), ADDRESS);
    expect(third.lines.map((line) => [line.id.split(".")[1], line.on])).toEqual(
      [
        ["repeat", "again"],
        ["tell_where", undefined],
      ],
    );
  });

  it("из двух вопросов фразы отвечает только на первый", () => {
    const { said } = talk("confused", [`${INTRO} Где вы, и чей котёнок?`]);
    expect(said).toEqual([["tell_where"]]);
  });
});

describe("заявитель: тишина и перезвон", () => {
  it("«Алло, вы тут?» дважды, на третьей паузе — отбой; фраза диспетчера обнуляет счёт", () => {
    const caller = book("calm");
    let memory = pickUp(caller, freshMemory).memory;
    const first = silence(caller, memory);
    expect(first.lines[0]?.id).toContain(".no_reply.");
    expect(first.hangup).toBe(false);
    // Диспетчер заговорил — счёт заново.
    memory = reply(caller, first.memory, hear(INTRO), ADDRESS).memory;
    const again = silence(caller, memory);
    expect(again.lines[0]?.id).toBe(first.lines[0]?.id);
    const second = silence(caller, again.memory);
    expect(second.lines[0]?.id).not.toBe(first.lines[0]?.id);
    const third = silence(caller, second.memory);
    expect(third.lines[0]?.id).toContain(".hangup.");
    expect(third.hangup).toBe(true);
    // Перезвон после отбоя — «это опять вы?», уже сказанное помнит.
    const back = pickUp(caller, hungUp(third.memory, false));
    expect(back.lines[0]?.id).toContain(".answer_again.");
  });

  it("перезвон после прощания — обычное «Алло», повторы помнит", () => {
    const caller = book("confused");
    const { memory } = talk("confused", [INTRO, "Где вы?"]);
    const back = pickUp(caller, hungUp(memory, true));
    expect(back.lines[0]?.id).toContain(".answer.");
    const turn = reply(caller, back.memory, hear("Где вы?"), ADDRESS);
    expect(turn.lines[0]?.id).toContain(".repeat.");
  });
});
