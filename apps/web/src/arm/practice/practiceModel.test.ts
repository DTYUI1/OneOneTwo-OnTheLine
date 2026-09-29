import { describe, expect, it } from "vitest";
import type { components } from "../../api-client/schema";
import { pickPracticeCard, practiceRunning } from "./practiceModel";

type Card = components["schemas"]["Card"];

const card = (patch: Partial<Card>): Card =>
  ({
    id: "card-1",
    session_id: "practice-1",
    closed_at: null,
    interrupted_at: null,
    ...patch,
  }) as Card;

describe("запуск тренировки", () => {
  const ids = new Set(["practice-1"]);

  it("идёт только при открытой карточке тренировки", () => {
    expect(practiceRunning([card({})], ids)).toBe(true);
    expect(
      practiceRunning([card({ closed_at: "2026-09-29T10:00:00Z" })], ids),
    ).toBe(false);
    expect(
      practiceRunning([card({ interrupted_at: "2026-09-29T10:00:00Z" })], ids),
    ).toBe(false);
  });

  it("карточка занятия преподавателя тренировкой не считается", () => {
    expect(practiceRunning([card({ session_id: "lesson-1" })], ids)).toBe(
      false,
    );
    expect(practiceRunning([], ids)).toBe(false);
  });

  it("находит карточку запущенной тренировки", () => {
    const cards = [
      card({ id: "old", session_id: "practice-0" }),
      card({ id: "new", session_id: "practice-1" }),
    ];
    expect(pickPracticeCard(cards, "practice-1")?.id).toBe("new");
    expect(pickPracticeCard(cards, "practice-2")).toBeUndefined();
  });
});
