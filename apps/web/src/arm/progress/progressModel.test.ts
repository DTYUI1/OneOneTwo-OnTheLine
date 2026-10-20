import { describe, expect, it } from "vitest";
import {
  adviceLines,
  attemptProgressLine,
  barWidth,
  cards,
  nextAction,
  previousLines,
  remaining,
  repeatLine,
  repeatsOf,
  stepState,
  type Advice,
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
    ).toBe("Ступень 4 пройдена — открыта ступень 5");
    // Ступень 5 — финальная смена (HQ-033).
    expect(
      attemptProgressLine(step({ number: 5, streak: 3, passed: true }), ok),
    ).toBe("Ступень 5 пройдена — все ступени пройдены");
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

describe("adviceLines", () => {
  const base = {
    based_on: 2,
    next_step: 3,
    next: "Следующий шаг — ступень 3: Сложные карточки.",
    summary: "Подтяните: адрес.",
  };
  it("пишет совет на каждое слабое место и следующий шаг", () => {
    expect(
      adviceLines({
        ...base,
        focus: [
          {
            criterion: "address",
            label: "Адрес",
            text: "Сверяйте адрес из доклада бригады с карточкой.",
          },
        ],
      }),
    ).toEqual([
      "Адрес: Сверяйте адрес из доклада бригады с карточкой.",
      base.next,
    ]);
  });
  it("без слабых мест — итог и следующий шаг", () => {
    expect(adviceLines({ ...base, focus: [], summary: "Ошибок нет." })).toEqual(
      ["Ошибок нет.", base.next],
    );
  });
});

describe("прошлые рекомендации и повтор незачтённых (TC-11)", () => {
  const advice: Advice = {
    based_on: 2,
    next_step: 2,
    next: "Следующий шаг — ступень 2: Своя карточка.",
    summary: "Подтяните: адрес.",
    focus: [],
    previous: {
      card_id: "new",
      focus: [
        { criterion: "address", label: "Адрес", text: "…", status: "done" },
        { criterion: "call", label: "Звонок", text: "…", status: "not_done" },
        {
          criterion: "status_flow",
          label: "Ход статусов",
          text: "…",
          status: "unchecked",
        },
      ],
    },
  };

  it("каждое слабое место прошлой рекомендации отмечено по новой попытке", () => {
    expect(previousLines(advice)).toEqual([
      "Адрес — выполнена",
      "Звонок — не выполнена",
      "Ход статусов — в новой попытке не проверялась",
    ]);
  });

  it("в разборе другой карточки отметки нет; без прошлой — пусто", () => {
    expect(previousLines(advice, "old")).toEqual([]);
    expect(previousLines(advice, "new")).toHaveLength(3);
    expect(previousLines({ ...advice, previous: null })).toEqual([]);
  });

  const repeat = {
    scenario_id: "s",
    number: "70005001",
    incident_class: "Пожар",
    step: 2,
    was: 0.45,
    now: null,
    passed: false,
    last_card_id: "c",
  };

  it("повтор: было → стало и исправлено ли", () => {
    expect(repeatLine(repeat)).toBe("было 45 %");
    expect(repeatLine({ ...repeat, now: 0.82, passed: true })).toBe(
      "было 45 % → стало 82 % · исправлено",
    );
    expect(repeatLine({ ...repeat, now: 0.6 })).toBe(
      "было 45 % → стало 60 % · пока не зачтено",
    );
  });

  it("ответ сервера без повторов — пустой список", () => {
    expect(repeatsOf({})).toEqual([]);
    expect(repeatsOf({ repeats: [repeat] })).toEqual([repeat]);
  });
});
