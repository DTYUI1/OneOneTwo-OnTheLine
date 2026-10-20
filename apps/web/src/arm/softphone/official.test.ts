import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import copy from "./confusableStreets.json";
import { BANK_BOOKS, bankPhrases, OFFICIAL } from "./bank";
import {
  answerLine,
  askCandidates,
  askLine,
  personaBook,
  registeredLine,
  spelled,
  spellLine,
  spellStep,
  streetKey,
  twinStreet,
  wantsRepeat,
} from "./official";
import { advanceLog, quickPhrases, type CallSnapshot } from "./callLog";
import {
  CLARIFY,
  clarifyFor,
  type AddressGap,
  type ReportAsk,
  type ReportPart,
} from "./report";

// TC-03: должностное лицо службы отвечает правдоподобно — фразами банка, без своих текстов.

const SERVICES = ["101", "102", "103", "104"] as const;
const texts = (book: string, slot: Parameters<typeof bankPhrases>[1]) =>
  bankPhrases(book, slot).map((phrase) => phrase.text);

describe("похожие улицы", () => {
  it("копия в бандле совпадает с data/confusable_streets.json", () => {
    const source = JSON.parse(
      readFileSync(
        join(process.cwd(), "../../data/confusable_streets.json"),
        "utf8",
      ),
    );
    expect(copy).toEqual(source);
  });

  it("улица карточки находит пару в любой записи", () => {
    expect(twinStreet("Дубнинская улица")).toBe("Дубининская улица");
    expect(twinStreet("ул. Дубининская")).toBe("Дубнинская улица");
    expect(twinStreet("Ленинградский пр-т")).toBe("Ленинский проспект");
    expect(twinStreet("Смоленская площадь")).toBeNull();
    expect(twinStreet("Профсоюзная улица")).toBeNull();
    expect(twinStreet("")).toBeNull();
    expect(streetKey("улица Дубнинская")).toEqual({
      name: "дубнинская",
      kind: "улица",
    });
  });

  it("по буквам — улица карточки и похожая, верная не первая всегда", () => {
    expect(spelled("Дубнинская улица")).toBe("Д-у-б-н-и-н-с-к-а-я");
    const step = spellStep("Дубнинская улица", "Дубининская улица", "call-1");
    expect(step.label).toBe("Улица по буквам");
    expect(step.options).toHaveLength(2);
    expect(step.options.filter((option) => option.correct)).toEqual([
      { text: "Д-у-б-н-и-н-с-к-а-я", correct: true },
    ]);
    const first = new Set(
      ["a", "b", "c", "d", "e", "f"].map(
        (seed) =>
          spellStep("Дубнинская улица", "Дубининская улица", seed).options[0]
            ?.correct,
      ),
    );
    expect(first).toEqual(new Set([true, false]));
  });

  it("просит по буквам дежурный службы; у общего такой фразы в банке нет", () => {
    for (const service of SERVICES) {
      const book = personaBook(service)!;
      expect(texts(book, "ask_address")).toContain(spellLine(book));
      expect(spellLine(book)).toMatch(/по буквам/);
    }
    expect(spellLine(OFFICIAL)).toBeNull();
  });
});

describe("дежурный службы — постоянный персонаж", () => {
  it("книга персонажа — только у служб 101–104", () => {
    expect(SERVICES.map(personaBook)).toEqual([
      "OFFICIAL_101",
      "OFFICIAL_102",
      "OFFICIAL_103",
      "OFFICIAL_104",
    ]);
    expect(personaBook("112")).toBeNull();
    expect(personaBook("401")).toBeNull();
    expect(personaBook(null)).toBeNull();
  });

  it("представляется и называет номер — фразы банка, по звонку одни и те же", () => {
    for (const service of SERVICES) {
      const book = personaBook(service)!;
      expect(texts(book, "answer")).toContain(answerLine(book, "call-1"));
      expect(answerLine(book, "call-1")).toBe(answerLine(book, "call-1"));
      const line = registeredLine(book, "call-1");
      const phrase = bankPhrases(book, "registered").find(
        (item) => item.text === line.text,
      );
      expect(phrase?.number).toBe(line.number);
      expect(line.number).toMatch(/^\d+$/);
    }
    const numbers = new Set(
      Array.from(
        { length: 20 },
        (_, index) => registeredLine("OFFICIAL_102", `call-${index}`).number,
      ),
    );
    expect(numbers.size).toBeGreaterThan(1);
  });

  it("представляется по фамилии хотя бы в одной фразе ответа", () => {
    expect(texts("OFFICIAL_102", "answer").join(" ")).toMatch(/Медведев/);
  });
});

describe("вопросы дежурного", () => {
  it("общий дежурный сначала спрашивает прежними фразами (GP-25)", () => {
    expect(askLine(OFFICIAL, ["who", "card", "change"], 0, null)).toBe(
      CLARIFY.no_address,
    );
    expect(askLine(OFFICIAL, [], 0, null)).toBe(clarifyFor([]));
    expect(
      askLine(OFFICIAL, ["who", "address", "card", "change"], 0, null),
    ).toBeNull();
  });

  it("одна и та же фраза подряд не звучит", () => {
    for (const book of [OFFICIAL, ...SERVICES.map((s) => personaBook(s)!)]) {
      let previous: string | null = null;
      for (let turn = 0; turn < 6; turn += 1) {
        const question = askLine(
          book,
          ["who", "card", "change"],
          turn,
          previous,
        );
        expect(question, `${book}, вопрос ${turn}`).not.toBe(previous);
        previous = question;
      }
    }
  });

  it("пропущенный адрес спрашивают адресом, а не по буквам", () => {
    for (const service of SERVICES) {
      const book = personaBook(service)!;
      for (let turn = 0; turn < 4; turn += 1) {
        const question = askLine(book, ["who", "card", "change"], turn, null);
        expect(question).toMatch(/адрес|улиц|дом/i);
        expect(question).not.toMatch(/по буквам/);
      }
    }
  });

  it("переспрос — одна фраза банка о первой недостающей части памятки", () => {
    for (const service of SERVICES) {
      const book = personaBook(service)!;
      const one = (
        slot: Parameters<typeof bankPhrases>[1],
        said: ReportPart[],
        gap?: AddressGap,
      ) => {
        const question = askLine(book, said, 0, null, gap ?? null)!;
        expect(texts(book, slot), `${book}: ${question}`).toContain(question);
      };
      one("ask_who", []);
      one("ask_who", ["address", "change"]);
      one("ask_address", ["who"]);
      one("ask_what", ["who"], "reason");
      one("ask_card", ["who", "address"]);
      one("ask_what", ["who", "address", "card"]);
    }
  });

  it("вопрос о поводе — без догадки о происшествии (стенд 17.10: горит машина)", () => {
    const book = personaBook("101")!;
    for (let turn = 0; turn < 4; turn += 1) {
      const reason = askLine(book, ["who"], turn, null, "reason");
      const change = askLine(book, ["who", "address", "card"], turn, null);
      expect(reason).not.toMatch(/Квартира, подвал/);
      expect(change).not.toMatch(/Квартира, подвал/);
    }
    expect(askLine(book, ["who", "address", "card"], 0, null)).toBe(
      "Что изменилось по обстановке?",
    );
  });

  it("отборы вопросов находят фразы в каждой книге OFFICIAL* (редакция не опустошит молча)", () => {
    const books = Object.keys(BANK_BOOKS).filter((book) =>
      book.startsWith(OFFICIAL),
    );
    expect(books).toEqual(
      expect.arrayContaining([
        OFFICIAL,
        ...SERVICES.map((s) => `${OFFICIAL}_${s}`),
      ]),
    );
    const asks: readonly ReportAsk[] = [
      "who",
      "place",
      "reason",
      "card",
      "change",
    ];
    for (const book of books)
      for (const ask of asks) {
        const { texts: found, fitted } = askCandidates(book, ask);
        // Отбор по тексту нашёл фразы, а не взял всё место книги.
        expect(fitted, `${book}, ${ask}: отбор пуст`).toBe(true);
        // Две разные формулировки — иначе askLine повторит вопрос подряд.
        expect(
          new Set(found).size,
          `${book}, ${ask}: ${found.join(" | ")}`,
        ).toBeGreaterThanOrEqual(2);
        for (const text of found) expect(text).not.toMatch(/по буквам/);
      }
  });

  it("вопрос о том, что изменилось, у скорой — не одной фразой подряд", () => {
    const book = personaBook("103")!;
    let previous: string | null = null;
    for (let turn = 0; turn < 4; turn += 1) {
      const question = askLine(
        book,
        ["who", "address", "card"],
        turn,
        previous,
      );
      expect(question, `вопрос ${turn}`).not.toBe(previous);
      previous = question;
    }
  });

  it("вопросы — фразы банка этой книги", () => {
    const book = personaBook("103")!;
    const question = askLine(book, [], 1, null)!;
    const asks = ["ask_who", "ask_address", "ask_what", "ask_card"] as const;
    let rest = question;
    for (const slot of asks)
      for (const text of texts(book, slot)) rest = rest.replace(text, "");
    expect(rest.trim()).toBe("");
  });
});

describe("«Повторите»", () => {
  it("короткая просьба повторить — не доклад", () => {
    expect(wantsRepeat("Повторите")).toBe(true);
    expect(wantsRepeat("Не расслышал, ещё раз")).toBe(true);
    expect(wantsRepeat("Повторите, пожалуйста")).toBe(true);
    expect(
      wantsRepeat(
        "Диспетчер Иванов, Дубнинская один, повторяю, ДТП с пострадавшими",
      ),
    ).toBe(false);
    expect(wantsRepeat("")).toBe(false);
  });

  it("в разговоре со службой — одна быстрая фраза «Повторите»", () => {
    const talk = {
      state: "talking" as const,
      withBrigade: false,
      refusal: false,
      textReport: false,
      heardReport: false,
    };
    expect(quickPhrases({ ...talk, peerLine: "Слушаю вас." })).toEqual([
      { id: "again", label: "Повторите", text: "Повторите." },
    ]);
    expect(quickPhrases({ ...talk, peerLine: null })).toEqual([]);
    expect(
      quickPhrases({ ...talk, refusal: true, peerLine: "Слушаю вас." }),
    ).toEqual([]);
  });
});

describe("реплика персонажа без записи", () => {
  it("в ленте без кнопки повтора звука", () => {
    const base: CallSnapshot = {
      callId: "call-1",
      state: "talking",
      inbound: false,
      aborted: false,
      refusal: null,
      phoneExt: "102",
      peer: "Служба 102",
      phrase: null,
      voice: "voice-1",
      report: null,
      byYou: false,
      duration: "0:01",
      clock: "10:00:00",
    };
    const lines = advanceLog([], null, base);
    const next = advanceLog(lines, base, {
      ...base,
      phrase: {
        key: "listen",
        text: "Полиция, оперативный дежурный Медведев, слушаю.",
        silent: true,
      },
    });
    const line = next.find((item) => item.id === "phrase-listen");
    expect(line?.text).toBe("Полиция, оперативный дежурный Медведев, слушаю.");
    expect(line?.replay).toBeUndefined();
  });
});
