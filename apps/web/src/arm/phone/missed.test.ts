import { describe, expect, it } from "vitest";
import type { components } from "../../api-client/schema";
import { missedCalls } from "./missed";

type CardTraining = components["schemas"]["CardTraining"];
type Callback = NonNullable<CardTraining["callbacks"]>[number];
type Evidence = CardTraining["messages"][number];

const at = (s: number) =>
  new Date(Date.UTC(2026, 9, 17, 10, 0, s)).toISOString();

function callback(
  id: string,
  startS: number,
  rest: Partial<Callback> = {},
): Callback {
  return {
    call_id: id,
    brigade_id: "b1",
    call_target_id: "t1",
    started_at: at(startS),
    answered_at: null,
    ended_at: at(startS + 25),
    end_reason: "missed",
    ...rest,
  };
}

function heard(presentedS: number | null, brigade = "b1"): Evidence {
  return {
    delivery: {
      delivery_id: `d-${presentedS}`,
      card_id: "c",
      call_id: "x",
      participant_id: "p",
      brigade_id: brigade,
      call_target_id: "t1",
      message: { id: "m", version: 1, text: "Выехали.", audio: null },
      delivered_at: at(0),
    },
    state: presentedS === null ? "delivered" : "presented",
    presented_at: presentedS === null ? null : at(presentedS),
    failed_at: null,
    presentation_event_id: null,
    failure_reason: null,
  };
}

describe("Пропущенные вызовы бригад (TC-02)", () => {
  it("не ответили за 25 с — пропущенный, пока доклад не услышан", () => {
    expect(
      missedCalls({ callbacks: [callback("c1", 0)], messages: [heard(null)] }),
    ).toEqual([
      {
        callId: "c1",
        brigadeId: "b1",
        targetId: "t1",
        endedAt: Date.parse(at(25)),
        lost: false,
      },
    ]);
  });

  it("второй пропуск того же доклада — «потерян», строка одна", () => {
    const list = missedCalls({
      callbacks: [
        callback("c1", 0),
        callback("c2", 65, { end_reason: "lost" }),
      ],
      messages: [],
    });
    expect(list.map((item) => [item.callId, item.lost])).toEqual([
      ["c2", true],
    ]);
  });

  it("перезвон отдал доклад — пропущенного больше нет", () => {
    expect(
      missedCalls({ callbacks: [callback("c1", 0)], messages: [heard(40)] }),
    ).toEqual([]);
    // Доклад, услышанный раньше пропуска, пропущенный не закрывает.
    expect(
      missedCalls({ callbacks: [callback("c1", 30)], messages: [heard(10)] }),
    ).toHaveLength(1);
  });

  it("бригада звонит снова или с ней уже говорили — строки нет", () => {
    expect(
      missedCalls({
        callbacks: [callback("c1", 0)],
        messages: [],
        incoming: [
          {
            call_id: "c2",
            brigade_id: "b1",
            call_target_id: "t1",
            started_at: at(65),
          },
        ],
      }),
    ).toEqual([]);
    expect(
      missedCalls({
        callbacks: [
          callback("c1", 0),
          callback("c2", 65, {
            answered_at: at(70),
            ended_at: at(90),
            end_reason: null,
          }),
        ],
        messages: [],
      }),
    ).toEqual([]);
  });

  it("погашенный и прерванный вызов — не пропущенный; старый сервер — пусто", () => {
    expect(
      missedCalls({
        callbacks: [
          callback("c1", 0, { end_reason: "report_heard" }),
          callback("c2", 0, {
            brigade_id: "b2",
            end_reason: "session_finished",
          }),
          callback("c3", 0, { brigade_id: "b3", end_reason: undefined }),
        ],
        messages: [],
      }),
    ).toEqual([]);
    expect(missedCalls({ messages: [] })).toEqual([]);
  });
});
