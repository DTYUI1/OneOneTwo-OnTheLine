import { describe, expect, it } from "vitest";
import {
  emptyListText,
  listKey,
  trainingLabel,
  trainingStep,
} from "./listModel";

describe("emptyListText", () => {
  it("без занятия ведёт на тренировку", () => {
    const text = emptyListText("", false);
    expect(text).toContain("Тренировка");
    expect(text).toContain("Занятие ещё не начато");
    expect(text).not.toContain("Дождитесь карточки");
  });

  it("на идущем занятии просит дождаться карточки", () => {
    expect(emptyListText("", true)).toBe(
      "Происшествий нет. Дождитесь карточки от Системы 112.",
    );
  });

  it("при непустом поиске говорит о поиске, есть занятие или нет", () => {
    for (const running of [true, false])
      expect(emptyListText("  пожар ", running)).toBe(
        "По вашему запросу ничего не найдено. Измените запрос или нажмите «сбросить».",
      );
  });

  it("на ступени 2+ называет ступень и не обещает проводника", () => {
    const text = emptyListText("", false, 3);
    expect(text).toContain("«Тренировка: ступень 3»");
    expect(text).not.toContain("проводник");
  });

  it("без ступени обещает проводника упражнения", () => {
    expect(emptyListText("", false, undefined)).toContain("проводник");
  });

  it("пробелы в поиске не считаются запросом", () => {
    expect(emptyListText("   ", true)).toContain("Дождитесь карточки");
  });
});

describe("trainingLabel", () => {
  it("называет текущую ступень", () => {
    expect(trainingLabel({ current_step: 3 })).toBe("Тренировка: ступень 3");
  });

  it("на первой ступени — упражнение с прежней подписью", () => {
    expect(trainingLabel({ current_step: 1 })).toBe("Тренировка");
  });

  it("без данных пути — прежняя подпись", () => {
    expect(trainingLabel(undefined)).toBe("Тренировка");
    expect(trainingLabel(null)).toBe("Тренировка");
  });
});

describe("trainingStep", () => {
  it("первая ступень и нет данных — упражнение без ступени", () => {
    expect(trainingStep({ current_step: 1 })).toBeUndefined();
    expect(trainingStep(null)).toBeUndefined();
    expect(trainingStep(undefined)).toBeUndefined();
  });

  it("со второй ступени передаёт её номер", () => {
    expect(trainingStep({ current_step: 2 })).toBe(2);
    expect(trainingStep({ current_step: 4 })).toBe(4);
  });
});

describe("listKey", () => {
  it("«/» вне поля ввода — к поиску", () => {
    expect(listKey("/", false)).toBe("focusSearch");
  });

  it("«/» в поле ввода печатается как обычно", () => {
    expect(listKey("/", true)).toBeNull();
  });

  it("↓ из поиска — к первой строке", () => {
    expect(listKey("ArrowDown", true)).toBe("firstRow");
  });

  it("остальные клавиши не перехватываются", () => {
    expect(listKey("ArrowDown", false)).toBeNull();
    expect(listKey("a", false)).toBeNull();
    expect(listKey("Enter", true)).toBeNull();
  });
});
