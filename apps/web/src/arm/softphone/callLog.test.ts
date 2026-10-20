import { describe, expect, it } from "vitest";
import { bankAudiosForText } from "./bank";
import {
  advanceLog,
  restoredLog,
  HELD_PREFIX,
  type CallSnapshot,
  type LogLine,
  endNote,
  heardChips,
  knownRecordings,
  quickPhrases,
  peerSaid,
  youSaid,
  youSaidHeard,
} from "./callLog";

const base: CallSnapshot = {
  callId: "c1",
  state: "dialing",
  inbound: false,
  aborted: false,
  refusal: null,
  phoneExt: "102",
  peer: "Служба 102",
  phrase: null,
  voice: "voice-2",
  report: null,
  byYou: false,
  duration: "0:00",
  clock: "10:00:00",
};

function run(...steps: Partial<CallSnapshot>[]) {
  let lines = advanceLog([], null, base);
  let prev = base;
  for (const step of steps) {
    const next = { ...prev, ...step };
    lines = advanceLog(lines, prev, next);
    prev = next;
  }
  return lines;
}

describe("advanceLog", () => {
  it("звонок службе: вызов, соединение, реплики, отбой", () => {
    const lines = run(
      { state: "ringing" },
      { state: "talking", clock: "10:00:04" },
      { phrase: { key: "listen", text: "Слушаю вас" } },
      { phrase: { key: "accepted", text: "Я вас понял, информация принята" } },
      { state: "ended", byYou: true, duration: "0:21" },
    );
    expect(lines.map((line) => [line.who, line.text])).toEqual([
      ["note", "Вызов: 102 Служба 102…"],
      ["note", "Соединение установлено 10:00:04"],
      ["peer", "Слушаю вас"],
      ["peer", "Я вас понял, информация принята"],
      ["note", "Вы положили трубку. Разговор 0:21"],
    ]);
    expect(lines[2]!.replay).toEqual({
      kind: "phrase",
      phrase: "listen",
      voice: "voice-2",
    });
  });

  it("доклад бригады попадает в ленту один раз и крупной строкой", () => {
    const report = {
      deliveryId: "d1",
      text: "Прибыли на место",
      url: null,
      durationMs: 1500,
    };
    const lines = run(
      { state: "talking" },
      { report },
      { report },
      { report: null },
    );
    const reports = lines.filter((line) => line.report);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.text).toBe("Прибыли на место");
  });

  it("новый звонок начинает ленту заново", () => {
    const first = run({ state: "talking" }, { state: "ended" });
    const second = advanceLog(
      first,
      { ...base, state: "ended" },
      {
        ...base,
        callId: "c2",
        phoneExt: "301",
        peer: "Бригада 1",
      },
    );
    expect(second.map((line) => line.text)).toEqual(["Вызов: 301 Бригада 1…"]);
  });

  it("входящий вызов сразу на связи", () => {
    const lines = advanceLog([], null, {
      ...base,
      inbound: true,
      state: "talking",
      peer: "Бригада 1",
    });
    expect(lines.map((line) => line.text)).toEqual([
      "Входящий вызов: Бригада 1",
      "Соединение установлено 10:00:00",
    ]);
  });

  it("входящий вызов бригады: старший называет себя до доклада (TC-01)", () => {
    const inbound = {
      ...base,
      inbound: true,
      state: "talking" as const,
      peer: "Бригада 1",
      intro: "Старший расчёта, на связи.",
    };
    let lines = advanceLog([], null, inbound);
    const reporting = {
      ...inbound,
      report: {
        deliveryId: "d1",
        text: "Выехали.",
        url: null,
        durationMs: 1200,
      },
    };
    lines = advanceLog(lines, inbound, reporting);
    // Повторный снимок второй фразы старшего не добавляет.
    lines = advanceLog(lines, reporting, { ...reporting, clock: "10:00:05" });
    expect(lines.map((line) => line.text)).toEqual([
      "Входящий вызов: Бригада 1",
      "Соединение установлено 10:00:00",
      "Старший расчёта, на связи.",
      "Выехали.",
    ]);
    // Исходящий звонок бригаде — без представления.
    expect(run({ state: "talking" }).some((line) => line.id === "intro")).toBe(
      false,
    );
  });

  it("без изменений возвращает ту же ленту", () => {
    const lines = advanceLog([], null, base);
    expect(advanceLog(lines, base, base)).toBe(lines);
  });

  it("готовый доклад сохраняется уже в первом снимке нового разговора", () => {
    const next = {
      ...base,
      callId: "c2",
      state: "talking" as const,
      inbound: true,
      report: {
        deliveryId: "d2",
        text: "Прибыли на место",
        url: "/latest.ogg",
        durationMs: 1500,
      },
    };
    const lines = advanceLog(run({ state: "ended" }), base, next);
    expect(lines.filter((line) => line.report)).toHaveLength(1);
    expect(lines.at(-1)?.replay).toMatchObject({
      deliveryId: "d2",
      url: "/latest.ogg",
    });
    expect(advanceLog(lines, next, next)).toBe(lines);
  });
});

describe("удержание линии (TC-02)", () => {
  const brigade: CallSnapshot = {
    ...base,
    callId: "in-1",
    state: "talking",
    inbound: true,
    peer: "Старший бригады 1",
    phoneExt: "201",
  };

  it("на удержание — строка удержания, а не отбоя", () => {
    const lines = advanceLog([], null, brigade);
    const held = advanceLog(lines, brigade, {
      ...brigade,
      state: "ended",
      held: true,
      byYou: true,
      duration: "0:12",
    });
    expect(held.at(-1)).toMatchObject({
      who: "note",
      text: "Разговор на удержании, 0:12",
    });
  });

  it("снят с удержания — старший снова на связи, без «Входящий вызов»", () => {
    const other = { ...brigade, callId: "in-2", state: "ended" as const };
    const lines = advanceLog([], other, {
      ...brigade,
      inbound: true,
      intro: "Старший расчёта, на связи.",
      resumed: "Да, диспетчер, на связи.",
    });
    expect(lines.map((line) => [line.who, line.text])).toEqual([
      ["note", "Снят с удержания: Старший бригады 1"],
      ["peer", "Да, диспетчер, на связи."],
    ]);
  });

  it("снята с удержания служба — строка снятия и её «Да, слушаю» репликой", () => {
    const service = { ...base, callId: "out-1", state: "talking" as const };
    expect(
      advanceLog([], null, { ...service, resumed: "" }).map((line) => [
        line.who,
        line.text,
      ]),
    ).toEqual([["note", "Снят с удержания: Служба 102"]]);
    // Реплика звучит в тот же миг, что и снятие: в ленте сразу после строки снятия.
    const lines = advanceLog([], null, {
      ...service,
      resumed: "",
      phrase: {
        key: "listen",
        text: "Да, дежурная часть, слушаю.",
        silent: true,
      },
    });
    expect(lines.map((line) => [line.who, line.text])).toEqual([
      ["note", "Снят с удержания: Служба 102"],
      ["peer", "Да, дежурная часть, слушаю."],
    ]);
  });

  it("лента после снятия — сказанное до удержания, затем новая часть", () => {
    const before = advanceLog([], null, brigade);
    const held = advanceLog(before, brigade, {
      ...brigade,
      state: "ended",
      held: true,
      duration: "0:12",
    });
    const fresh = advanceLog([], null, {
      ...brigade,
      inbound: false,
      resumed: "Да, диспетчер, на связи.",
    });
    const lines = restoredLog(held, fresh);
    expect(lines.map((line) => line.text)).toEqual([
      ...held.map((line) => line.text),
      "Снят с удержания: Старший бригады 1",
      "Да, диспетчер, на связи.",
    ]);
    // Свои id: новый отбой того же звонка допишет строку «end».
    expect(new Set(lines.map((line) => line.id)).size).toBe(lines.length);
    expect(lines.filter((line) => line.id === "end")).toEqual([]);
    expect(
      lines.slice(0, held.length).every((line) => line.id.startsWith("held-")),
    ).toBe(true);
    // Повторное удержание не наращивает приставку.
    expect(restoredLog(lines, [])[0]!.id).toBe(lines[0]!.id);
  });

  it("после удержания повтор берёт новый доклад, а не прежнюю просьбу о службе", () => {
    const report = {
      deliveryId: "request",
      text: "Мужчина без сознания. Нужна скорая!",
      url: "/request.ogg",
      durationMs: 1500,
    };
    const before = advanceLog([], null, brigade);
    const saved = advanceLog(before, brigade, { ...brigade, report });
    const resumed = {
      ...brigade,
      resumed: "Расчёт на связи.",
      report: {
        ...report,
        deliveryId: "latest",
        text: "Работы идут.",
        url: "/latest.ogg",
      },
    };
    const fresh = advanceLog([], { ...base, callId: "service" }, resumed);
    const lines = restoredLog(saved, fresh);
    expect(
      lines.filter((line) => line.report).map((line) => line.text),
    ).toEqual([report.text, resumed.report.text]);
    expect(
      [...lines].reverse().find((line) => line.replay?.kind === "report")
        ?.replay,
    ).toMatchObject({ deliveryId: "latest", url: "/latest.ogg" });
  });

  it("прежняя выдача при снятии с удержания не дублирует доклад", () => {
    const next = {
      ...brigade,
      report: {
        deliveryId: "d1",
        text: "Работы идут.",
        url: "/report.ogg",
        durationMs: 1500,
      },
    };
    const before = advanceLog([], null, next);
    const fresh = advanceLog(
      [],
      { ...base, callId: "service" },
      { ...next, resumed: "Расчёт на связи." },
    );
    const restored = restoredLog(before, fresh);
    const lines = advanceLog(restored, next, next);
    expect(lines.filter((line) => line.report)).toHaveLength(1);
  });
});

describe("endNote", () => {
  it("различает сброс, отбой абонента и свой отбой", () => {
    expect(endNote({ ...base, aborted: true })).toBe("Вызов сброшен");
    expect(endNote({ ...base, refusal: "busy", duration: "0:03" })).toBe(
      "Абонент положил трубку. Разговор 0:03",
    );
    expect(endNote({ ...base, byYou: true, duration: "1:02" })).toBe(
      "Вы положили трубку. Разговор 1:02",
    );
  });
});

describe("quickPhrases", () => {
  const talk = {
    state: "talking" as const,
    withBrigade: true,
    refusal: false,
    textReport: false,
    heardReport: false,
  };

  it("службе быстрых фраз нет: она получает доклад голосом или по частям", () => {
    expect(
      quickPhrases({ ...talk, withBrigade: false, textReport: true }),
    ).toEqual([]);
  });

  it("бригаде, ждущей вводной, — варианты текущего шага по частям (GP-05)", () => {
    const step = {
      key: "address" as const,
      label: "Адрес",
      options: [{ text: "Дубнинская улица, дом 1", correct: true }],
    };
    expect(quickPhrases({ ...talk, briefing: step })).toEqual([
      {
        id: "brief",
        label: "Дубнинская улица, дом 1",
        text: "Дубнинская улица, дом 1",
        correct: true,
      },
    ]);
    expect(quickPhrases({ ...talk, refusal: true, briefing: step })).toEqual(
      [],
    );
  });

  it("бригаде — «Принял» только для текстового доклада", () => {
    expect(quickPhrases(talk)).toEqual([]);
    expect(
      quickPhrases({ ...talk, textReport: true }).map((item) => item.id),
    ).toEqual(["ack"]);
  });

  it("на «Как приняли?» — «Принял» и после озвученного доклада (TC-01)", () => {
    expect(
      quickPhrases({ ...talk, heardReport: true, confirm: true }).map(
        (item) => item.text,
      ),
    ).toEqual(["Принял.", "Повторите доклад."]);
    expect(
      quickPhrases({ ...talk, textReport: true, confirm: true }).map(
        (item) => item.id,
      ),
    ).toEqual(["ack"]);
  });

  it("на вопрос бригады — варианты ответа как кнопки, верный не отмечен", () => {
    const question = {
      deliveryId: "q",
      text: "На каком этаже?",
      url: null,
      replyBy: null,
      options: [
        { key: "floor_9", label: "Девятый этаж" },
        { key: "later", label: "Уточню у заявителя и перезвоню" },
      ],
    };
    const phrases = quickPhrases({ ...talk, question });
    expect(phrases.map((item) => [item.id, item.text, item.reply])).toEqual([
      ["reply", "Девятый этаж.", { deliveryId: "q", optionKey: "floor_9" }],
      [
        "reply",
        "Уточню у заявителя и перезвоню.",
        { deliveryId: "q", optionKey: "later" },
      ],
    ]);
    expect(quickPhrases({ ...talk, withBrigade: false, question })).toEqual([]);
  });

  it("прозвучавший доклад можно попросить повторить", () => {
    expect(
      quickPhrases({ ...talk, heardReport: true }).map((item) => item.id),
    ).toEqual(["repeat"]);
  });

  it("при отказе и вне разговора фраз нет", () => {
    expect(quickPhrases({ ...talk, refusal: true, textReport: true })).toEqual(
      [],
    );
    expect(
      quickPhrases({ ...talk, state: "ringing", textReport: true }),
    ).toEqual([]);
  });

  it("реплики диспетчера и службы дописываются в ленту", () => {
    expect(youSaid([], "Принял.")).toEqual([
      { id: "you-0", who: "you", text: "Принял." },
    ]);
    expect(peerSaid([], "Уточните адрес происшествия.")).toEqual([
      { id: "peer-0", who: "peer", text: "Уточните адрес происшествия." },
    ]);
  });
});

describe("heardChips", () => {
  it("отмечает услышанные части ✓, остальные ✗ — в порядке памятки", () => {
    expect(heardChips(["address", "who"])).toEqual([
      { label: "Кто вы", ok: true },
      { label: "Адрес и повод", ok: true },
      { label: "Карточка", ok: false },
      { label: "Что изменилось", ok: false },
    ]);
  });

  it("услышанное — метками в строке «Вы сказали», без отдельной строки", () => {
    const lines = youSaidHeard([], "Служба 102, Бескудниковский бульвар 24", [
      "who",
      "address",
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.who).toBe("you");
    expect(lines[0]?.chips?.map((chip) => chip.ok)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});

describe("knownRecordings — записи реплик ленты (HQ-058)", () => {
  const question =
    "Диспетчер, хозяева дома будут? Квартира закрыта, никто не отвечает.";

  it("повтор вопроса после удержания звучит записью его реплики, а не только из ленты", () => {
    // Лента пуста (окно открыли после удержания): запись берётся из данных вопроса.
    const known = knownRecordings([], { text: question, url: "/assets/q.ogg" });
    expect(bankAudiosForText(["GKH"], question, known)).toEqual([
      "/assets/q.ogg",
    ]);
    // Без записи у вопроса и в ленте — повтор текстом: чужим голосом не закрывается.
    expect(
      bankAudiosForText(["GKH"], question, knownRecordings([], null)),
    ).toBeNull();
  });

  it("доклады ленты — со своей записью", () => {
    const known = knownRecordings(
      [
        {
          id: "report-d",
          who: "peer",
          text: "Доклад.",
          report: true,
          replay: {
            kind: "report",
            deliveryId: "d",
            url: "/r.ogg",
            durationMs: 1,
          },
        },
        { id: "x", who: "peer", text: "Без записи." },
      ],
      { text: "Фраза банка.", url: null },
    );
    expect([...known]).toEqual([["Доклад.", "/r.ogg"]]);
  });
});

describe("снятие с удержания того же звонка (HQ-058)", () => {
  const talk: CallSnapshot = {
    ...base,
    state: "talking",
    inbound: true,
    peer: "Бригада",
  };
  function steps(...list: Partial<CallSnapshot>[]) {
    let lines = advanceLog([], null, talk);
    let prev = talk;
    const after: (readonly LogLine[])[] = [];
    for (const step of list) {
      const next = { ...prev, ...step };
      lines = advanceLog(lines, prev, next);
      after.push(lines);
      prev = next;
    }
    return after;
  }

  it("каждое снятие — своя строка фразы старшего, и второй повтор вопроса звучит снова", () => {
    const question = "Диспетчер, хозяева дома будут?";
    const [, first, , second, end] = steps(
      { state: "ended", held: true, duration: "0:10" },
      { state: "talking", held: false, resumed: question },
      { state: "ended", held: true, resumed: null, duration: "0:30" },
      { state: "talking", held: false, resumed: question },
      { state: "ended", byYou: true, resumed: null, duration: "0:50" },
    );
    const backs = (lines: readonly LogLine[]) =>
      lines.filter(
        (line) => line.who === "peer" && !line.id.startsWith(HELD_PREFIX),
      );
    // Новая (не сохранённая до удержания) строка — повтор вопроса, по одному на снятие.
    expect(backs(first!).map((line) => line.text)).toEqual([question]);
    expect(backs(second!).map((line) => line.text)).toEqual([question]);
    const firstId = backs(first!)[0]!.id;
    const secondId = backs(second!)[0]!.id;
    // Окно озвучивает строки, которых ещё не было (`voicedRef`): id второго повтора новый.
    expect(secondId).not.toBe(firstId);
    expect(first!.map((line) => line.id)).not.toContain(secondId);
    // Прежний повтор — в сохранённой части ленты; отбой после снятия попадает в ленту.
    expect(second!.filter((line) => line.text === question)).toHaveLength(2);
    expect(end!.at(-1)?.text).toBe("Вы положили трубку. Разговор 0:50");
  });
});
