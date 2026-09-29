import { describe, expect, it } from "vitest";
import {
  advanceLog,
  type CallSnapshot,
  endNote,
  quickPhrases,
  youSaid,
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

  it("без изменений возвращает ту же ленту", () => {
    const lines = advanceLog([], null, base);
    expect(advanceLog(lines, base, base)).toBe(lines);
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
    reporting: true,
    inbound: false,
    withBrigade: false,
    refusal: false,
    textReport: false,
  };

  it("службе — «У меня всё», пока идёт доклад", () => {
    expect(quickPhrases(talk).map((item) => item.id)).toEqual(["done"]);
    expect(quickPhrases({ ...talk, reporting: false })).toEqual([]);
  });

  it("бригаде — «Принял» только для текстового доклада", () => {
    expect(quickPhrases({ ...talk, withBrigade: true })).toEqual([]);
    expect(
      quickPhrases({ ...talk, withBrigade: true, textReport: true }).map(
        (item) => item.id,
      ),
    ).toEqual(["ack"]);
  });

  it("при отказе и вне разговора фраз нет", () => {
    expect(quickPhrases({ ...talk, refusal: true })).toEqual([]);
    expect(quickPhrases({ ...talk, state: "ringing" })).toEqual([]);
  });

  it("реплика диспетчера дописывается в ленту", () => {
    expect(youSaid([], "Принял.")).toEqual([
      { id: "you-0", who: "you", text: "Принял." },
    ]);
  });
});
