import { describe, expect, it } from "vitest";
import { OPERATOR_DATA as data } from "./data";
import { activeTags, autoServices } from "./model";
import { cardAnswer, cardGroups, cardType, groupChoice } from "./presentation";

describe("опросная карта АРМ", () => {
  const smoke = data.types.find((t) => t.code === "1050102")!;
  it("признак ребёнка без взрослых выбирает тип лифта и службы 101 и Мослифт", () => {
    const lift = data.types.find((t) => t.code === "14100100")!;
    const child = cardType(
      data,
      lift,
      "sign3",
      "Дети до 10 лет без сопровождения взрослых",
    );
    expect(child.code).toBe("14100102");
    expect(autoServices(data, child.code, new Set())).toEqual([
      "101",
      "MOSLIFT",
    ]);
  });
  it("угроза и газификация сохраняют маршрутизацию и не меняют дым на пламя", () => {
    const groups = cardGroups(data, smoke, {});
    let answers = cardAnswer(
      {},
      groups.find((g) => g.key === "victims")!,
      "Да",
    );
    answers = cardAnswer(
      answers,
      groups.find((g) => g.key === "gasification")!,
      "Да",
    );
    expect(autoServices(data, smoke.code, activeTags(answers))).toEqual([
      "101",
      "102",
      "103",
      "104",
      "MOSLIFT",
    ]);
    expect(cardType(data, smoke, "gasification", "Да")).toBe(smoke);
  });
  it("несколько объектов остаются отмеченными после уточнения типа и снимаются независимо", () => {
    const group = cardGroups(data, smoke, {}).find(
      (g) => g.key === "house_objects",
    )!;
    let answers = cardAnswer({}, group, "Газовая колонка");
    const next = cardType(data, smoke, group.key, "Газовая колонка");
    expect(next.code).toBe("1050302");
    let updated = cardGroups(data, next, answers).find(
      (g) => g.key === group.key,
    )!;
    expect(
      updated.options.filter((o) => o.selected).map((o) => o.value),
    ).toEqual(["Квартира", "Газовая колонка"]);
    answers = cardAnswer(answers, updated, "Квартира");
    updated = cardGroups(data, next, answers).find((g) => g.key === group.key)!;
    expect(
      updated.options.filter((o) => o.selected).map((o) => o.value),
    ).toEqual(["Газовая колонка"]);
  });
  it("газ и звуки взрыва выбирают реальные коды классификатора", () => {
    const gas = groupChoice(data, "104")!;
    expect(
      cardType(
        data,
        gas,
        "gas_sign",
        "Запах газа в помещении (в квартире, в доме)",
      ).code,
    ).toBe("13020201");
    const explosion = groupChoice(data, "Взрыв")!;
    expect(
      cardType(
        data,
        explosion,
        "explosion_place",
        "Звуки похожие на взрыв, что взорвалось сообщить не может",
      ).code,
    ).toBe("3030000");
  });
});
