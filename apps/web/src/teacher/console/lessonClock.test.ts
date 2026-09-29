import { describe, expect, it } from "vitest";
import {
  everyoneDone,
  formatLessonDuration,
  latestRunning,
  lessonDurationS,
} from "./lessonClock";

const T0 = Date.parse("2026-09-27T10:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

describe("длительность занятия для преподавателя", () => {
  it("черновик ещё не идёт", () => {
    expect(
      lessonDurationS({ started_at: null, finished_at: null }, T0),
    ).toBeNull();
  });

  it("идущее считается до «сейчас», завершённое — до завершения", () => {
    expect(
      lessonDurationS({ started_at: at(0), finished_at: null }, T0 + 725_000),
    ).toBe(725);
    expect(
      lessonDurationS(
        { started_at: at(0), finished_at: at(2700) },
        T0 + 86_400_000,
      ),
    ).toBe(2700);
  });

  it("формат ч:мм:сс — без предела 99:59", () => {
    expect(formatLessonDuration(0)).toBe("0:00:00");
    expect(formatLessonDuration(725)).toBe("0:12:05");
    expect(formatLessonDuration(4 * 3600 + 5)).toBe("4:00:05");
  });
});

describe("какое идущее занятие показывать", () => {
  it("самое позднее по старту, а не первое в ответе сервера", () => {
    const sessions = [
      { id: "old", status: "running" as const, started_at: at(-86_400) },
      { id: "draft", status: "draft" as const, started_at: null },
      { id: "new", status: "running" as const, started_at: at(0) },
      { id: "done", status: "finished" as const, started_at: at(60) },
    ];
    expect(latestRunning(sessions)?.id).toBe("new");
  });

  it("идущих нет — нет и выбора", () => {
    expect(
      latestRunning([{ status: "finished" as const, started_at: at(0) }]),
    ).toBeUndefined();
  });
});

describe("все обучаемые закончили", () => {
  const attempt = { card_id: "c-1" } as never;

  it("идёт, назначений не осталось — пора завершать", () => {
    expect(
      everyoneDone({
        status: "running",
        remaining_assignments: 0,
        attempts: [attempt],
      }),
    ).toBe(true);
  });

  it("кто-то ещё работает — не предлагаем", () => {
    expect(
      everyoneDone({
        status: "running",
        remaining_assignments: 1,
        attempts: [attempt],
      }),
    ).toBe(false);
  });

  it("завершённое занятие повторно не завершаем", () => {
    expect(
      everyoneDone({
        status: "finished",
        remaining_assignments: 0,
        attempts: [attempt],
      }),
    ).toBe(false);
  });
});
