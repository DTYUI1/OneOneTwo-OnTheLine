import { describe, expect, it } from "vitest";
import { maskPhone, phoneIncomplete, phoneValue } from "./phone";

/** Набор по одной клавише, как в поле: каждое значение снова проходит маску. */
function typed(keys: string): string {
  return [...keys].reduce((field, key) => maskPhone(field + key), "");
}

describe("телефон по маске АРМ", () => {
  it("десять цифр складываются в +7 (XXX) XXX-XX-XX", () => {
    expect(typed("9161234567")).toBe("+7 (916) 123-45-67");
  });

  it("восьмёрка или +7 перед полным номером — код страны", () => {
    expect(typed("89161234567")).toBe("+7 (916) 123-45-67");
    expect(typed("+79161234567")).toBe("+7 (916) 123-45-67");
    expect(maskPhone("8 (916) 123-45-67")).toBe("+7 (916) 123-45-67");
  });

  it("код 812 без восьмёрки не теряется", () => {
    expect(typed("8121234567")).toBe("+7 (812) 123-45-67");
  });

  it("лишние цифры и буквы не попадают в номер", () => {
    expect(typed("916123456789")).toBe("+7 (916) 123-45-67");
    expect(maskPhone("916abc")).toBe("+7 (916");
  });

  it("стирание убирает цифры, пустое поле — пустая строка", () => {
    expect(maskPhone("+7 (916) ")).toBe("+7 (916");
    expect(maskPhone("+7 (")).toBe("");
  });

  it("неполный номер отмечается и уходит на сервер как есть", () => {
    expect(phoneIncomplete("+7 (916) 12")).toBe(true);
    expect(phoneIncomplete("")).toBe(false);
    expect(phoneIncomplete("+7 (916) 123-45-67")).toBe(false);
    expect(phoneValue("+7 (916) 123-45-67")).toBe("+79161234567");
    expect(phoneValue("")).toBe("");
    expect(phoneValue("+7 (916")).toBe("+7 (916");
  });
});
