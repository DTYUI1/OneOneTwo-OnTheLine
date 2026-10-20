import { describe, expect, it } from "vitest";
import {
  byDate,
  cardArrived,
  emptyListText,
  listPage,
  listKey,
  trainingLabel,
  showsStages,
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

  it("с карточками прошлой смены говорит о новых (TC-07)", () => {
    expect(emptyListText("", true, undefined, true)).toBe(
      "Новых происшествий нет. Дождитесь карточки от Системы 112.",
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

describe("showsStages", () => {
  it("этапы — только на первой ступени и без пути", () => {
    expect(showsStages({ current_step: 1 })).toBe(true);
    expect(showsStages(null)).toBe(true);
    expect(showsStages({ current_step: 2 })).toBe(false);
  });

  it("пока путь грузится — этапов нет, не мелькают на ступени 2+", () => {
    expect(showsStages(undefined)).toBe(false);
  });

  it("путь не загрузился — этапы видны, как на первой ступени", () => {
    expect(showsStages(undefined, true)).toBe(true);
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

describe("byDate", () => {
  const at = (id: string, time: string) => ({
    id,
    appeared_at: `2026-10-19T${time}:00Z`,
  });

  it("карточки занятий и прошлой смены — одним списком по «Дата ↓»", () => {
    const rows = byDate(
      [at("now", "14:00"), at("old", "09:00")],
      [at("bg1", "13:40"), at("bg2", "12:10")],
    );
    expect(rows.map((row) => `${row.kind}:${row.item.id}`)).toEqual([
      "card:now",
      "background:bg1",
      "background:bg2",
      "card:old",
    ]);
  });

  it("при равном времени карточка занятия выше фона, свой порядок сохраняется", () => {
    const rows = byDate(
      [at("b", "14:00"), at("a", "14:00")],
      [at("bg", "14:00")],
    );
    expect(rows.map((row) => row.item.id)).toEqual(["b", "a", "bg"]);
  });
});

describe("cardArrived", () => {
  it("первый ответ — не новое происшествие", () => {
    expect(cardArrived(null, ["a", "b"])).toBe(false);
  });

  it("новый id — новое происшествие; обновление и уход карточек — нет", () => {
    expect(cardArrived(["a"], ["b", "a"])).toBe(true);
    expect(cardArrived(["a", "b"], ["b", "a"])).toBe(false);
    expect(cardArrived(["a", "b"], ["a"])).toBe(false);
  });
});

describe("listPage", () => {
  it("пустой реестр — «0 из 0» без страниц (arm_dds/02)", () => {
    expect(listPage(0, 0, 10)).toEqual({
      page: 0,
      pages: 0,
      start: 0,
      end: 0,
      label: "0 из 0",
    });
  });

  it("одна запись — «1-1 из 1» (arm_dds/03)", () => {
    expect(listPage(1, 0, 10).label).toBe("1-1 из 1");
  });

  it("делит реестр по 10 записей, последняя страница неполная", () => {
    expect(listPage(23, 0, 10)).toMatchObject({ pages: 3, start: 0, end: 10 });
    expect(listPage(23, 2, 10)).toMatchObject({
      start: 20,
      end: 23,
      label: "21-23 из 23",
    });
  });

  it("прижимает номер к последней странице, когда записей стало меньше", () => {
    expect(listPage(12, 5, 10)).toMatchObject({
      page: 1,
      label: "11-12 из 12",
    });
    expect(listPage(12, 1, 25)).toMatchObject({ page: 0, label: "1-12 из 12" });
    expect(listPage(12, -1, 10).page).toBe(0);
  });
});
