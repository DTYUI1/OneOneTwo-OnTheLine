import { describe, expect, it } from "vitest";
import {
  ANSWER_AFTER_MS,
  type Effect,
  initialModel,
  reduce,
  RING_AFTER_MS,
  type SoftphoneEvent,
  type SoftphoneModel,
  talkDurationMs,
} from "./machine";

function run(
  events: readonly SoftphoneEvent[],
  from: SoftphoneModel = initialModel,
): { model: SoftphoneModel; effects: Effect[] } {
  let model = from;
  const effects: Effect[] = [];
  for (const event of events) {
    const next = reduce(model, event);
    model = next.model;
    effects.push(...next.effects);
  }
  return { model, effects };
}

const dial = (digits = "102"): SoftphoneEvent[] => [
  ...[...digits].map((digit) => ({ type: "digit", digit }) as const),
  { type: "dial", callId: "call-1", at: 1000 },
];

const answered = [
  ...dial(),
  { type: "ring" } as const,
  { type: "answer", at: 5000 } as const,
];

describe("Набор номера", () => {
  it("копит ровно три цифры и не берёт посторонние символы", () => {
    const { model } = run([
      ...[..."102"].map((digit) => ({ type: "digit", digit }) as const),
      { type: "digit", digit: "a" },
    ]);
    expect(model.dialed).toBe("102");
  });

  it("цифра после полного номера начинает новый номер", () => {
    const { model } = run(
      [..."2031"].map((digit) => ({ type: "digit", digit }) as const),
    );
    expect(model.state).toBe("idle");
    expect(model.dialed).toBe("1");
  });

  it("правится посимвольно и очищается целиком", () => {
    expect(run([...dial("10"), { type: "backspace" }]).model.dialed).toBe("1");
    expect(run([...dial("10"), { type: "clear" }]).model.dialed).toBe("");
  });

  it("не звонит, пока номер неполный", () => {
    const { model, effects } = run(dial("10"));
    expect(model.state).toBe("idle");
    expect(effects).toEqual([]);
  });

  it("на полном номере уходит call_dial и начинается соединение", () => {
    const { model, effects } = run(dial());
    expect(model.state).toBe("dialing");
    expect(model.phoneExt).toBe("102");
    expect(model.callId).toBe("call-1");
    expect(effects).toEqual([
      { type: "send", event: "call_dial" },
      { type: "tone", tone: "click" },
      { type: "wait", event: "ring", delayMs: RING_AFTER_MS },
    ]);
  });

  it("не мешает набрать чужую службу — адресат звонка оценивается", () => {
    expect(run(dial("106")).model.phoneExt).toBe("106");
  });
});

describe("Ход звонка", () => {
  it.each(["dialing", "ringing", "talking", "closing"])(
    "завершение занятия останавливает %s без новых действий сервера",
    (phase) => {
      const events: SoftphoneEvent[] = [...dial()];
      if (phase !== "dialing") events.push({ type: "ring" });
      if (phase === "talking" || phase === "closing")
        events.push({ type: "answer", at: 5000 });
      if (phase === "closing") events.push({ type: "report", at: 6000 });
      const active = run(events).model;
      const stopped = reduce(active, { type: "suspend", at: 7000 });
      expect(stopped.model).toMatchObject({
        state: "ended",
        callId: active.callId,
      });
      expect(
        stopped.effects.filter((effect) =>
          ["send", "wait", "voice"].includes(effect.type),
        ),
      ).toEqual([]);
      expect(stopped.effects).toContainEqual({ type: "tone", tone: "stop" });
      expect(
        reduce(stopped.model, { type: "answer", at: 8000 }).effects,
      ).toEqual([]);
      expect(
        reduce(stopped.model, { type: "voice_done", at: 8000 }).effects,
      ).toEqual([]);
    },
  );

  it("проходит idle → dialing → ringing → talking → ended", () => {
    const states: string[] = [];
    let model = initialModel;
    for (const event of [
      ...answered,
      { type: "report", at: 30000 } as const,
      { type: "voice_done", at: 33000 } as const,
    ]) {
      model = reduce(model, event).model;
      states.push(model.state);
    }
    expect(states.at(-1)).toBe("ended");
    expect([...new Set(states)]).toEqual([
      "idle",
      "dialing",
      "ringing",
      "talking",
      "ended",
    ]);
  });

  it("включает КПВ и ждёт ответа абонента", () => {
    const { effects } = run([...dial(), { type: "ring" }]);
    expect(effects).toContainEqual({ type: "tone", tone: "ringback" });
    expect(effects).toContainEqual({
      type: "wait",
      event: "answer",
      delayMs: ANSWER_AFTER_MS,
    });
  });

  it("на ответе глушит КПВ, шлёт call_answer и даёт реплику — без записи", () => {
    const { model, effects } = run(answered);
    expect(model.state).toBe("talking");
    expect(model.phase).toBe("reporting");
    expect(model.talkStartedAt).toBe(5000);
    expect(effects.slice(-3)).toEqual([
      { type: "tone", tone: "stop" },
      { type: "send", event: "call_answer" },
      { type: "voice", phrase: "listen" },
    ]);
  });

  it("полный доклад закрывает разговор ответной репликой службы", () => {
    const { model, effects } = run([
      ...answered,
      { type: "report", at: 30000 },
    ]);
    expect(model.state).toBe("talking");
    expect(model.phase).toBe("closing");
    expect(effects.slice(-1)).toEqual([{ type: "voice", phrase: "accepted" }]);
  });

  it("«Положить трубку» без доклада кладёт сразу, приём не подтверждается", () => {
    const { model, effects } = run([
      ...answered,
      { type: "finish", at: 30000 },
    ]);
    expect(model.state).toBe("ended");
    expect(effects).toContainEqual({ type: "send", event: "call_hangup" });
    expect(effects).not.toContainEqual({ type: "voice", phrase: "accepted" });
  });

  it("отбой наступает после реплики, вместе с ним уходит hangup", () => {
    const { model, effects } = run([
      ...answered,
      { type: "report", at: 30000 },
      { type: "voice_done", at: 33000 },
    ]);
    expect(model.state).toBe("ended");
    expect(model.endedAt).toBe(33000);
    expect(model.aborted).toBe(false);
    expect(effects.slice(-3)).toEqual([
      { type: "tone", tone: "click" },
      { type: "send", event: "call_hangup" },
      { type: "tone", tone: "stop" },
    ]);
  });

  it("считает длительность разговора от ответа до отбоя", () => {
    const { model } = run([
      ...answered,
      { type: "report", at: 30000 },
      { type: "voice_done", at: 33000 },
    ]);
    expect(talkDurationMs(model, 99999)).toBe(28000);
    expect(talkDurationMs(initialModel, 99999)).toBe(0);
  });
});

describe("Обрывы и повторы", () => {
  it("сброс до ответа гасит КПВ и всё равно сообщает об отбое", () => {
    const { model, effects } = run([
      ...dial(),
      { type: "ring" },
      { type: "finish", at: 4000 },
    ]);
    expect(model.state).toBe("ended");
    expect(model.aborted).toBe(true);
    expect(effects.slice(-2)).toEqual([
      { type: "send", event: "call_hangup" },
      { type: "tone", tone: "stop" },
    ]);
  });

  it("сервер закрывает разговор — звук гаснет", () => {
    const { model, effects } = run([
      ...answered,
      { type: "server", state: "ended", at: 40000 },
    ]);
    expect(model.state).toBe("ended");
    expect(model.aborted).toBe(false);
    expect(effects.slice(-1)).toEqual([{ type: "tone", tone: "stop" }]);
  });

  it("сервер закрывает звонок до ответа — это обрыв, а не разговор", () => {
    const { model } = run([
      ...dial(),
      { type: "ring" },
      { type: "server", state: "ended", at: 4000 },
    ]);
    expect(model.aborted).toBe(true);
    expect(model.talkStartedAt).toBeNull();
  });

  it("опоздавший call.state не поднимает уже закрытый звонок", () => {
    const closed = run([
      ...answered,
      { type: "report", at: 30000 },
      { type: "voice_done", at: 33000 },
    ]).model;
    for (const state of ["dialing", "ringing", "talking"] as const)
      expect(reduce(closed, { type: "server", state, at: 40000 })).toEqual({
        model: closed,
        effects: [],
      });
  });

  it("«положить трубку», пока служба подтверждает доклад, не шлёт второй hangup", () => {
    const closing = run([...answered, { type: "report", at: 30000 }]).model;
    expect(reduce(closing, { type: "finish", at: 31000 })).toEqual({
      model: closing,
      effects: [],
    });
  });

  it("повторный доклад после полного ничего не меняет", () => {
    const closing = run([...answered, { type: "report", at: 30000 }]).model;
    expect(reduce(closing, { type: "report", at: 31000 })).toEqual({
      model: closing,
      effects: [],
    });
  });

  it("реплика без закрытого доклада ничего не завершает", () => {
    const talking = run(answered).model;
    expect(reduce(talking, { type: "voice_done", at: 31000 })).toEqual({
      model: talking,
      effects: [],
    });
  });

  it("цифры во время разговора не набираются", () => {
    const talking = run(answered).model;
    expect(reduce(talking, { type: "digit", digit: "1" }).model).toEqual(
      talking,
    );
  });

  it("после завершённого звонка новый номер набирается без отдельного сброса", () => {
    const { model, effects } = run([
      ...answered,
      { type: "report", at: 30000 },
      { type: "voice_done", at: 33000 },
      { type: "clear" },
      ...dial("103"),
    ]);
    expect(model.state).toBe("dialing");
    expect(model.phoneExt).toBe("103");
    expect(model.endedAt).toBeNull();
    expect(effects.at(-3)).toEqual({ type: "send", event: "call_dial" });
  });
});

describe("Входящий вызов бригады (27.09)", () => {
  const pickup: SoftphoneEvent = {
    type: "pickup",
    callId: "inbound-1",
    phoneExt: "501",
    at: 1000,
  };

  it("ответ — сразу разговор: без набора, гудков и «Слушаю»", () => {
    const { model, effects } = run([pickup]);
    expect(model).toMatchObject({
      state: "talking",
      callId: "inbound-1",
      phoneExt: "501",
      inbound: true,
      talkStartedAt: 1000,
    });
    expect(effects).toEqual([
      { type: "tone", tone: "click" },
      { type: "send", event: "call_answer" },
    ]);
  });

  it("бригаде вариантов доклада нет: report на входящем ничего не делает", () => {
    const talking = run([pickup]).model;
    expect(reduce(talking, { type: "report", at: 2000 }).effects).toEqual([]);
  });

  it("трубка кладётся одной кнопкой, без ответной реплики службы", () => {
    const { model, effects } = run([pickup, { type: "finish", at: 5000 }]);
    expect(model.state).toBe("ended");
    expect(effects).toContainEqual({ type: "send", event: "call_hangup" });
    expect(effects).not.toContainEqual({ type: "voice", phrase: "accepted" });
  });

  it("во время своего разговора входящий не перехватывает линию", () => {
    const talking = run([
      { type: "digit", digit: "1" },
      { type: "digit", digit: "0" },
      { type: "digit", digit: "2" },
      { type: "dial", callId: "out-1", at: 0 },
    ]).model;
    expect(reduce(talking, pickup).model.callId).toBe("out-1");
  });

  it("после входящего новый набор снова исходящий", () => {
    const ended = run([pickup, { type: "finish", at: 5000 }]).model;
    const next = run(
      [
        { type: "digit", digit: "1" },
        { type: "digit", digit: "0" },
        { type: "digit", digit: "2" },
        { type: "dial", callId: "out-2", at: 6000 },
      ],
      ended,
    ).model;
    expect(next).toMatchObject({ state: "dialing", inbound: false });
  });
});

describe("Удержание линии (TC-02)", () => {
  const pickup: SoftphoneEvent = {
    type: "pickup",
    callId: "inbound-1",
    phoneExt: "201",
    at: 1000,
  };

  it("на удержание — линия свободна, отбой на сервер не уходит", () => {
    const { model, effects } = run([pickup, { type: "hold", at: 4000 }]);
    expect(model).toMatchObject({
      state: "ended",
      held: true,
      callId: "inbound-1",
      endedAt: 4000,
    });
    expect(effects).not.toContainEqual({ type: "send", event: "call_hangup" });
    expect(effects.at(-1)).toEqual({ type: "tone", tone: "stop" });
  });

  it("пока линия на удержании, отвечают на второй вызов", () => {
    const held = run([pickup, { type: "hold", at: 4000 }]).model;
    const { model, effects } = run(
      [{ type: "pickup", callId: "inbound-2", phoneExt: "202", at: 4100 }],
      held,
    );
    expect(model).toMatchObject({
      state: "talking",
      callId: "inbound-2",
      held: false,
      inbound: true,
    });
    expect(effects).toContainEqual({ type: "send", event: "call_answer" });
  });

  it("снятие с удержания — сразу разговор, без call_answer и гудков", () => {
    const second = run([
      pickup,
      { type: "hold", at: 4000 },
      { type: "pickup", callId: "inbound-2", phoneExt: "202", at: 4100 },
      { type: "finish", at: 9000 },
    ]).model;
    const { model, effects } = run(
      [
        {
          type: "resume",
          callId: "inbound-1",
          phoneExt: "201",
          at: 9500,
          inbound: true,
        },
      ],
      second,
    );
    expect(model).toMatchObject({
      state: "talking",
      phase: "reporting",
      callId: "inbound-1",
      phoneExt: "201",
      resumed: true,
      held: false,
      talkStartedAt: 9500,
      inbound: true,
    });
    expect(effects).toEqual([{ type: "tone", tone: "click" }]);
  });

  it("служба снята с удержания — дежурный снова отвечает, доклад продолжается", () => {
    const service = run(answered).model;
    const held = reduce(service, { type: "hold", at: 6000 }).model;
    expect(held).toMatchObject({ state: "ended", held: true });
    const { model, effects } = run(
      [
        {
          type: "resume",
          callId: "call-1",
          phoneExt: "103",
          at: 9000,
          answer: true,
        },
      ],
      held,
    );
    expect(model).toMatchObject({
      state: "talking",
      phase: "reporting",
      callId: "call-1",
      inbound: false,
      resumed: true,
    });
    expect(effects).toEqual([
      { type: "tone", tone: "click" },
      { type: "voice", phrase: "listen" },
    ]);
    expect(effects).not.toContainEqual({ type: "send", event: "call_answer" });
  });

  it("снятый с удержания разговор кладётся обычным отбоем", () => {
    const { effects } = run([
      { type: "resume", callId: "inbound-1", phoneExt: "201", at: 0 },
      { type: "finish", at: 5000 },
    ]);
    expect(effects).toContainEqual({ type: "send", event: "call_hangup" });
  });

  it("не перехватывает идущий разговор и прощание службы", () => {
    const talking = run(answered).model;
    expect(
      reduce(talking, {
        type: "resume",
        callId: "inbound-1",
        phoneExt: "201",
        at: 6000,
      }).model.callId,
    ).toBe("call-1");
    const closing = reduce(talking, { type: "report", at: 6000 }).model;
    expect(reduce(closing, { type: "hold", at: 6500 }).model).toBe(closing);
    expect(reduce(initialModel, { type: "hold", at: 0 }).model).toBe(
      initialModel,
    );
  });
});

describe("Отказ ненаправленной бригады (28.09)", () => {
  const refused = [
    ...[..."204"].map((digit) => ({ type: "digit", digit }) as const),
    {
      type: "dial",
      callId: "call-2",
      at: 1000,
      refusal: "not_assigned",
    } as const,
    { type: "ring" } as const,
    { type: "answer", at: 5000 } as const,
  ];

  it("звонок уходит как обычный — номер бригады не запрещён", () => {
    const { model, effects } = run(refused.slice(0, 4));
    expect(model.state).toBe("dialing");
    expect(model.refusal).toBe("not_assigned");
    expect(effects).toContainEqual({ type: "send", event: "call_dial" });
  });

  it("бригада отвечает отказом без «Слушаю» и без доклада", () => {
    const { model, effects } = run(refused);
    expect(model.state).toBe("talking");
    expect(model.phase).toBe("closing");
    expect(effects).toContainEqual({ type: "send", event: "call_answer" });
    expect(effects).toContainEqual({ type: "voice", phrase: "not_assigned" });
    expect(effects).not.toContainEqual({ type: "voice", phrase: "listen" });
    expect(reduce(model, { type: "report", at: 6000 }).effects).toEqual([]);
  });

  it("после отказа бригада сама кладёт трубку", () => {
    const { model, effects } = run([
      ...refused,
      { type: "voice_done", at: 7000 },
    ]);
    expect(model.state).toBe("ended");
    expect(model.aborted).toBe(false);
    expect(effects).toContainEqual({ type: "send", event: "call_hangup" });
    expect(effects).not.toContainEqual({ type: "voice", phrase: "accepted" });
  });

  it("следующий набор — снова обычный звонок", () => {
    const { model } = run([
      ...refused,
      { type: "voice_done", at: 7000 },
      ...dial("203"),
    ]);
    expect(model.refusal).toBeNull();
  });
});
