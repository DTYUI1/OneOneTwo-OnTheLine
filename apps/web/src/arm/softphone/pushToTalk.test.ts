import { afterEach, describe, expect, it, vi } from "vitest";
import {
  armRecheckMs,
  bankSpeechKey,
  cancelsRecording,
  EARLY_TALK_MS,
  isPushToTalk,
  ownsSpace,
  peerAlmostDone,
  peerLeftMs,
  pressOutcome,
  releaseOutcome,
  type KeyInput,
} from "./pushToTalk";

const space: KeyInput = {
  code: "Space",
  repeat: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
};

// Окружение vitest — node, DOM нет: цель события подменяет объект с `closest`.
class FakeElement {
  constructor(private readonly own: boolean) {}
  closest() {
    return this.own ? this : null;
  }
}

describe("пробел как push-to-talk", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("срабатывает по коду клавиши, а не по символу: русская раскладка не мешает", () => {
    expect(isPushToTalk({ ...space }, null)).toBe(true);
    // key в русской раскладке тот же, но и «Unidentified» не важен — решает code.
    expect(isPushToTalk({ ...space, code: "Space" }, null)).toBe(true);
    expect(isPushToTalk({ ...space, code: "KeyA" }, null)).toBe(false);
    expect(isPushToTalk({ ...space, code: "Enter" }, null)).toBe(false);
  });

  it("не срабатывает при удержании, с Ctrl, Alt и Meta, при вводе через IME", () => {
    expect(isPushToTalk({ ...space, repeat: true }, null)).toBe(false);
    expect(isPushToTalk({ ...space, ctrlKey: true }, null)).toBe(false);
    expect(isPushToTalk({ ...space, altKey: true }, null)).toBe(false);
    expect(isPushToTalk({ ...space, metaKey: true }, null)).toBe(false);
    expect(isPushToTalk({ ...space, isComposing: true }, null)).toBe(false);
    expect(isPushToTalk({ ...space, defaultPrevented: true }, null)).toBe(
      false,
    );
  });

  it("поле ввода и список оставляют пробел себе", () => {
    vi.stubGlobal("Element", FakeElement);
    const own = new FakeElement(true) as unknown as EventTarget;
    const free = new FakeElement(false) as unknown as EventTarget;
    expect(ownsSpace(own)).toBe(true);
    expect(isPushToTalk(space, own)).toBe(false);
    expect(ownsSpace(free)).toBe(false);
    expect(isPushToTalk(space, free)).toBe(true);
  });

  it("без DOM (цель не элемент) пробел не занят", () => {
    expect(ownsSpace(null)).toBe(false);
    expect(ownsSpace({} as EventTarget)).toBe(false);
  });
});

describe("говорить чуть раньше конца реплики и зажать заранее (HQ-052)", () => {
  it("ранее окно — секунда до конца реплики", () => {
    expect(EARLY_TALK_MS).toBe(1000);
    expect(peerAlmostDone(false, null)).toBe(true);
    expect(peerAlmostDone(true, 999)).toBe(true);
    expect(peerAlmostDone(true, 2500)).toBe(false);
    expect(peerAlmostDone(true, null)).toBe(false);
  });

  it("конец реплики — по самой длинной из звучащих; неизвестный — без раннего окна", () => {
    expect(peerLeftMs([])).toBe(0);
    expect(peerLeftMs([400, 2600])).toBe(2600);
    expect(peerLeftMs([400, null])).toBeNull();
  });

  it("нажатие во время реплики взводится, в последнюю секунду — запись сразу", () => {
    const at = (speaking: boolean, leftMs: number | null) =>
      pressOutcome({ idle: true, speaking, leftMs });
    expect(at(false, 0)).toBe("start");
    expect(at(true, 800)).toBe("start");
    expect(at(true, 3000)).toBe("arm");
    expect(at(true, null)).toBe("arm");
    expect(pressOutcome({ idle: false, speaking: true, leftMs: 3000 })).toBe(
      "ignore",
    );
  });

  it("взведённое нажатие проверяется к началу окна, а без известного конца — опросом", () => {
    expect(armRecheckMs(null)).toBe(200);
    expect(armRecheckMs(1100)).toBe(100);
    expect(armRecheckMs(5000)).toBe(200);
    expect(armRecheckMs(1000)).toBe(20);
  });

  it("запись, начатая в конце реплики, — ответ на неё: её остаток запись не гасит", () => {
    expect(
      cancelsRecording({
        recording: true,
        peer: ["bank:3"],
        startedOn: ["bank:3"],
      }),
    ).toBe(false);
    // Реплика кончилась — гасить нечего.
    expect(
      cancelsRecording({ recording: true, peer: [], startedOn: ["bank:3"] }),
    ).toBe(false);
  });

  it("«Как приняли?» после доклада не гасит запись, начатую в его последнюю секунду", () => {
    // Пробел зажат в конце доклада бригады; доклад смолк, лента спрашивает «Как приняли?».
    const startedOn = ["brigade:1"];
    expect(
      cancelsRecording({
        recording: true,
        peer: [bankSpeechKey(4, "brigade:1")],
        startedOn,
      }),
    ).toBe(false);
    // Вопрос бригады и обычная реплика ленты — новые реплики: запись гаснет.
    expect(
      cancelsRecording({ recording: true, peer: ["brigade:2"], startedOn }),
    ).toBe(true);
    expect(
      cancelsRecording({
        recording: true,
        peer: [bankSpeechKey(5, null)],
        startedOn,
      }),
    ).toBe(true);
    // Запись начата в тишине после доклада — «Как приняли?» для неё новая реплика.
    expect(
      cancelsRecording({
        recording: true,
        peer: [bankSpeechKey(4, "brigade:1")],
        startedOn: [],
      }),
    ).toBe(true);
  });

  it("новая реплика во время записи гасит её — фраза не уйдёт ответом на новый вопрос", () => {
    // Пробел зажат в конце доклада бригады, а бригада задала следующий вопрос.
    expect(
      cancelsRecording({
        recording: true,
        peer: ["brigade:2"],
        startedOn: ["brigade:1"],
      }),
    ).toBe(true);
    // Остаток прежней реплики ещё звучит, но заговорил и другой собеседник.
    expect(
      cancelsRecording({
        recording: true,
        peer: ["bank:3", "phone:5"],
        startedOn: ["bank:3"],
      }),
    ).toBe(true);
    // Следующая запись ленты — новая реплика, хотя лента звучит без паузы.
    expect(
      cancelsRecording({
        recording: true,
        peer: ["bank:4"],
        startedOn: ["bank:3"],
      }),
    ).toBe(true);
  });

  it("запись, начатая в тишине, гаснет, если собеседник заговорил (полудуплекс)", () => {
    expect(
      cancelsRecording({ recording: true, peer: ["phone:1"], startedOn: [] }),
    ).toBe(true);
    expect(cancelsRecording({ recording: true, peer: [], startedOn: [] })).toBe(
      false,
    );
    expect(
      cancelsRecording({ recording: false, peer: ["phone:1"], startedOn: [] }),
    ).toBe(false);
  });

  it("отпущенный до конца реплики пробел снимает нажатие, а не заканчивает запись", () => {
    expect(releaseOutcome({ armed: "space", recording: false })).toBe("disarm");
    expect(releaseOutcome({ armed: null, recording: true })).toBe("stop");
    expect(releaseOutcome({ armed: null, recording: false })).toBe(
      "stopWhenStarted",
    );
    // Взведено кнопкой — пробел его не снимает; запись, если идёт, заканчивается.
    expect(releaseOutcome({ armed: "button", recording: true })).toBe("stop");
  });
});
