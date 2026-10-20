import { describe, expect, it } from "vitest";
import type { components } from "../api-client/schema";
import {
  checkLabel,
  checksPending,
  formatLeft,
  secondsLeft,
  generationPercent,
  traineeCheckNote,
} from "./aiProgress";

type Evaluation = components["schemas"]["Evaluation"];

function evaluation(
  status: Evaluation["status"],
  ai_check: Evaluation["ai_check"] = null,
): Evaluation {
  return {
    id: "e",
    card_id: "c",
    trainee_id: "t",
    version: 1,
    status,
    total: 0.5,
    criteria: [],
    model_info: {},
    teacher_comment: "",
    ai_check,
  };
}

describe("время до конца генерации", () => {
  it("по скорости этого запуска: 2 задания за 10 с — ещё 2 за 10 с", () => {
    const start = { at: 0, completed: 0 };
    const last = { at: 10_000, completed: 2 };
    expect(secondsLeft(start, last, 4, 10_000)).toBe(10);
    expect(secondsLeft(start, last, 4, 14_000)).toBe(6);
    expect(secondsLeft(start, last, 4, 30_000)).toBe(0);
  });

  it("не обещает, пока не готово ни одно задание", () => {
    const start = { at: 0, completed: 1 };
    expect(secondsLeft(start, start, 4, 5_000)).toBeNull();
    expect(formatLeft(null)).toBe("оцениваем время…");
  });

  it("подпись: секунды — шагом 5, минуты — вверх", () => {
    expect(formatLeft(3)).toBe("почти готово");
    expect(formatLeft(12)).toBe("осталось ≈ 15 с");
    expect(formatLeft(61)).toBe("осталось ≈ 2 мин");
  });
});

describe("ИИ-проверка оценки", () => {
  it("преподаватель видит очередь, обучаемый — нет", () => {
    const queued = evaluation("partial", { state: "queued", ahead: 2 });
    expect(checkLabel(queued)).toBe("ждёт ИИ-проверки · впереди 2");
    expect(traineeCheckNote(queued)).toBe("ждёт ИИ-проверки");
    const running = evaluation("partial", { state: "running", ahead: 0 });
    expect(checkLabel(running)).toBe("ИИ проверяет…");
    expect(traineeCheckNote(running)).toBe("ИИ проверяет комментарий…");
  });

  it("готовая, неудачная и без ИИ", () => {
    expect(checkLabel(evaluation("complete"))).toBe("оценка готова");
    expect(
      checkLabel(evaluation("partial", { state: "failed", ahead: 0 })),
    ).toBe("ИИ-проверка не удалась");
    expect(checkLabel(evaluation("partial"))).toBe("предварительно");
    expect(traineeCheckNote(evaluation("partial"))).toBe("оценка уточняется");
  });

  it("чаще опрашиваем, только пока проверка идёт или ждёт", () => {
    expect(
      checksPending([evaluation("partial", { state: "queued", ahead: 1 })]),
    ).toBe(true);
    expect(
      checksPending([evaluation("partial", { state: "failed", ahead: 0 })]),
    ).toBe(false);
    expect(checksPending([evaluation("complete")])).toBe(false);
    expect(checksPending(undefined)).toBe(false);
  });
});

describe("первый сценарий", () => {
  it("время и полоса меняются до первого результата, но не достигают 100%", () => {
    const start = { at: 0, completed: 0 };
    expect(secondsLeft(start, start, 1, 0, 60)).toBe(60);
    expect(secondsLeft(start, start, 1, 15000, 60)).toBe(45);
    expect(generationPercent(start, start, 1, 15000, 60)).toBe(25);
    expect(generationPercent(start, start, 1, 120000, 60)).toBe(95);
    expect(
      generationPercent(start, { at: 120000, completed: 1 }, 1, 120000, 60),
    ).toBe(100);
  });
  it("после результата использует скорость текущего пакета", () => {
    const start = { at: 0, completed: 0 };
    const last = { at: 10000, completed: 1 };
    expect(secondsLeft(start, last, 3, 15000, 60)).toBe(15);
    expect(generationPercent(start, last, 3, 15000, 60)).toBe(50);
  });
});
