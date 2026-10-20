import { describe, expect, it } from "vitest";
import {
  brigadeAnswer,
  calledService,
  newsService,
  notUnderstood,
  phraseKind,
  replyHowPayload,
  replyOutcome,
  replyProblemNote,
  replyUnclearNote,
} from "./voiceReply";
import { brigadePhrase, brigadePhrases } from "../bank";

const OPTIONS = [{ key: "fix" }, { key: "ok" }];

describe("ответ бригаде голосом: итог фразы", () => {
  it("сопоставленный вариант этой реплики — ответ", () => {
    expect(
      replyOutcome(
        200,
        {
          text: " Нет, Бескудниковский бульвар, 24 ",
          option_key: "fix",
          loudness: "ok",
        },
        OPTIONS,
      ),
    ).toEqual({
      kind: "heard",
      text: "Нет, Бескудниковский бульвар, 24",
      optionKey: "fix",
      loudness: "ok",
    });
  });

  it("не сопоставлено, пусто или чужой вариант — бригада переспрашивает", () => {
    expect(
      replyOutcome(
        200,
        {
          text: "Бескудниковский переулок",
          option_key: null,
          loudness: "quiet",
        },
        OPTIONS,
      ),
    ).toEqual({ kind: "unclear", loudness: "quiet" });
    // Пустая запись — тишина: бригада не переспрашивает (проверка 17.10).
    expect(replyOutcome(200, { text: "", option_key: "ok" }, OPTIONS)).toEqual({
      kind: "silence",
      loudness: null,
    });
    expect(
      replyOutcome(200, { text: "Девятый", option_key: "floor_9" }, OPTIONS),
    ).toEqual({ kind: "unclear", loudness: null });
    expect(replyOutcome(409, undefined, OPTIONS)).toEqual({
      kind: "unclear",
      loudness: null,
    });
  });

  it("распознавание выключено — голосом не ответить", () => {
    expect(replyOutcome(503, undefined, OPTIONS)).toEqual({ kind: "off" });
  });

  it("бригада переспрашивает фразой банка своей службы, в роде своего голоса", () => {
    expect(notUnderstood("101")).toBe("Не понял, повторите.");
    expect(notUnderstood("103")).toBe("Не поняла, повторите.");
  });
});

describe("ответ бригаде голосом: подсказки", () => {
  it("после двух неудач ведёт к вариантам, при «только голос» — нет", () => {
    expect(replyUnclearNote(1, false)).toBe("Повторите ответ голосом.");
    expect(replyUnclearNote(2, false)).toContain("Выберите вариант ответа");
    expect(replyUnclearNote(2, true)).not.toContain("вариант ответа ниже");
  });

  it("без микрофона — ответить вариантом", () => {
    expect(replyProblemNote("no_device", false)).toBe(
      "Микрофон не найден. Подключите гарнитуру. Ответьте бригаде вариантом.",
    );
    expect(replyProblemNote("server_off", true)).toContain(
      "сообщите преподавателю",
    );
  });
});

describe("ответ бригаде: как дан — в событие brigade_reply", () => {
  it("голосом — режим, текст, громкость и неудачи", () => {
    expect(
      replyHowPayload({
        mode: "voice",
        text: "Девятый этаж",
        loudness: "ok",
        voiceFailures: 1,
      }),
    ).toEqual({
      mode: "voice",
      text: "Девятый этаж",
      loudness: "ok",
      voice_failures: 1,
    });
  });

  it("вариантом — без текста и громкости, неудачи если были", () => {
    expect(
      replyHowPayload({ mode: "option", text: "x", loudness: "ok" }),
    ).toEqual({ mode: "option" });
    expect(replyHowPayload({ mode: "option", voiceFailures: 2 })).toEqual({
      mode: "option",
      voice_failures: 2,
    });
    expect(replyHowPayload(undefined)).toEqual({});
  });
});

describe("фраза бригаде без её вопроса (DT-19)", () => {
  it("распознанное уходит как сказанное, а не как вариант", () => {
    expect(
      replyOutcome(200, { text: " Выезжайте ", option_key: null }, null),
    ).toEqual({
      kind: "said",
      text: "Выезжайте",
      loudness: null,
      worldAnswers: false,
    });
    // Поправка повтора адреса фразой (HQ-024): ответит мир, а не окно телефона.
    expect(
      replyOutcome(
        200,
        {
          text: "Бескудниковский бульвар 24, доложите по прибытии",
          option_key: null,
          world_answers: true,
        },
        null,
      ),
    ).toMatchObject({ kind: "said", worldAnswers: true });
    expect(replyOutcome(200, { text: "", option_key: null }, null)).toEqual({
      kind: "silence",
      loudness: null,
    });
    expect(replyOutcome(503, undefined, null)).toEqual({ kind: "off" });
  });

  it("бригада отвечает: на просьбу доложить — докладом, на остальное — «Принял»", () => {
    expect(
      brigadeAnswer("Доложите обстановку", "Прибыли, машин нет.", "102"),
    ).toBe("Повторяю. Прибыли, машин нет.");
    expect(brigadeAnswer("вы на месте?", null, "102")).toBe(
      "Едем, на месте доложу.",
    );
    expect(
      brigadeAnswer("Каширское шоссе 26, зажат водитель", null, "102"),
    ).toBe("Понял.");
    expect(brigadeAnswer("  ", null, "102")).toBe(notUnderstood("102"));
    // Скорая — женский голос: «Поняла».
    expect(brigadeAnswer("Принято", null, "103")).toBe("Поняла.");
  });
});

describe("ответ бригады по виду фразы (GP-11, docs/dds_gameplay.md, раздел 4)", () => {
  it("вид фразы: просьба доложить, новые сведения, непонятное", () => {
    for (const text of [
      "Доложите обстановку",
      "доложите ещё раз",
      "Вы на месте?",
      "что у вас",
      "где вы сейчас",
    ])
      expect(phraseKind(text), text).toBe("report_request");
    for (const text of [
      "В квартире ребёнок",
      "Выезжайте",
      "Каширское шоссе 26, зажат водитель",
      "Принято",
    ])
      expect(phraseKind(text), text).toBe("info");
    for (const text of ["", "   ", "э-э...", "мм", "а", "123", "?!"])
      expect(phraseKind(text), text).toBe("unclear");
  });

  it("просьба доложить: «Повторяю» и последний доклад разговора", () => {
    expect(
      brigadeAnswer("Доложите обстановку", "Прибыли, машин нет.", "101"),
    ).toBe(`${brigadePhrase("101", "repeat_report")} Прибыли, машин нет.`);
  });

  it("просьба доложить, доклада ещё не было: бригада в пути, доложит", () => {
    const answer = brigadeAnswer("Доложите обстановку", null, "102");
    expect(answer).toMatch(/доложу/i);
    expect(brigadePhrases("102", "enroute").map((p) => p.text)).toContain(
      answer,
    );
  });

  it("новые сведения: «Принял» своей службы, в роде её голоса", () => {
    expect(brigadeAnswer("В квартире ребёнок", "Доклад.", "102")).toBe(
      brigadePhrase("102", "ack"),
    );
    expect(brigadeAnswer("В квартире ребёнок", null, "103")).toBe("Поняла.");
  });

  it("непонятное: «Не понял, повторите» — и «Не поняла» у скорой", () => {
    expect(brigadeAnswer("э-э...", "Доклад.", "101")).toBe(
      "Не понял, повторите.",
    );
    expect(brigadeAnswer("мм", null, "103")).toBe("Не поняла, повторите.");
  });
});

describe("служба вызвана — бригада отвечает «ждём» (GP-28)", () => {
  it.each([
    ["Пожарные выехали", "101"],
    ["Скорую вызвал, едет", "103"],
    ["Спасатели уже в пути", "101"],
    ["Наряд полиции направлен", "102"],
    ["Мосгаз вызван", "104"],
    ["Сейчас вызову пожарных", null],
    ["Пожарных ещё не вызвал", null],
    ["Уже вызвал", null],
    ["Доложите обстановку", null],
  ])("«%s» → %s", (text, service) => {
    expect(calledService(text)).toBe(service);
  });

  it("ответ — фраза её книги о названной службе, тем же словом", () => {
    expect(phraseKind("Пожарные выехали")).toBe("service_called");
    const firefighters = brigadeAnswer("Пожарные выехали", null, "102");
    expect(firefighters).toMatch(/пожарн/i);
    expect(
      brigadePhrases("102", "service_coming").map((item) => item.text),
    ).toContain(firefighters);
    expect(brigadeAnswer("Спасатели выехали", null, "102")).toMatch(
      /спасател/i,
    );
    expect(brigadeAnswer("Скорая едет", null, "103")).toBe(
      brigadePhrase("103", "ack"),
    );
    // У скорой голос женский — и фраза в её роде.
    expect(brigadeAnswer("Полиция едет", null, "103")).toMatch(
      /^Поняла|^Хорошо/,
    );
  });
});

describe("о службе по просьбе бригаде сообщает диспетчер (HQ-055)", () => {
  const open = {
    service: "103",
    open: true,
    asked: ["103"],
    opened: ["103"],
    called: ["103"],
  };
  const closed = {
    service: "103",
    open: false,
    asked: ["103"],
    opened: [],
    called: [],
  };

  it("«отправил», «уже едет» без названия — о службе, которую бригада просила", () => {
    expect(newsService("Отправил, ждите", open)).toBe("103");
    expect(newsService("Уже едет", open)).toBe("103");
    // О службе, которую не просили, — только после набора её номера или 112 (GP-28).
    expect(newsService("Пожарные выехали", open)).toBeNull();
    expect(newsService("Пожарные выехали", { ...open, called: ["101"] })).toBe(
      "101",
    );
    expect(newsService("Пожарные выехали", { ...open, called: ["112"] })).toBe(
      "101",
    );
    expect(newsService("Отправил", null)).toBeNull();
    expect(newsService("Сейчас вызову, ждите", open)).toBeNull();
    expect(newsService("Ещё не отправил", open)).toBeNull();
    expect(phraseKind("Отправил", open)).toBe("service_called");
    expect(phraseKind("Отправил")).toBe("info");
  });

  it("ответ — «Понял, ждём …» об этой службе из её книги", () => {
    const answer = brigadeAnswer("Отправил, ждите", null, "102", open);
    expect(
      brigadePhrases("102", "service_coming")
        .filter((item) => item.needs === "103")
        .map((item) => item.text),
    ).toContain(answer);
  });

  it("вне окна сервера (до звонка в службу, после её приезда) — обычный ответ", () => {
    // «Отправил» после приезда скорой и «скорая будет» до набора 103 — сервер не засчитает.
    expect(newsService("Отправил, ждите", closed)).toBeNull();
    expect(newsService("Скорая будет", closed)).toBeNull();
    expect(phraseKind("Скорая будет", closed)).toBe("info");
    expect(brigadeAnswer("Отправил, ждите", null, "102", closed)).toBe(
      brigadeAnswer("Поняли вас", null, "102"),
    );
    // О другой службе (вызванной заранее, GP-28) окно вести просимой не мешает.
    expect(
      newsService("Пожарные выехали", { ...closed, called: ["101"] }),
    ).toBe("101");
    // Две просьбы о скорой (просьба и тревога): весть в окне первой — засчитана.
    const twice = {
      service: "103",
      open: true,
      asked: ["103", "103"],
      opened: ["103"],
      called: ["103"],
    };
    expect(newsService("Скорую уже вызвал, едет.", twice)).toBe("103");
  });
});

describe("служба вызвана заранее: весть — только после набора (GP-28)", () => {
  const none = {
    service: null,
    open: false,
    asked: [],
    opened: [],
    called: [],
  };

  it("«скорую вызвал» до набора 103 — неправда, бригада отвечает «Принял»", () => {
    expect(newsService("Скорую вызвал, едет", none)).toBeNull();
    expect(phraseKind("Скорую вызвал, едет", none)).toBe("info");
    expect(brigadeAnswer("Скорую вызвал, едет", null, "102", none)).toBe(
      brigadeAnswer("Поняли вас", null, "102"),
    );
  });

  it("после набора 103 или 112 — «Понял, ждём скорую»", () => {
    const called = { ...none, called: ["103"] };
    expect(newsService("Скорую вызвал, едет", called)).toBe("103");
    expect(
      brigadePhrases("102", "service_coming")
        .filter((item) => item.needs === "103")
        .map((item) => item.text),
    ).toContain(brigadeAnswer("Скорую вызвал, едет", null, "102", called));
    expect(
      newsService("Скорую вызвал, едет", { ...none, called: ["112"] }),
    ).toBe("103");
    // Набран номер другой службы — о скорой всё ещё неправда.
    expect(
      newsService("Скорую вызвал, едет", { ...none, called: ["101"] }),
    ).toBeNull();
  });
});
