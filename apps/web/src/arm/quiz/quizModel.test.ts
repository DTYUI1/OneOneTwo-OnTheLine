import { describe, expect, it, vi } from "vitest";
import {
  loadMissed,
  pickQuiz,
  QUESTIONS,
  quizScore,
  remainingLabel,
  saveMissed,
  updateMissed,
  type QuizItem,
} from "./quizModel";

// Детерминированный генератор: тест не зависит от случайности.
const seeded = (seed: number) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

describe("тест «Проверь себя»", () => {
  it("у каждого вопроса верный вариант есть и источник — памятка", () => {
    for (const question of QUESTIONS) {
      expect(question.options[question.answer]).toBeTruthy();
      expect(question.source).toMatch(/^Памятка ДДС, стр\./);
    }
  });

  it("пять разных вопросов, верный вариант после перемешивания находится", () => {
    const quiz = pickQuiz(5, seeded(7));
    expect(new Set(quiz.map((item) => item.id)).size).toBe(5);
    for (const item of quiz)
      expect(item.shown[item.correct]).toBe(item.options[item.answer]);
    expect(quiz.some((item) => item.correct !== 0)).toBe(true);
  });

  it("считает верные ответы; без ответа — не засчитано", () => {
    const quiz = pickQuiz(3, seeded(3));
    const answers = [quiz[0].correct, null, (quiz[2].correct + 1) % 4];
    expect(quizScore(quiz, answers)).toBe(1);
  });
});

describe("повтор ошибок", () => {
  it("промахи идут первыми, остальное добирается случайно", () => {
    const quiz = pickQuiz(5, seeded(7), ["after-rejected", "primary-time"]);
    expect(quiz).toHaveLength(5);
    expect(
      quiz
        .slice(0, 2)
        .map((item) => item.id)
        .sort(),
    ).toEqual(["after-rejected", "primary-time"]);
    expect(new Set(quiz.map((item) => item.id)).size).toBe(5);
    for (const item of quiz)
      expect(item.shown[item.correct]).toBe(item.options[item.answer]);
  });

  it("без промахов — тот же набор при том же seed", () => {
    const ids = (quiz: QuizItem[]) => quiz.map((item) => item.id);
    expect(ids(pickQuiz(5, seeded(11), []))).toEqual(
      ids(pickQuiz(5, seeded(11))),
    );
    expect(pickQuiz(5, seeded(11), [])).toEqual(pickQuiz(5, seeded(11)));
  });

  it("после верного ответа промах уходит, новый промах добавляется", () => {
    const quiz = pickQuiz(3, seeded(5), ["primary-time"]);
    expect(quiz[0].id).toBe("primary-time");
    const answers = [
      quiz[0].correct,
      (quiz[1].correct + 1) % 4,
      quiz[2].correct,
    ];
    expect(updateMissed(["primary-time", "unknown"], quiz, answers)).toEqual([
      "unknown",
      quiz[1].id,
    ]);
  });

  it("ошибки хранятся в браузере, сбой хранилища не ломает тест", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    saveMissed(["primary-time"]);
    expect(loadMissed()).toEqual(["primary-time"]);
    saveMissed([]);
    expect(store.size).toBe(0);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadMissed()).toEqual([]);
    expect(() => saveMissed(["primary-time"])).not.toThrow();
    vi.unstubAllGlobals();
  });

  it("сколько вопросов осталось", () => {
    expect(remainingLabel([0, null, 1, null, 2], 5)).toBe("осталось 2");
    expect(remainingLabel([null, null], 2)).toBe("осталось 2");
  });
});
