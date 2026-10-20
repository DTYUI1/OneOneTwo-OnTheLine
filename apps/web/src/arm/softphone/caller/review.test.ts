import { describe, expect, it } from "vitest";
import type { components } from "../../../api-client/schema";
import { callerReview } from "./review";

type StoredEvent = components["schemas"]["StoredEvent"];

let clock = 0;
function said(slot: string, n = 1, book = "CALLER_CALM"): StoredEvent {
  clock += 1000;
  return {
    type: "caller_said",
    server_ts: new Date(clock).toISOString(),
    payload: { call_id: "c", phrase_id: `${book}.${slot}.animal_shaft.${n}` },
  } as unknown as StoredEvent;
}

describe("разбор: работа с заявителем (HQ-019)", () => {
  it("без звонка заявителю строк нет", () => {
    expect(callerReview([])).toBeNull();
  });

  it("выяснил срок и попросил подойти — одна строка", () => {
    expect(
      callerReview([said("answer"), said("tell_eta"), said("agree")]),
    ).toEqual([
      "Выяснили, когда заявитель подойдёт, и попросили подойти к бригаде.",
    ]);
  });

  it("паузы, отбой по тишине до срока, повтор и поправленный адрес", () => {
    const lines = callerReview([
      said("answer"),
      said("correct_address", 1),
      said("tell_where"),
      said("tell_where"),
      said("repeat", 2),
      said("no_reply", 1),
      said("no_reply", 2),
      said("hangup"),
    ]);
    expect(lines).toEqual([
      "Не выяснили, когда заявитель подойдёт: заявитель положил трубку.",
      "Не попросили заявителя подойти к бригаде.",
      "Пауза — заявитель переспросил «Алло, вы тут?»: 2 раза.",
      "Заявитель положил трубку, не дождавшись: 1 раз.",
      "Повтор вопроса: 1 раз.",
      "Адрес прочитан с ошибкой, заявитель поправил.",
    ]);
  });

  it("неполный ответ растерянной срока не даёт", () => {
    const lines = callerReview([
      said("answer", 1, "CALLER_CONFUSED"),
      said("tell_eta", 1, "CALLER_CONFUSED"),
      said("agree", 1, "CALLER_CONFUSED"),
    ]);
    expect(lines?.[0]).toBe("Не выяснили, когда заявитель подойдёт.");
    expect(lines).toContain("Попросили заявителя подойти к бригаде.");
  });
});
