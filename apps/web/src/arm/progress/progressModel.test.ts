import { describe, expect, it } from "vitest";
import {
  attemptProgressLine,
  barWidth,
  cards,
  nextAction,
  remaining,
  stepState,
  type StepProgress,
} from "./progressModel";

const step = (patch: Partial<StepProgress>): StepProgress => ({
  number: 2,
  title: "Своя карточка",
  skill: "Принять, отметить этапы, доложить, завершить",
  required: 3,
  attempts: 0,
  streak: 0,
  passed: false,
  unlocked: true,
  ...patch,
});

describe("мой путь", () => {
  it("состояние ступени", () => {
    expect(stepState(step({ passed: true }), 3)).toBe("passed");
    expect(stepState(step({ unlocked: false }), 1)).toBe("locked");
    expect(stepState(step({}), 2)).toBe("current");
    expect(stepState(step({}), 3)).toBe("open");
  });

  it("что осталось — словами", () => {
    expect(remaining(step({ streak: 2 }))).toBe(
      "Зачтено подряд 2 из 3: осталось 1 карточка без критических ошибок.",
    );
    expect(remaining(step({ streak: 0 }))).toMatch(/осталось 3 карточки/);
    expect(remaining(step({ unlocked: false }))).toBe(
      "Откроется, когда будет пройдена ступень 1.",
    );
    expect(remaining(step({ number: 1, required: 1 }))).toMatch(/Зачтено/);
  });
});

describe("что дальше на пути", () => {
  const path = (patches: Partial<StepProgress>[]) =>
    patches.map((patch, index) =>
      step({ number: index + 1, unlocked: index === 0, ...patch }),
    );

  it("выбирает текущую ступень", () => {
    const steps = path([{ passed: true }, { unlocked: true }, {}, {}]);
    const next = nextAction(steps);
    expect(next).toEqual({ step: steps[1], done: false });
    expect(stepState(next.step, 2)).toBe("current");
  });

  it("всё пройдено — закреплять на ступени 4", () => {
    const steps = path([
      { passed: true },
      { passed: true, unlocked: true },
      { passed: true, unlocked: true },
      { passed: true, unlocked: true },
    ]);
    expect(nextAction(steps)).toEqual({ step: steps[3], done: true });
  });

  it("ширина полосы без NaN и не больше 100", () => {
    expect(barWidth(0, 0)).toBe(0);
    expect(barWidth(1, 0)).toBe(100);
    expect(barWidth(2, 3)).toBeCloseTo(66.67, 1);
    expect(barWidth(5, 3)).toBe(100);
  });
});

describe("итог попытки на пути", () => {
  const ok = { passed: true };
  const bad = { passed: false };

  it("сколько осталось — с правильными склонениями", () => {
    expect(attemptProgressLine(step({ streak: 2 }), ok)).toBe(
      "Ступень 2: зачтено подряд 2 из 3 — ещё одна карточка",
    );
    expect(attemptProgressLine(step({ streak: 1, required: 3 }), ok)).toBe(
      "Ступень 2: зачтено подряд 1 из 3 — ещё 2 карточки",
    );
    expect(attemptProgressLine(step({ streak: 1, required: 6 }), ok)).toBe(
      "Ступень 2: зачтено подряд 1 из 6 — ещё 5 карточек",
    );
    expect(cards(1)).toBe("карточка");
    expect(cards(2)).toBe("карточки");
    expect(cards(5)).toBe("карточек");
    expect(cards(11)).toBe("карточек");
    expect(cards(21)).toBe("карточка");
  });

  it("ступень пройдена — открыта следующая", () => {
    expect(attemptProgressLine(step({ streak: 3, passed: true }), ok)).toBe(
      "Ступень 2 пройдена — открыта ступень 3",
    );
    expect(
      attemptProgressLine(step({ number: 4, streak: 3, passed: true }), ok),
    ).toBe("Ступень 4 пройдена — все ступени пройдены");
  });

  it("«Не зачтено» начинает ряд заново", () => {
    expect(attemptProgressLine(step({ streak: 0 }), bad)).toBe(
      "Ряд начат заново: нужно 3 подряд",
    );
    expect(attemptProgressLine(step({ passed: true, streak: 0 }), bad)).toMatch(
      /уже пройдена/,
    );
  });
});
