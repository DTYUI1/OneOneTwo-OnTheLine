import { describe, expect, it } from "vitest";
import { lateAnswers, lostReports, type Callback } from "./callbacks";

const call = (over: Partial<Callback>): Callback => ({
  call_id: "c",
  brigade_id: "b",
  call_target_id: "t",
  started_at: "2026-09-27T10:00:00Z",
  answered_at: null,
  ended_at: null,
  ...over,
});
const END = Date.parse("2026-09-27T10:02:00Z");

describe("бригада ждала ответа", () => {
  it("ответ в пределах 30 с в разбор не попадает", () => {
    expect(
      lateAnswers([call({ answered_at: "2026-09-27T10:00:25Z" })], END),
    ).toEqual([]);
  });

  it("поздний ответ — сколько секунд ждала", () => {
    expect(
      lateAnswers([call({ answered_at: "2026-09-27T10:00:45Z" })], END),
    ).toMatchObject([{ waitS: 45, answered: true }]);
  });

  it("не ответили — ждала до конца вызова или до конца наблюдения", () => {
    expect(
      lateAnswers(
        [
          call({ call_id: "1", ended_at: "2026-09-27T10:01:00Z" }),
          call({ call_id: "2" }),
        ],
        END,
      ).map((wait) => [wait.callId, wait.waitS, wait.answered]),
    ).toEqual([
      ["1", 60, false],
      ["2", 120, false],
    ]);
  });
});

describe("потерянный доклад (TC-02)", () => {
  it("строка разбора — только второй пропуск подряд", () => {
    expect(
      lostReports([
        call({
          call_id: "1",
          ended_at: "2026-09-27T10:00:25Z",
          end_reason: "missed",
        }),
        call({
          call_id: "2",
          started_at: "2026-09-27T10:01:05Z",
          ended_at: "2026-09-27T10:01:30Z",
          end_reason: "lost",
        }),
        call({ call_id: "3", end_reason: null }),
      ]).map((wait) => [wait.callId, wait.waitS, wait.answered]),
    ).toEqual([["2", 25, false]]);
  });
});
