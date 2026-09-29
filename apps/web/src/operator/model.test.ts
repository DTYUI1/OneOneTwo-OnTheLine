import { describe, expect, it } from "vitest";
import { OPERATOR_DATA as data } from "./data";
import {
  activeTags,
  answer,
  autoServices,
  barServices,
  descriptionCounter,
  formatPhone,
  formatTimer,
  frequentChoice,
  incidentTitle,
  isOverdue,
  keepQuickTags,
  retype,
  saveServices,
  searchServices,
  searchTypes,
  tagGroups,
  toggleTag,
} from "./model";

const type = (code: string) => {
  const found = data.types.find((item) => item.code === code);
  if (!found) throw new Error(code);
  return found;
};
const smoke = type("1050102"); // задымление: квартира

describe("подстановка служб по тегам", () => {
  it("без тегов — только правила default", () => {
    expect(autoServices(data, smoke.code, new Set())).toEqual([
      "101",
      "102",
      "MOSLIFT",
    ]);
  });
  it("тег «Пострадавшие» добавляет скорую, газификация — Мосгаз", () => {
    let answers = toggleTag({}, "victims");
    expect(autoServices(data, smoke.code, activeTags(answers))).toEqual([
      "101",
      "102",
      "103",
      "MOSLIFT",
    ]);
    answers = answer(answers, "gasification", "Да");
    expect(autoServices(data, smoke.code, activeTags(answers))).toContain(
      "104",
    );
    answers = answer(answers, "gasification", "Нет данных");
    expect(activeTags(answers)).toEqual(new Set(["victims"]));
    expect(activeTags(toggleTag(answers, "victims"))).toEqual(new Set());
  });
  it("смена типа не снимает «Пострадавшие» и «Нет доступа», нажатые справа", () => {
    let answers = toggleTag(toggleTag({}, "victims"), "no_access");
    answers = answer(answers, "gasification", "Да");
    answers = answer(answers, "sign2", "квартира");
    const kept = keepQuickTags(answers);
    expect(activeTags(kept)).toEqual(new Set(["victims", "no_access"]));
    expect(kept).not.toHaveProperty("gasification");
    expect(kept).not.toHaveProperty("sign2");
  });
  it("совпадает с ожидаемыми службами сценария OP-02", () => {
    // data/operator/scenarios/fire_apartment_smoke.json: expected_tags victims.
    expect(autoServices(data, "1050102", new Set(["victims"]))).toEqual([
      "101",
      "102",
      "103",
      "MOSLIFT",
    ]);
  });
  it("без типа служб нет; ручные правки полосы сохраняются", () => {
    expect(autoServices(data, null, new Set(["victims"]))).toEqual([]);
    const auto = ["101", "102"];
    const saved = saveServices(auto, new Set(["101", "104"]));
    expect([...saved.added]).toEqual(["104"]);
    expect([...saved.removed]).toEqual(["102"]);
    expect(
      barServices(data.services, auto, saved.added, saved.removed).map(
        (s) => s.id,
      ),
    ).toEqual(["101", "104"]);
    expect(searchServices(data.services, "мосг").map((s) => s.id)).toEqual([
      "104",
    ]);
  });
});

describe("счётчик описания, таймер, телефон", () => {
  it("считает символы из 1999", () => {
    expect(descriptionCounter("")).toBe("0 / 1999");
    expect(descriptionCounter("Дым из-под двери")).toBe("16 / 1999");
  });
  it("мм:сс и красный после норматива 180 с", () => {
    expect(formatTimer(83)).toEqual(["01", "23"]);
    expect(isOverdue(180)).toBe(false);
    expect(isOverdue(181)).toBe(true);
    expect(isOverdue(61, 60)).toBe(true);
  });
  it("номер АОН", () => {
    expect(formatPhone("+79161234567")).toBe("+7 (916) 123-45-67");
  });
});

describe("поле «что случилось?»", () => {
  it("ищет по названию, группе и службе, без учёта ё", () => {
    expect(
      searchTypes(data, "задымление квартира").map((t) => t.code),
    ).toContain("1050102");
    expect(searchTypes(data, "")).toEqual([]);
    expect(searchTypes(data, "104").length).toBeGreaterThan(0);
  });
  it("быстрые кнопки: тип — в поиск, иначе звонок без происшествия", () => {
    expect(frequentChoice(data, "ДТП")).toEqual({ query: "ДТП" });
    expect(frequentChoice(data, "Ошибочно набран номер")).toEqual({
      choice: { kind: "call", label: "Ошибочно набран номер" },
    });
  });
  it("после выбора — «Происшествие 101» и группы тегов", () => {
    expect(incidentTitle(smoke)).toBe("Происшествие 101");
    const groups = tagGroups(data, smoke, toggleTag({}, "victims"));
    expect(groups.map((g) => g.title)).toEqual([
      "Где",
      "Объект",
      "Признак",
      "Пострадавшие",
      "Проведена ли газификация",
    ]);
    const where = groups[0]!;
    expect(where.options.filter((o) => o.selected).map((o) => o.value)).toEqual(
      ["жилой дом"],
    );
    const victims = groups.find((g) => g.key === "victims")!;
    expect(victims.options.find((o) => o.value === "Да")?.selected).toBe(true);
  });
  it("тег-признак уточняет тип в той же группе", () => {
    const flame = retype(data, smoke, 2, "открытое пламя");
    expect(flame.signs).toEqual(["жилой дом", "квартира", "открытое пламя"]);
    expect(retype(data, smoke, 0, "нет такого")).toBe(smoke);
  });
  it("сценарии модуля ссылаются на видимые типы", () => {
    for (const code of [
      "2020900",
      "14100102",
      "1050102",
      "13020500",
      "17010800",
    ])
      expect(type(code).code).toBe(code);
    expect(data.scenarios.map((s) => s.id)).toContain("fire_apartment_smoke");
  });
});
