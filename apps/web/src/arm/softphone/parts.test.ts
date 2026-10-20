import { describe, expect, it } from "vitest";
import {
  addressOptions,
  addressText,
  incidentOptions,
  MAX_OPTIONS,
  short,
  similarHouse,
  similarNumber,
  similarWord,
  stepOptions,
} from "./parts";

const address = { street: "Дубнинская улица", house: "12", building: "" };

describe("похожие ошибки (GP-06)", () => {
  it("буква в улице — звонкая на глухую и похожие на слух", () => {
    expect(similarWord("Дубнинская", 0)).toBe("Бубнинская");
    expect(similarWord("Дубнинская", 1)).toBe("Дупнинская");
    expect(similarWord("Ауи", 0)).toBeNull();
  });

  it("цифра в доме и в номере карточки", () => {
    expect(similarHouse("12")).toBe("124");
    expect(similarHouse("24")).toBe("241");
    expect(similarHouse("7к2")).toBe("74к2");
    expect(similarNumber("10000001")).toBe("10000002");
    expect(similarNumber("109")).toBe("100");
  });

  it("адрес как в эталоне: «Дубнинская, 12» · «Бубнинская, 124» · «Дупнинская, 12»", () => {
    const options = addressOptions(address, "call-1");
    expect(options).toHaveLength(MAX_OPTIONS);
    expect(
      options.filter((item) => item.correct).map((item) => item.text),
    ).toEqual(["Дубнинская улица, 12"]);
    expect(
      options
        .filter((item) => !item.correct)
        .map((item) => item.text)
        .sort(),
    ).toEqual(["Бубнинская улица, 124", "Дупнинская улица, 12"]);
  });

  it("улицу не исказить — ошибка в доме", () => {
    const options = addressOptions(
      { street: "Аеуа", house: "3", building: "1" },
      "call-1",
    );
    expect(options.map((item) => item.text).sort()).toEqual([
      "Аеуа, 3, корпус 1",
      "Аеуа, 34, корпус 1",
    ]);
    expect(addressText({ street: " Тверская ", house: "", building: "" })).toBe(
      "Тверская",
    );
  });

  it("другое происшествие без общих слов с поводом", () => {
    const options = incidentOptions("Пожар в подъезде", "call-1");
    expect(options).toHaveLength(3);
    const wrong = options
      .filter((item) => !item.correct)
      .map((item) => item.text);
    for (const text of wrong) expect(text).not.toMatch(/пожар|подъезд/i);
  });

  it("не больше трёх, без повторов, короче 60 символов, порядок по звонку", () => {
    const long =
      "Столкновение двух легковых автомобилей на перекрёстке у метро, есть пострадавшие";
    const options = stepOptions(
      long,
      ["ДТП", "дтп", null, "Пожар", "Драка"],
      "s",
    );
    expect(options).toHaveLength(3);
    expect(options.filter((item) => item.correct)).toHaveLength(1);
    for (const item of options) expect(item.text.length).toBeLessThan(60);
    expect(short(long)).toMatch(/…$/);
    expect(stepOptions("А", ["Б", "В"], "s")).toEqual(
      stepOptions("А", ["Б", "В"], "s"),
    );
  });
});
