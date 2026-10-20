import { describe, expect, it } from "vitest";
import type { components } from "../../api-client/schema";
import {
  compareSummary,
  compareWithExpert,
  compareWithReference,
  movesOf,
  type Moves,
} from "./compare";

type StoredEvent = components["schemas"]["StoredEvent"];

const T0 = "2026-10-12T10:00:00Z";
let seq = 0;
function event(type: string, s: number, payload: object = {}): StoredEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    type,
    payload,
    server_ts: new Date(Date.parse(T0) + s * 1000).toISOString(),
  } as unknown as StoredEvent;
}

const events = [
  event("open", 2),
  event("status_change", 12, { state: "accepted", comment: "x" }),
  event("brigades_select", 20, { brigade_ids: [] }),
  event("call_dial", 25, { call_id: "c1", phone_ext: "101" }),
  event("call_hangup", 50, { call_id: "c1" }),
  event("hint_open", 55, { hint_id: "tutor:action" }),
  event("hint_open", 56, { hint_id: "help" }),
  event("hint_open", 57, { hint_id: "show:brigades" }),
  event("status_change", 80, { state: "completed", comment: "y" }),
];

describe("«Как сделал бы опытный» — ход по журналу", () => {
  it("время от показа карточки, статусы и помощь", () => {
    expect(movesOf(events, T0, "101")).toEqual({
      reaction: 12,
      dispatched: 20,
      reported: 50,
      path: "Принята → Работы завершены",
      helps: 2,
    });
  });

  it("звонок не своей службе — не доклад", () => {
    expect(movesOf(events, T0, "103").reported).toBeNull();
  });

  const pro: Moves = {
    reaction: 5,
    dispatched: 9,
    reported: 30,
    path: "Принята → Работы завершены",
    helps: 0,
  };

  it("с опытным: разошлись, где позже больше чем на 20 с или не сделано", () => {
    const rows = compareWithExpert(
      { ...pro, reaction: 20, dispatched: 40, reported: null, helps: 1 },
      pro,
    );
    expect(rows.map((row) => [row.title, row.diff])).toEqual([
      ["«Принята»", false],
      ["Бригада направлена", true],
      ["Статусы", false],
      ["Помощь", true],
    ]);
    expect(rows[1].mine).toBe("00:40");
    expect(compareSummary(rows)).toBe("разошлись в 2 местах");
    expect(compareSummary(compareWithExpert(pro, pro))).toBe(
      "ваш ход совпал с опытным",
    );
  });

  it("с эталоном сценария: норматив, бригада, доклад, статусы оценщика", () => {
    const rows = compareWithReference(
      { ...pro, reaction: 40 },
      {
        reactionNormative: 30,
        path: "Получена службой → Принята → Начало реагирования",
        fact: "Принята → Начало реагирования",
        pathOk: false,
        callRequired: false,
      },
    );
    expect(rows.map((row) => row.title)).toEqual([
      "«Принята»",
      "Бригада направлена",
      "Статусы",
      "Помощь",
    ]);
    expect(rows[0]).toMatchObject({ pro: "не дольше 00:30", diff: true });
    expect(rows[2]).toMatchObject({
      mine: "Принята → Начало реагирования",
      diff: true,
    });
    expect(compareSummary(rows.slice(0, 1))).toBe("разошлись в 1 месте");
  });

  it("эталон без реагирования — строки о бригаде нет", () => {
    const rows = compareWithReference(pro, {
      reactionNormative: 30,
      path: "Не принята",
      fact: "Не принята",
      pathOk: true,
      callRequired: true,
    });
    expect(rows.map((row) => row.title)).toEqual([
      "«Принята»",
      "Доклад своей службе",
      "Статусы",
      "Помощь",
    ]);
  });
});
