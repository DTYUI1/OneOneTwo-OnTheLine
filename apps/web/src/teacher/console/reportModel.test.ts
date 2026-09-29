import { describe, expect, it } from "vitest";
import type { Evaluation, Session } from "./model";
import {
  attemptCounts,
  formatSeconds,
  formatShare,
  normShares,
  recommend,
  traineeLines,
  typicalErrors,
} from "./reportModel";

const crit = (key: string, score: number, critical = false) => ({
  key,
  score,
  weight: 1,
  critical,
  evidence: [],
  explanation: `объяснение ${key}`,
});

const evaluation = (
  trainee: string,
  total: number,
  criteria = [crit("routing", 1)],
  rules = "v1",
  status: Evaluation["status"] = "complete",
) =>
  ({
    id: Math.random().toString(),
    card_id: "c",
    trainee_id: trainee,
    total,
    criteria,
    model_info: { rules },
    status,
    teacher_comment: "",
    version: 1,
  }) as unknown as Evaluation;

const session = {
  participants: [
    { user_id: "u1", workstation_number: 1, dds_service_id: "102", level: 2 },
    { user_id: "u2", workstation_number: 2, dds_service_id: "101", level: 1 },
  ],
  settings_snapshot: { reaction_normative_s: 30, handling_normative_s: 180 },
} as unknown as Session;

describe("отчёт: счётчики попыток", () => {
  it("разделяет выданное, появившееся, закрытое и оценённое", () => {
    const counts = attemptCounts(
      5,
      [{ state: "completed" }, { state: "refused" }, { state: "accepted" }],
      [
        evaluation("u1", 0.8),
        evaluation("u1", 0, [], "unavailable:T-006"),
        evaluation("u2", 0.5, [crit("call", 0, true)], "v1", "partial"),
      ],
    );
    expect(counts).toEqual({
      assigned: 5,
      appeared: 3,
      closed: 2,
      scored: 2,
      partial: 1,
      unscored: 0,
    });
  });
});

describe("отчёт: строки по обучаемым", () => {
  it("без оценённых попыток — null, а не ноль", () => {
    const lines = traineeLines(
      session,
      {
        trainees: [
          {
            user_id: "u2",
            full_name: "Обучаемый 02",
            workstation_number: 2,
            total: 0,
            reaction_time_s: 0,
            handling_time_s: 0,
            errors: 0,
            level: 1,
          },
        ],
      },
      [evaluation("u2", 0, [], "unavailable:T-006")],
      () => "…",
    );
    expect(lines[1]).toMatchObject({
      total: null,
      reactionS: null,
      errors: null,
    });
  });

  it("берёт балл и время сервера и сравнивает с нормативом снимка", () => {
    const lines = traineeLines(
      session,
      {
        trainees: [
          {
            user_id: "u1",
            full_name: "Обучаемый 01",
            workstation_number: 1,
            total: 0.5,
            reaction_time_s: 42,
            handling_time_s: 150,
            errors: 2,
            level: 2,
          },
        ],
      },
      [
        evaluation("u1", 0.5, [
          crit("routing", 1),
          crit("call", 0, true),
          crit("address", 0.5),
        ]),
      ],
      () => "…",
    );
    expect(lines[0]).toMatchObject({
      total: 0.5,
      reactionDeltaS: 12,
      handlingDeltaS: -30,
      errors: 2,
    });
    expect(lines[0].weak.map((item) => item.key)).toEqual(["call", "address"]);
  });
});

describe("отчёт: типичные ошибки", () => {
  it("один знаменатель — оценённые попытки; заглушки не считаются", () => {
    const errors = typicalErrors([
      evaluation("u1", 0.5, [crit("call", 0, true), crit("address", 1)]),
      evaluation("u2", 0.7, [crit("call", 0.5), crit("address", 0.5)]),
      evaluation("u2", 0, [crit("call", 0)], "unavailable:T-006"),
    ]);
    expect(errors[0]).toMatchObject({
      key: "call",
      attempts: 2,
      of: 2,
      critical: 1,
    });
    expect(errors[1]).toMatchObject({ key: "address", attempts: 1, of: 2 });
  });
});

describe("отчёт: рекомендация сложности", () => {
  it("холодный старт при одной попытке", () => {
    expect(recommend(2, [evaluation("u1", 0.9)]).kind).toBe("cold");
  });
  it("выше при стабильных 80 %+ без критических", () => {
    expect(
      recommend(2, [evaluation("u1", 0.9), evaluation("u1", 0.85)]),
    ).toMatchObject({ kind: "up", level: 3 });
  });
  it("ниже при критической ошибке, но не ниже первого", () => {
    const critical = [
      evaluation("u1", 0.9),
      evaluation("u1", 0.7, [crit("call", 0, true)]),
    ];
    expect(recommend(3, critical)).toMatchObject({ kind: "down", level: 2 });
    expect(recommend(1, critical)).toMatchObject({ kind: "keep", level: 1 });
  });
  it("не выше четвёртого", () => {
    expect(
      recommend(4, [evaluation("u1", 0.95), evaluation("u1", 0.9)]),
    ).toMatchObject({ kind: "keep", level: 4 });
  });
});

describe("отчёт: формат времени", () => {
  it("минуты и секунды со знаком", () => {
    expect(formatSeconds(125.4)).toBe("2:05");
    expect(formatSeconds(-30)).toBe("−0:30");
  });
});

describe("нормы как доля карточек", () => {
  it("считает карточки в нормативе и зачтённые; без оценки — не в счёт", () => {
    const shares = normShares([
      evaluation("u1", 0.95, [
        crit("reaction_time", 1),
        crit("handling_time", 1),
      ]),
      evaluation("u1", 0.45, [
        crit("reaction_time", 0.2),
        crit("call", 0, true),
      ]),
      evaluation("u2", 0.8, [crit("reaction_time", 1)]),
    ]);
    expect(shares.reaction).toEqual({ ok: 2, total: 3 });
    expect(shares.handling).toEqual({ ok: 1, total: 1 });
    expect(shares.passed).toEqual({ ok: 2, total: 3 });
    expect(formatShare(shares.reaction)).toBe("67 %");
    expect(formatShare({ ok: 0, total: 0 })).toBe("—");
  });

  it("новый балл преподавателя снимает флаг ошибки и в отчёте", () => {
    const failed = evaluation("u1", 0.8, [crit("call", 0, true)]);
    expect(normShares([failed]).passed.ok).toBe(0);
    expect(
      normShares([failed], new Map([[failed.card_id, 0.8]])).passed.ok,
    ).toBe(1);
  });
});
