import { beforeEach, describe, expect, it } from "vitest";
import {
  conventions,
  doneStages,
  expertCardFor,
  expertSource,
  introSeen,
  linkExpertCard,
  markIntroSeen,
  markStageDone,
  needsCheck,
  nextStage,
  sessionMode,
  sessionStage,
  setExpertSource,
  setSessionStage,
  stepOneNote,
  setSessionMode,
  timeLine,
} from "./stages";

// В vitest без DOM localStorage нет: этапы живут в памяти страницы (как в приватном окне).
describe("этапы обучения", () => {
  beforeEach(() => {
    setSessionMode("s-reset", "solo");
  });

  it("окно «Как устроено обучение» — один раз", () => {
    expect(introSeen("u1")).toBe(false);
    markIntroSeen("u1");
    expect(introSeen("u1")).toBe(true);
  });

  it("окно обучения и ✓ этапов — свои у каждого пользователя (проверка 20.10)", () => {
    markIntroSeen("u-a");
    markStageDone("u-a", "together");
    expect(introSeen("u-b")).toBe(false);
    expect([...doneStages("u-b")]).toEqual([]);
    expect([...doneStages("u-a")]).toEqual(["together"]);
  });

  it("следующий этап — первый непройденный, потом «Сам»", () => {
    expect(nextStage(new Set())).toBe("watch");
    expect(nextStage(new Set(["watch"]))).toBe("together");
    expect(nextStage(new Set(["watch", "together", "solo"]))).toBe("solo");
    markStageDone("u1", "watch");
    markStageDone("u1", "watch");
    expect([...doneStages("u1")]).toEqual(["watch"]);
  });

  it("ступень 1 — зачтётся после «Вместе» или «Сам»; дальше — повторение (20.10)", () => {
    expect(stepOneNote(undefined)).toContain("зачтётся");
    expect(stepOneNote(undefined)).toContain("«Смотрю» — показ");
    expect(stepOneNote(2)).toContain("уже зачтена");
  });

  it("«Сам» этапа отличается от обычной тренировки: этап помнится по занятию", () => {
    expect(sessionStage("s-stage")).toBeNull();
    setSessionStage("s-stage", "solo");
    expect(sessionStage("s-stage")).toBe("solo");
  });

  it("режим занятия тренировки: без записи — «Сам»", () => {
    expect(sessionMode("s1")).toBe("solo");
    setSessionMode("s1", "watch");
    expect(sessionMode("s1")).toBe("watch");
  });

  it("показ опытного связан с карточкой обучаемого", () => {
    setExpertSource("s2", "mine");
    expect(expertSource("s2")).toBe("mine");
    expect(expertCardFor("mine")).toBeNull();
    linkExpertCard("mine", "pro");
    expect(expertCardFor("mine")).toBe("pro");
  });

  it("проверка — перед «Не принята», «Отказ», «Работы завершены»", () => {
    expect(["rejected", "refused", "completed"].every(needsCheck)).toBe(true);
    expect(
      ["accepted", "responding", "arrived", "working"].some(needsCheck),
    ).toBe(false);
  });

  it("знак сжатия времени: коэффициент приложения, во «Вместе» — мир ждёт", () => {
    expect(timeLine(true, false)).toContain("примерно в 100 раз");
    expect(timeLine(false, false)).toContain("примерно в 10 раз");
    expect(timeLine(true, true)).toMatch(/^Мир ждёт вас/);
    expect(conventions(30).map((item) => item.head)).toEqual([
      "Связь службы упрощена.",
      "Время сжато.",
      "Служба 101 — допущение.",
      "Скрытых вопросов с подвохом нет.",
    ]);
    expect(conventions(30)[1].text).toContain("на «Принята» — 30 секунд");
  });
});
