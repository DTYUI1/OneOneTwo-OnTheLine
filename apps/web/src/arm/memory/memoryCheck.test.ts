import { describe, expect, it } from "vitest";
import {
  MEMORY_AFTER_MS,
  MEMORY_LATEST_MS,
  memoryCheckDue,
  memoryCheckFinal,
  memoryEventTitle,
  memoryScore,
  memoryText,
  optionVerdict,
  pick,
  type MemoryQuestion,
} from "./memoryCheck";

const T = 1_000_000;
const shift = { appearedMs: [T, T + 20_000, T + 40_000], expected: 3 };
const last = T + 40_000;

describe("когда показать проверку памяти (HQ-033)", () => {
  it("после всех карточек смены и минуты после последней", () => {
    const at = (now: number, extra = {}) =>
      memoryCheckDue({
        ...shift,
        openCount: 3,
        now,
        talking: false,
        ringing: false,
        ...extra,
      });
    expect(at(last + MEMORY_AFTER_MS - 1)).toBe(false);
    expect(at(last + MEMORY_AFTER_MS)).toBe(true);
    // Пришли не все карточки или все закрыты — не показываем.
    expect(at(last + MEMORY_AFTER_MS, { expected: 4 })).toBe(false);
    expect(at(last + MEMORY_AFTER_MS, { openCount: 0 })).toBe(false);
  });

  it("ждёт конца разговора, но не дольше срока", () => {
    const busy = (now: number) =>
      memoryCheckDue({
        ...shift,
        openCount: 1,
        now,
        talking: true,
        ringing: false,
      });
    expect(busy(last + MEMORY_AFTER_MS)).toBe(false);
    expect(busy(last + MEMORY_LATEST_MS)).toBe(true);
  });

  it("пока звонят (тревога, вызов) — ждёт, но не дольше срока", () => {
    const ring = (now: number, talking = false) =>
      memoryCheckDue({ ...shift, openCount: 1, now, talking, ringing: true });
    expect(ring(last + MEMORY_AFTER_MS)).toBe(false);
    expect(ring(last + MEMORY_LATEST_MS - 1)).toBe(false);
    // Звонки внахлёст: линия свободной не бывает — после срока окно появляется всё равно
    // (оно не модальное, телефон поверх него).
    expect(ring(last + MEMORY_LATEST_MS)).toBe(true);
    expect(ring(last + MEMORY_LATEST_MS * 3, true)).toBe(true);
  });
});

describe("отказ сервера в вопросах", () => {
  it("окончательный — только когда проверки в смене не будет", () => {
    expect(memoryCheckFinal({ code: "session_not_running" })).toBe(true);
    expect(memoryCheckFinal({ code: "memory_check_unavailable" })).toBe(true);
    // Карточек ещё нет на сервере, сбой, нет ответа — спросим ещё раз.
    expect(memoryCheckFinal({ code: "memory_check_early" })).toBe(false);
    expect(memoryCheckFinal({ detail: "Internal Server Error" })).toBe(false);
    expect(memoryCheckFinal(undefined)).toBe(false);
  });
});

describe("выбор вариантов", () => {
  const single: MemoryQuestion = {
    key: "free_brigades",
    text: "Сколько?",
    options: ["0", "1", "2"],
    multiple: false,
  };
  const many: MemoryQuestion = {
    key: "on_scene",
    text: "Какие?",
    options: ["Бригада 1", "Бригада 2", "Ни одна"],
    multiple: true,
  };

  it("один ответ заменяется, «все верные» переключаются", () => {
    expect(pick(single, ["0"], "2")).toEqual(["2"]);
    expect(pick(many, ["Бригада 1"], "Бригада 2")).toEqual([
      "Бригада 1",
      "Бригада 2",
    ]);
    expect(pick(many, ["Бригада 1", "Бригада 2"], "Бригада 1")).toEqual([
      "Бригада 2",
    ]);
  });

  it("последний вариант исключает остальные", () => {
    expect(pick(many, ["Бригада 1"], "Ни одна")).toEqual(["Ни одна"]);
    expect(pick(many, ["Ни одна"], "Бригада 2")).toEqual(["Бригада 2"]);
  });

  it("после ответа: верные зелёные, выбранные неверно — красные", () => {
    expect(optionVerdict(["1"], ["2"], "1")).toBe("ok");
    expect(optionVerdict(["1"], ["2"], "2")).toBe("bad");
    expect(optionVerdict(["1"], ["2"], "0")).toBeNull();
  });
});

describe("итог в разборе и у преподавателя", () => {
  const answer = {
    type: "memory_check_answer",
    payload: { answers: [["1"], ["Ни одна"], []], score: 2, total: 3 },
  };

  it("читает «N из 3» из журнала карточки", () => {
    expect(memoryScore([{ type: "open", payload: {} }])).toBeNull();
    const result = memoryScore([{ type: "open", payload: {} }, answer]);
    expect(result).toEqual({ score: 2, total: 3 });
    expect(memoryText(result!)).toBe("Проверка памяти: 2 из 3");
  });

  it("строки ленты: показ с вопросами и ответ с выбранным", () => {
    expect(
      memoryEventTitle({
        type: "memory_check",
        payload: { questions: [{ text: "Сколько?" }, { text: "Какие?" }] },
      }),
    ).toEqual({ title: "Проверка памяти показана", detail: "Сколько? Какие?" });
    expect(memoryEventTitle(answer)).toEqual({
      title: "Проверка памяти: 2 из 3",
      detail: "1 · Ни одна · —",
    });
    expect(memoryEventTitle({ type: "open", payload: {} })).toBeNull();
  });
});
