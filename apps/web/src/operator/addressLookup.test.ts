import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import raw from "./streets.json";
import { EMPTY_ADDRESS } from "./model";
import { addressParts, chooseStreet, streetSuggestions } from "./AddressLookup";

describe("Учебные подсказки адреса", () => {
  it("показывает обе похожие улицы и не исправляет выбранную ошибку", () => {
    const suggestions = streetSuggestions("дубн, дом 12");
    expect(suggestions.map((street) => street.street)).toEqual([
      "Дубнинская улица",
      "Дубининская улица",
    ]);
    const wrong = chooseStreet(EMPTY_ADDRESS, "дубн, дом 12", suggestions[1]!);
    expect(wrong.street).toBe("Дубининская улица");
    expect(wrong.house).toBe("12");
  });
  it("разбирает дом и корпус, сохраняя дополнительные поля", () => {
    expect(addressParts("Новочерёмушкинская, д. 8 корпус 2")).toMatchObject({
      house: "8",
      building: "2",
    });
    const address = chooseStreet(
      { ...EMPTY_ADDRESS, entrance: "2", descriptive: "напротив школы" },
      "Новочерёмушкинская, 8 к2",
      streetSuggestions("новочер")[0]!,
    );
    expect(address).toMatchObject({
      house: "8",
      korpus: "2",
      entrance: "2",
      descriptive: "напротив школы",
      okrug: "ЮЗАО",
    });
  });
  it("копия в вебе совпадает с источником офлайн-набора", () => {
    expect(raw).toEqual(
      JSON.parse(
        readFileSync(resolve("../../data/operator/streets.json"), "utf8"),
      ),
    );
  });
});
