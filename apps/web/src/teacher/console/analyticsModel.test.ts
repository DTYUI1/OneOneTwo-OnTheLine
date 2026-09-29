import { describe, expect, it } from "vitest";
import {
  attemptOwner,
  errorSummary,
  finishSummary,
  openLayers,
  traineeTime,
  type AttemptAnalysis,
} from "./analyticsModel";

const attempt = (
  participant: string,
  reaction: number | null,
  active: number | null,
) =>
  ({
    participant_id: participant,
    timing: {
      timing_version: 3,
      reaction_s: reaction,
      active_handling_s: active,
      handling_s: active,
    },
    evaluation: {
      layers: [
        { layer: "rules", status: "done" },
        { layer: "llm", status: "pending" },
        { layer: "address", status: "unavailable" },
      ],
    },
  }) as unknown as AttemptAnalysis;

describe("аналитика занятия", () => {
  it("ошибки: только измеренные и ненулевые, словами", () => {
    expect(
      errorSummary({
        input: null,
        address: 1,
        grammar: null,
        routing: 0,
        status_flow: 0,
        timing: null,
        call: 2,
      }),
    ).toEqual(["адрес: 1", "звонок: 2"]);
  });

  it("время: достоверное среднее сервера — как есть", () => {
    expect(
      traineeTime(
        { user_id: "u", mean_reaction_s: 12, mean_handling_s: 90 },
        [],
        "reaction",
      ),
    ).toEqual({ seconds: 12, estimated: false, values: [] });
  });

  it("время: одна оценочная попытка — её значение с пометкой", () => {
    const t = traineeTime(
      { user_id: "u", mean_reaction_s: null, mean_handling_s: null },
      [attempt("u", 8.2, 4.5), attempt("x", 99, 99)],
      "handling",
    );
    expect(t).toEqual({ seconds: 4.5, estimated: true, values: [4.5] });
  });

  it("время: несколько оценочных — без усреднения на экране", () => {
    const t = traineeTime(
      { user_id: "u", mean_reaction_s: null, mean_handling_s: null },
      [attempt("u", 8, 1), attempt("u", 20, 2)],
      "reaction",
    );
    expect(t).toEqual({ seconds: null, estimated: true, values: [8, 20] });
  });

  it("чей заход — по карточке, а не по внутреннему ID участия", () => {
    const owner = attemptOwner([{ id: "card-1", trainee_id: "user-7" }]);
    const internal = { ...attempt("participation-9", 5, 5), card_id: "card-1" };
    expect(owner(internal as AttemptAnalysis)).toBe("user-7");
    const t = traineeTime(
      { user_id: "user-7", mean_reaction_s: null, mean_handling_s: null },
      [internal as AttemptAnalysis],
      "reaction",
      owner,
    );
    expect(t?.seconds).toBe(5);
  });

  it("время: нет измерений — null, а не ноль", () => {
    expect(
      traineeTime(
        { user_id: "u", mean_reaction_s: null, mean_handling_s: null },
        [attempt("u", null, null)],
        "reaction",
      ),
    ).toBeNull();
  });

  it("предварительная оценка: какие слои ещё не готовы", () => {
    expect(openLayers(attempt("u", 1, 1))).toEqual([
      "ИИ-оценка текста — ожидает",
    ]);
  });
});

describe("finishSummary", () => {
  it("прерванные завершением — с владельцем по карточке и состоянием записи", () => {
    const summary = finishSummary(
      {
        cancelled_assignment_ids: ["a-1", "a-2"],
        attempts: [
          {
            card_id: "card-1",
            participant_id: "participation-9",
            status: "interrupted",
            interrupted_at: "2026-09-25T10:00:00.000Z",
            active_call_id: null,
            recording_status: "upload_pending",
          },
          {
            card_id: "card-2",
            participant_id: "participation-9",
            status: "completed",
            interrupted_at: null,
            active_call_id: null,
            recording_status: "none",
          },
        ],
      },
      [{ id: "card-1", trainee_id: "user-7" }],
    );
    expect(summary.cancelled).toBe(2);
    expect(summary.interrupted).toEqual([
      {
        cardId: "card-1",
        traineeId: "user-7",
        at: "2026-09-25T10:00:00.000Z",
        recording: "запись ещё выгружается",
      },
    ]);
  });
});
