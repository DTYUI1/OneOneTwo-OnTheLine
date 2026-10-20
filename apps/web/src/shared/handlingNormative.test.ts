import { describe, expect, it } from "vitest";
import {
  formatHandlingNormative,
  parseHandlingNormative,
} from "./handlingNormative";
import contract from "../../../../contracts/openapi.json";

describe("Норматив отработки в мм:сс", () => {
  it.each([
    ["3:00", 180],
    ["03:00", 180],
    [" 3:00 ", 180],
    ["0:01", 1],
    ["2:59", 179],
    ["59:59", 3599],
    ["60:00", 3600],
  ])("разбирает %s", (input, seconds) => {
    expect(parseHandlingNormative(input)).toBe(seconds);
  });

  it.each([
    "",
    "180",
    "3",
    "3:0",
    "3:60",
    "0:00",
    "60:01",
    "61:00",
    "-1:00",
    "1.5:00",
    "1:00:00",
    "3:00abc",
  ])("отклоняет %s", (input) =>
    expect(parseHandlingNormative(input)).toBeNull(),
  );

  it("показывает настройки нового занятия как 3:00", () => {
    const settings = contract.components.schemas.Settings.examples[0];
    expect(settings.handling_normative_s).toBe(180);
    expect(formatHandlingNormative(settings.handling_normative_s)).toBe("3:00");
  });

  it.each([1, 180, 3599, 3600])(
    "сохраняет секунды при преобразовании %s",
    (seconds) => {
      expect(parseHandlingNormative(formatHandlingNormative(seconds))).toBe(
        seconds,
      );
    },
  );
});
