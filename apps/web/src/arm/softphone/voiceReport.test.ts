import { describe, expect, it } from "vitest";
import { pickMimeType } from "./phraseRecorder";
import {
  accessProblem,
  afterPhrase,
  canStartRecording,
  CHECK_NOTE,
  choicesShown,
  earlierText,
  environmentProblem,
  loudnessNote,
  MAX_VOICE_FAILURES,
  micStatus,
  problemNote,
  recognitionOutcome,
  speechLevel,
  unclearNote,
  type PhraseState,
} from "./voiceReport";

const READY = { secureContext: true, mediaDevices: true, mediaRecorder: true };

describe("доклад голосом: окружение", () => {
  it("пишет, когда есть всё", () => {
    expect(environmentProblem(READY)).toBeNull();
  });

  it("называет причину, почему голосом нельзя", () => {
    expect(environmentProblem({ ...READY, mediaRecorder: false })).toBe(
      "no_recorder",
    );
    expect(environmentProblem({ ...READY, secureContext: false })).toBe(
      "insecure",
    );
  });

  it("отличает отсутствие микрофона от запрета доступа", () => {
    expect(accessProblem({ name: "NotFoundError" })).toBe("no_device");
    expect(accessProblem({ name: "NotAllowedError" })).toBe("denied");
    expect(accessProblem(new Error("сбой"))).toBe("denied");
  });

  it("сообщение по-русски ведёт к вариантам, а при «только голос» — к преподавателю", () => {
    expect(problemNote("denied", false)).toBe(
      "Нет доступа к микрофону: браузер его не разрешил. Доложите вариантом ответа.",
    );
    expect(problemNote("no_device", true)).toContain("сообщите преподавателю");
    expect(problemNote("no_device", true)).not.toContain("вариантом");
  });

  it("выбирает формат записи из контрактного списка", () => {
    expect(pickMimeType((type) => type === "audio/ogg")).toBe("audio/ogg");
    expect(pickMimeType(() => false)).toBeUndefined();
  });
});

describe("доклад голосом: ответ распознавания", () => {
  it("расслышанная фраза несёт вид доклада по сведениям", () => {
    expect(
      recognitionOutcome(200, {
        text: " ДТП на Дубнинской ",
        choice: "no_who",
        parts: ["change"],
      }),
    ).toEqual({
      kind: "heard",
      text: "ДТП на Дубнинской",
      choice: "no_who",
      parts: ["change"],
      loudness: null,
      spellStreet: null,
      addressGap: null,
    });
  });

  it("чего не хватило в адресе и поводе — из ответа сервера", () => {
    const outcome = recognitionOutcome(200, {
      text: "Варшавское шоссе 87",
      choice: "no_who",
      parts: [],
      address_gap: "reason",
    });
    expect(outcome.kind === "heard" && outcome.addressGap).toBe("reason");
  });

  it("похожая улица из ответа сервера — переспрос по буквам (TC-03)", () => {
    expect(
      recognitionOutcome(200, {
        text: "Дубнинская, дом один",
        choice: "no_who",
        parts: ["address"],
        spell_street: "Дубининская улица",
      }),
    ).toMatchObject({ kind: "heard", spellStreet: "Дубининская улица" });
  });

  it("сервер без частей — части по виду доклада", () => {
    expect(
      recognitionOutcome(200, { text: "доклад", choice: "no_card" }),
    ).toMatchObject({ parts: ["who", "address", "change"] });
  });

  it("пусто или сбой — не расслышано", () => {
    expect(recognitionOutcome(200, { text: " ", choice: null })).toEqual({
      kind: "unclear",
    });
    expect(recognitionOutcome(200, { text: " ", choice: "full" })).toEqual({
      kind: "unclear",
    });
    expect(recognitionOutcome(500, undefined)).toEqual({ kind: "unclear" });
    expect(recognitionOutcome(0, undefined)).toEqual({ kind: "unclear" });
  });

  it("речь есть, уверенность низкая — текст на проверку, а не «не расслышано» (TC-04)", () => {
    expect(
      recognitionOutcome(200, { text: " Дубнинская 12 ", choice: null }),
    ).toEqual({ kind: "check", text: "Дубнинская 12" });
  });

  it("распознавание выключено на сервере — голосом не доложить", () => {
    expect(recognitionOutcome(503, undefined)).toEqual({ kind: "off" });
  });
});

describe("доклад голосом: когда предлагать варианты", () => {
  const base = { voiceOnly: false, problem: null, failures: 0, opened: false };

  it("сначала голос, варианты свёрнуты", () => {
    expect(choicesShown(base)).toBe(false);
    expect(choicesShown({ ...base, opened: true })).toBe(true);
  });

  it("после двух неудач или без микрофона варианты раскрываются сами", () => {
    expect(choicesShown({ ...base, failures: MAX_VOICE_FAILURES - 1 })).toBe(
      false,
    );
    expect(choicesShown({ ...base, failures: MAX_VOICE_FAILURES })).toBe(true);
    expect(choicesShown({ ...base, problem: "denied" })).toBe(true);
    expect(choicesShown({ ...base, problem: "server_off" })).toBe(true);
  });

  it("«только голос» — вариантов нет ни при каких условиях", () => {
    expect(
      choicesShown({
        voiceOnly: true,
        problem: "denied",
        failures: 5,
        opened: true,
      }),
    ).toBe(false);
  });

  it("после неудачи — повтор голосом, после второй — варианты", () => {
    expect(unclearNote(1, false)).toBe("Повторите доклад голосом.");
    expect(unclearNote(2, false)).toContain("Выберите вариант доклада");
    expect(unclearNote(2, true)).not.toContain("вариант");
  });
});

describe("доклад голосом: индикатор громкости", () => {
  const tone = (amplitude: number) =>
    Array.from({ length: 512 }, (_, i) => amplitude * Math.sin(i / 3));

  it("тишина — ноль, громкая речь — полная шкала", () => {
    expect(speechLevel([])).toBe(0);
    expect(speechLevel(new Array(512).fill(0))).toBe(0);
    expect(speechLevel(tone(0.0005))).toBe(0);
    expect(speechLevel(tone(1))).toBe(1);
  });

  it("тихая речь видна, громче — выше", () => {
    const quiet = speechLevel(tone(0.01));
    const normal = speechLevel(tone(0.1));
    expect(quiet).toBeGreaterThan(0.2);
    expect(normal).toBeGreaterThan(quiet);
    expect(normal).toBeLessThan(1);
  });
});

describe("доклад голосом: громкость фразы", () => {
  it("громкость с сервера доходит до итога фразы", () => {
    const body = {
      text: "Доклад",
      choice: "full",
      parts: [],
      loudness: "quiet",
    } as const;
    const outcome = recognitionOutcome(200, body);
    expect(outcome.kind === "heard" && outcome.loudness).toBe("quiet");
    const old = recognitionOutcome(200, { text: "Доклад", choice: "full" });
    expect(old.kind === "heard" && old.loudness).toBeNull();
  });

  it("подсказывает громче или тише, в норме молчит", () => {
    expect(loudnessNote("quiet")).toMatch(/громче/);
    expect(loudnessNote("loud")).toMatch(/громко/);
    expect(loudnessNote("ok")).toBeNull();
    expect(loudnessNote(null)).toBeNull();
  });
});

describe("доклад голосом: проверка неуверенно распознанного (TC-04)", () => {
  const start: PhraseState = { failures: 0, draft: null };

  it("подсказка у поля — как в разборе touches.md", () => {
    expect(CHECK_NOTE).toBe("Проверьте адрес и нажмите Enter");
  });

  it("переспрос не штрафуется: проверка не растит счётчик и не раскрывает варианты", () => {
    const checked = afterPhrase(start, { kind: "check", text: "Дубнинская" });
    expect(checked).toEqual({ failures: 0, draft: "Дубнинская" });
    // Сколько бы раз ни переспросили, «голос не распознан» в отбое не появится.
    let state = start;
    for (let i = 0; i < 5; i += 1)
      state = afterPhrase(state, { kind: "check", text: "Дубнинская" });
    expect(state.failures).toBe(0);
    expect(
      choicesShown({
        voiceOnly: false,
        problem: null,
        failures: state.failures,
        opened: false,
      }),
    ).toBe(false);
  });

  it("штрафует только фраза без речи; расслышанная убирает поле", () => {
    const empty = afterPhrase(start, { kind: "unclear" });
    expect(empty).toEqual({ failures: 1, draft: null });
    const heard = afterPhrase(
      { failures: 1, draft: "Дубнинская" },
      {
        kind: "heard",
        text: "Дубнинская 12",
        choice: "no_who",
        parts: ["address"],
        loudness: null,
        spellStreet: null,
        addressGap: null,
      },
    );
    expect(heard).toEqual({ failures: 1, draft: null });
    expect(afterPhrase(start, { kind: "off" })).toBe(start);
  });
});

describe("статус микрофона словами и полудуплекс (TC-04)", () => {
  it.each([
    [0, "Идёт запись · 0 / 10 с"],
    [4100, "Идёт запись · 4 / 10 с"],
    [9999, "Идёт запись · 9 / 10 с"],
    [10_000, "Идёт запись · 10 / 10 с"],
    [12_000, "Идёт запись · 10 / 10 с"],
    [-100, "Идёт запись · 0 / 10 с"],
  ])("показывает время текущей записи %s мс из лимита", (elapsed, label) => {
    expect(micStatus("recording", false, false, elapsed)).toBe(label);
  });
  it("называет, что делает микрофон", () => {
    expect(micStatus("recording", false)).toBe("слушаю");
    expect(micStatus("recognizing", false)).toBe("распознаю…");
    expect(micStatus("idle", true)).toBe("собеседник говорит");
    expect(micStatus("idle", false)).toBeNull();
  });

  it("запись идёт, только пока собеседник молчит", () => {
    expect(canStartRecording("idle", false)).toBe(true);
    expect(canStartRecording("idle", true)).toBe(false);
    expect(canStartRecording("recording", false)).toBe(false);
    expect(canStartRecording("recognizing", false)).toBe(false);
  });

  it("за секунду до конца реплики говорить уже можно (HQ-052)", () => {
    expect(canStartRecording("idle", true, 1000)).toBe(true);
    expect(canStartRecording("idle", true, 300)).toBe(true);
    expect(canStartRecording("idle", true, 1001)).toBe(false);
    // Конец реплики неизвестен — только по её концу.
    expect(canStartRecording("idle", true, null)).toBe(false);
    expect(canStartRecording("recognizing", true, 200)).toBe(false);
  });

  it("взведённое нажатие видно словами, пока собеседник говорит", () => {
    expect(micStatus("idle", true, true)).toBe("запись начнётся после реплики");
    expect(micStatus("idle", false, true)).toBeNull();
    expect(micStatus("recording", true, true)).toBe("слушаю");
  });
});

describe("доклад за звонок", () => {
  it("прежние фразы уходят на сервер одним текстом", () => {
    expect(earlierText([])).toBeNull();
    expect(earlierText([" ", ""])).toBeNull();
    expect(
      earlierText([
        "Варшавское шоссе 87 горит автомобиль.",
        "Обучаемый 0.1. Служба 102",
      ]),
    ).toBe("Варшавское шоссе 87 горит автомобиль. Обучаемый 0.1. Служба 102");
  });
});
