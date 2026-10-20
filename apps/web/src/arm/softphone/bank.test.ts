import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  BANK_BOOKS,
  bankAudio,
  bankAudioForText,
  bankAudiosForText,
  bankText,
  brigadePhrases,
  brigadePhrase,
  officialPhrase,
  type BrigadeSlot,
  type OfficialSlot,
} from "./bank";
import { brigadeAnswer, notUnderstood } from "./brigade/voiceReply";
import { briefingAnswer } from "./brigade/briefing";
import { ASK_IDS, CLARIFY, clarifyFor } from "./report";
import { NOT_HEARD } from "./voiceReport";
import { PHRASE_ID, PHRASE_TEXT } from "./voices";
import { VOICE_ASSETS } from "./voiceAssets";

// GP-25: всё, что окно телефона говорит за бригаду и должностное лицо, — фразы банка озвучки
// (scripts/voices/bank/phrases). Выборка bankPhrases.json сверяется с самим банком.

interface SourcePhrase {
  id: string;
  slot: string;
  text: string;
  incidents?: string[];
  number?: number | string;
  /** Новая редакция (revisions/): какую фразу книги phrases/ заменяет (HQ-037). */
  replaces?: string;
}
interface SourceBook {
  service: string;
  speaker: "brigade" | "official" | "caller";
  gender: "male" | "female";
  phrases: SourcePhrase[];
}

/** Книги папки банка: phrases/ — бригады и должностные лица, callers/ — заявитель (HQ-019). */
function booksIn(folder: string): SourceBook[] {
  const dir = join(process.cwd(), "../../scripts/voices/bank", folder);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map(
      (name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as SourceBook,
    );
}
const SOURCE: SourceBook[] = [...booksIn("phrases"), ...booksIn("callers")];
// Новые редакции фраз (HQ-037): встают на место старой, только когда у них есть запись.
const revisionsDir = join(process.cwd(), "../../scripts/voices/bank/revisions");
const REVISIONS: SourcePhrase[] = readdirSync(revisionsDir)
  .filter((name) => name.endsWith(".json"))
  .flatMap(
    (name) =>
      (JSON.parse(readFileSync(join(revisionsDir, name), "utf8")) as SourceBook)
        .phrases,
  );
/** Фраза, которой окно телефона говорит вместо `phrase`: записанная новая редакция или она сама. */
function current(phrase: SourcePhrase): SourcePhrase {
  return (
    REVISIONS.find(
      (item) => item.replaces === phrase.id && bankAudio(item.id) !== null,
    ) ?? phrase
  );
}
const BRIGADE_SLOTS: BrigadeSlot[] = [
  "answer",
  "intro",
  "no_reply",
  "confirm_request",
  "repeat_report",
  "ack",
  "not_understood",
  "end_call",
  "enroute",
  "status_working",
];
const OFFICIAL_SLOTS: OfficialSlot[] = [
  "answer",
  "accepted",
  "registered",
  "ask_who",
  "ask_address",
  "ask_what",
  "ask_card",
  "ask_victims",
  "not_understood",
  "end_call",
];
const BRIGADES = SOURCE.filter((book) => book.speaker === "brigade").map(
  (book) => book.service,
);

/** Тексты места разговора в книге банка. */
function texts(service: string, slot: string): string[] {
  const book = SOURCE.find((item) => item.service === service);
  return (book?.phrases ?? [])
    .filter((phrase) => phrase.slot === slot)
    .map((phrase) => current(phrase).text);
}

describe("выборка банка для окна телефона", () => {
  it("совпадает с банком: перегенерируйте python3 scripts/voices/bank/web.py", () => {
    expect(Object.keys(BANK_BOOKS).sort()).toEqual(
      SOURCE.map((book) => book.service).sort(),
    );
    for (const book of SOURCE) {
      // Заявитель — все места книги: разговор с ним ведёт окно телефона (HQ-019).
      const slots =
        book.speaker === "brigade"
          ? BRIGADE_SLOTS
          : book.speaker === "caller"
            ? [...new Set(book.phrases.map((phrase) => phrase.slot))]
            : OFFICIAL_SLOTS;
      const bundled = BANK_BOOKS[book.service];
      expect(bundled?.speaker).toBe(book.speaker);
      expect(bundled?.gender).toBe(book.gender);
      for (const slot of slots) {
        const expected = book.phrases
          .filter((phrase) => phrase.slot === slot)
          .map(current)
          .map((phrase) => [phrase.id, phrase.text]);
        const got = (bundled?.slots[slot] ?? []).map((phrase) => [
          phrase.id,
          phrase.text,
        ]);
        expect(got, `${book.service} ${slot}`).toEqual(expected);
      }
    }
  });

  it("новая редакция фразы — того же места, без записи не звучит (HQ-037)", () => {
    const sourceIds = new Map(
      SOURCE.flatMap((book) =>
        book.phrases.map((phrase) => [phrase.id, phrase] as const),
      ),
    );
    expect(REVISIONS.length).toBeGreaterThan(0);
    for (const revision of REVISIONS) {
      const old = sourceIds.get(revision.replaces ?? "");
      expect(old?.slot, revision.id).toBe(revision.slot);
      expect(String(old?.number ?? ""), revision.id).toBe(
        String(revision.number ?? ""),
      );
      const bundled = Object.values(BANK_BOOKS).flatMap((book) =>
        Object.values(book.slots).flatMap((phrases) => phrases ?? []),
      );
      const ids = bundled.map((phrase) => phrase.id);
      // Записана — звучит вместо старой; нет записи — звучит старая со своей записью.
      if (bankAudio(revision.id) !== null) {
        expect(ids).toContain(revision.id);
        expect(ids).not.toContain(revision.replaces);
      } else {
        expect(ids).not.toContain(revision.id);
        expect(ids).toContain(revision.replaces);
      }
    }
  });

  it("номер регистрации — цифрами, как в банке", () => {
    for (const book of SOURCE.filter((item) => item.speaker === "official"))
      for (const phrase of book.phrases
        .filter((item) => item.slot === "registered")
        .map(current))
        expect(
          BANK_BOOKS[book.service]?.slots.registered?.find(
            (item) => item.id === phrase.id,
          )?.number,
        ).toBe(String(phrase.number));
  });

  it("неизвестная фраза — ошибка, а не тихий текст", () => {
    expect(() => bankText("OFFICIAL.answer.any.99")).toThrow(/Нет фразы/);
  });
});

describe("ответы бригады в разговоре — фразы банка её службы", () => {
  it.each(BRIGADES)("служба %s", (service) => {
    expect(texts(service, "not_understood")).toContain(notUnderstood(service));
    expect(texts(service, "end_call")).toContain(
      brigadePhrase(service, "end_call"),
    );
    expect(texts(service, "ack")).toContain(
      brigadeAnswer("Каширское шоссе, двадцать шесть", null, service),
    );
    expect(texts(service, "enroute")).toContain(
      brigadeAnswer("Доложите обстановку", null, service),
    );
    const repeat = brigadeAnswer("Доложите ещё раз", "Прибыли.", service);
    expect(
      texts(service, "repeat_report").some(
        (text) => repeat === `${text} Прибыли.`,
      ),
    ).toBe(true);
    expect(texts(service, "not_understood")).toContain(
      briefingAnswer(null, service),
    );
    // Места входящего доклада и вопроса бригады (TC-01) — тоже из банка.
    for (const slot of [
      "answer",
      "intro",
      "no_reply",
      "confirm_request",
      "status_working",
    ] as const)
      expect(texts(service, slot)).toContain(brigadePhrase(service, slot, 1));
  });

  it("скорая говорит в женском роде, остальные — в мужском", () => {
    expect(brigadePhrase("103", "end_call")).toBe("Приняла, конец связи.");
    expect(brigadePhrase("101", "end_call")).toBe("Принял, конец связи.");
    // Службы без книги бригады нет — отвечает книга 101, а не пустая строка.
    expect(brigadePhrase("112", "ack")).toBe(brigadePhrase("101", "ack"));
  });

  it("фразы места перебираются, а не повторяются подряд", () => {
    expect(brigadePhrase("101", "ack", 0)).not.toBe(
      brigadePhrase("101", "ack", 1),
    );
  });
});

describe("реплики должностного лица — фразы банка дежурного", () => {
  const official = (slot: string) => texts("OFFICIAL", slot);

  it("Q14: «Слушаю вас» и «Я вас понял, информация принята»", () => {
    expect(official("answer")).toContain(PHRASE_TEXT.listen);
    expect(official("accepted")).toContain(PHRASE_TEXT.accepted);
    expect(bankText(PHRASE_ID.listen)).toBe(PHRASE_TEXT.listen);
  });

  it("записи Piper говорят те же фразы — в роде своего голоса до записей банка", () => {
    const plain = (text: string) =>
      text.replace(/[.!?]+$/, "").replace("поняла", "понял");
    for (const assets of Object.values(VOICE_ASSETS)) {
      expect(plain(assets.listen.text)).toBe(plain(PHRASE_TEXT.listen));
      expect(plain(assets.accepted.text)).toBe(plain(PHRASE_TEXT.accepted));
    }
  });

  it("переспрос доклада и «не понял» — из банка", () => {
    expect(official("not_understood")).toContain(NOT_HEARD);
    for (const id of Object.values(ASK_IDS)) {
      const slot = id.split(".")[1] ?? "";
      expect(slot).toMatch(/^ask_/);
      expect(official(slot)).toContain(bankText(id));
    }
    expect(CLARIFY).toEqual({
      no_who: bankText(ASK_IDS.who),
      no_address: bankText(ASK_IDS.place),
      no_card: bankText(ASK_IDS.card),
      no_change: bankText(ASK_IDS.change),
    });
    // Один вопрос — о первой недостающей части.
    expect(clarifyFor([])).toBe(CLARIFY.no_who);
  });

  it.each(OFFICIAL_SLOTS)("место %s есть у общего дежурного", (slot) => {
    if (slot === "registered") return; // номер называют только персонажи служб (TC-03)
    expect(official(slot)).toContain(officialPhrase(slot));
  });
});

// GP-28: фразы выборки звучат записями набора bank-v1 (./bank/<id>.ogg, scripts/voices/bank/web.py).
describe("записи банка в окне телефона", () => {
  const all = Object.values(BANK_BOOKS).flatMap((book) =>
    Object.values(book.slots).flatMap((phrases) =>
      (phrases ?? []).map((phrase) => ({ speaker: book.speaker, phrase })),
    ),
  );

  it("каждая экспортированная фраза, включая все сюжеты заявителя, имеет запись", () => {
    expect(all.length).toBeGreaterThan(0);
    expect(
      all
        .filter(({ phrase }) => bankAudio(phrase.id) === null)
        .map(({ phrase }) => phrase.id),
    ).toEqual([]);
  });

  it("каждая ранее записанная фраза из bank-v* остаётся доступна окну независимо от говорящего", () => {
    const voices = join(process.cwd(), "../../data/voices");
    const ids = readdirSync(voices)
      .filter((name) => /^bank-v[0-9]+$/.test(name))
      .flatMap(
        (name) =>
          (
            JSON.parse(
              readFileSync(join(voices, name, "manifest.json"), "utf8"),
            ) as { messages: { id?: string }[] }
          ).messages,
      )
      .flatMap((item) => (item.id ? [item.id] : []));
    expect(ids.length).toBeGreaterThan(0);
    const recorded = new Set(ids);
    expect(
      all
        .filter(
          ({ phrase }) =>
            recorded.has(phrase.id) && bankAudio(phrase.id) === null,
        )
        .map(({ phrase }) => phrase.id),
    ).toEqual([]);
  });

  it("запись по тексту берётся из книги говорящего", () => {
    const [own] = brigadePhrases("102", "ack");
    expect(own).toBeDefined();
    expect(bankAudioForText(["102"], own!.text)).toBe(bankAudio(own!.id));
    expect(
      bankAudioForText(["OFFICIAL"], "такой фразы в банке нет"),
    ).toBeNull();
  });

  it("склеенная реплика звучит записями по порядку, кусок без записи — тишина", () => {
    const [ask, what] = [
      brigadePhrase("102", "repeat_report"),
      brigadePhrase("102", "ack"),
    ];
    const report = "Наряд на месте, обстановку уточняем.";
    const known = new Map([[report, "доклад.ogg"]]);
    expect(bankAudiosForText(["102"], `${ask} ${what}`)).toEqual([
      bankAudioForText(["102"], ask),
      bankAudioForText(["102"], what),
    ]);
    expect(bankAudiosForText(["102"], `${ask} ${report}`, known)).toEqual([
      bankAudioForText(["102"], ask),
      "доклад.ogg",
    ]);
    expect(bankAudiosForText(["102"], `${ask} чужой текст`)).toBeNull();
    // Чужой голос пробел не закрывает: фраза дежурного в книге бригады не ищется.
    expect(
      bankAudiosForText(["102"], brigadePhrase("103", "end_call")),
    ).toBeNull();
  });

  it.each(["101", "102", "103", "104", "GKH", "MOSLIFT"])(
    "у бригады %s есть отказ и переспрос вводной",
    (service) => {
      for (const slot of ["refusal_busy", "refusal_not_assigned"] as const)
        expect(brigadePhrases(service, slot)).not.toHaveLength(0);
      const asks = brigadePhrases(service, "briefing_ask").map((p) => p.asks);
      expect(asks.sort()).toEqual(["address", "both", "what"]);
    },
  );
});
