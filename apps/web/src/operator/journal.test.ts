import { describe, expect, it } from "vitest";
import { startState, type AskResult } from "./dialog";
import {
  EMPTY_JOURNAL,
  clock,
  closeJournal,
  openingEvent,
  panicChange,
  passSteps,
  replyEvent,
} from "./journal";

const RESULT: AskResult = {
  state: { ...startState({ start_panic: 3 }), panic: 2, calm_reason: 1 },
  reply: {
    outcome: "calming",
    text: "Я... хорошо... я пытаюсь.",
    question_key: null,
    variant: null,
    voice: "fire_apartment_smoke/calming",
    mark: { kind: "good", text: "Просьба с причиной сработала." },
  },
  progress: { step: 1, done: [] },
};

describe("журнал звонка (этап 3)", () => {
  it("действие и ответ — одно событие: кто что сказал, исход, паника, пометка", () => {
    const event = replyEvent(
      7,
      { kind: "calm", calm: "reason" },
      "Я вам помогу.",
      startState({ start_panic: 3 }),
      RESULT,
    );
    expect(event).toEqual({
      t: 7,
      action: "calm",
      key: "reason",
      said: "Я вам помогу.",
      reply: "Я... хорошо... я пытаюсь.",
      outcome: "calming",
      panic_before: 3,
      panic_after: 2,
      mark: { kind: "good", text: "Просьба с причиной сработала." },
    });
    expect(panicChange(event)).toBe("Паника снизилась.");
  });

  it("первая реплика — событие с тем, как начался звонок", () => {
    const event = openingEvent("Алло!", 3);
    expect(event.mark).toEqual({
      kind: "info",
      text: "Звонок начался: заявитель в истерике.",
    });
    expect(panicChange(event)).toBe("");
  });

  it("шаг пройден — время первого раза, без повторов", () => {
    const first = passSteps([], [1], 20);
    expect(first).toEqual([{ step: 1, t: 20 }]);
    expect(passSteps(first, [1, 3, 2], 41)).toEqual([
      { step: 1, t: 20 },
      { step: 2, t: 41 },
      { step: 3, t: 41 },
    ]);
  });

  it("конец разговора дописывается один раз и не раньше последнего события", () => {
    const journal = {
      ...EMPTY_JOURNAL,
      events: [openingEvent("Алло!", 1), { t: 15, action: "hold" as const }],
    };
    // Часы страницы отстали на секунду — конец всё равно не раньше события.
    const closed = closeJournal(journal, 14, "Карточка сохранена.");
    expect(closed.events.at(-1)).toEqual({
      t: 15,
      action: "end",
      note: "Карточка сохранена.",
    });
    expect(closeJournal(closed, 30, "ещё раз")).toBe(closed);
  });

  it("время — мм:сс", () => {
    expect(clock(0)).toBe("00:00");
    expect(clock(95.7)).toBe("01:35");
  });
});
