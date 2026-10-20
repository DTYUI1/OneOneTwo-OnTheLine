import { beforeEach, describe, expect, it } from "vitest";
import {
  claimSignal,
  dueSignal,
  LATE_SIGNAL_S,
  normText,
  REMIND_BEFORE_S,
  remindDue,
  resetSignals,
  urgencyStage,
  urgencyText,
  WARN_BEFORE_S,
  type UrgencySignal,
} from "./urgency";

// TC-06: три стадии норматива на порогах 70 % и 100 % и по одному сигналу на карточку.

describe("стадии норматива", () => {
  it("норматив 30 с: до 70 % спокойно, с 21 с — «скоро», после 30 с — «сверх»", () => {
    expect(urgencyStage(0, 30)).toBe("calm");
    expect(urgencyStage(20, 30)).toBe("calm");
    expect(urgencyStage(21, 30)).toBe("soon"); // ровно 70 %
    expect(urgencyStage(24, 30)).toBe("soon");
    expect(urgencyStage(30, 30)).toBe("soon"); // ровно 100 % — ещё в норме
    expect(urgencyStage(31, 30)).toBe("over");
    expect(urgencyStage(41, 30)).toBe("over");
  });

  it("порог 70 % считается по любому нормативу", () => {
    // 3 мин = 180 с: 70 % = 126 с.
    expect(urgencyStage(125, 180)).toBe("calm");
    expect(urgencyStage(126, 180)).toBe("soon");
    expect(urgencyStage(180, 180)).toBe("soon");
    expect(urgencyStage(181, 180)).toBe("over");
    // 10 с: 70 % = 7 с.
    expect(urgencyStage(6, 10)).toBe("calm");
    expect(urgencyStage(7, 10)).toBe("soon");
  });

  it("решение общего расчёта C-02 о просрочке главнее секунд", () => {
    expect(urgencyStage(12, 30, true)).toBe("over");
  });

  it("подписи: «0:24 · скоро норматив», «0:41 · сверх норматива»", () => {
    expect(urgencyText("0:03", "calm")).toBe("0:03");
    expect(urgencyText("0:24", "soon")).toBe("0:24 · скоро норматив");
    expect(urgencyText("0:41", "over")).toBe("0:41 · сверх норматива");
  });
});

describe("сигналы срочности", () => {
  beforeEach(() => resetSignals());

  it("«осталось 10 с» — на 20-й секунде из 30, «просрочено» — на 31-й", () => {
    const none = new Set<UrgencySignal>();
    expect(dueSignal(19, 30, none)).toBeNull();
    expect(dueSignal(20, 30, none)).toBe("warn");
    expect(dueSignal(30, 30, none)).toBeNull(); // позже окна опоздания
    expect(dueSignal(30, 30, new Set<UrgencySignal>(["warn"]))).toBeNull();
    expect(dueSignal(31, 30, none)).toBe("over");
  });

  it("у короткого норматива «осталось 10 с» подаётся сразу", () => {
    expect(dueSignal(0, 8, new Set<UrgencySignal>())).toBe("warn");
  });

  it("каждый сигнал — один раз на карточку, дальше тишина", () => {
    const heard: (UrgencySignal | null)[] = [];
    for (let seconds = 0; seconds <= 60; seconds += 1)
      heard.push(claimSignal("card-a", seconds, 30));
    expect(heard.filter((signal) => signal === "warn")).toHaveLength(1);
    expect(heard.filter((signal) => signal === "over")).toHaveLength(1);
    expect(heard.indexOf("warn")).toBe(20);
    expect(heard.indexOf("over")).toBe(31);
    // Повторная перерисовка той же секунды — тишина.
    expect(claimSignal("card-a", 31, 30)).toBeNull();
  });

  it("у каждой карточки свои сигналы", () => {
    expect(claimSignal("card-a", 20, 30)).toBe("warn");
    expect(claimSignal("card-b", 20, 30)).toBe("warn");
    expect(claimSignal("card-a", 21, 30)).toBeNull();
  });

  it("карточка, открытая после порога, не пищит: сигнал нужен в момент порога", () => {
    expect(claimSignal("late", 25 + LATE_SIGNAL_S, 30)).toBeNull();
    expect(claimSignal("late", 300, 30)).toBeNull();
  });

  it("перескок через «осталось 10 с» сразу к «просрочено» — один сигнал", () => {
    expect(claimSignal("jump", 32, 30)).toBe("over");
    expect(claimSignal("jump", 33, 30)).toBeNull();
    expect(claimSignal("jump", 20, 30)).toBeNull();
  });
});

describe("наставник напоминает о нормативе", () => {
  it("за 18 с до конца — раньше двойного бипа «осталось 10 с»", () => {
    expect(REMIND_BEFORE_S).toBeGreaterThan(WARN_BEFORE_S);
    expect(remindDue(11, 30)).toBe(false);
    expect(remindDue(12, 30)).toBe(true);
    // И дальше, пока «Принята» ждёт, — в том числе сверх норматива.
    expect(remindDue(45, 30)).toBe(true);
  });

  it("текст — с нормативом карточки; при 30 с есть запись голоса", () => {
    expect(normText(30)).toBe(
      "Обратите внимание: на «Принята» — 30 секунд. Это строгая норма диспетчера ДДС.",
    );
    expect(normText(21)).toContain("21 секунда.");
    expect(normText(22)).toContain("22 секунды.");
  });
});
