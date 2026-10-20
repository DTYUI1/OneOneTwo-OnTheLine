import { describe, expect, it } from "vitest";
import { isOperatorModuleEnabled } from "./features";

describe("выключатель модуля «Оператор 112»", () => {
  it("по умолчанию выключен", () => {
    expect(isOperatorModuleEnabled(undefined)).toBe(false);
    expect(isOperatorModuleEnabled(null)).toBe(false);
    expect(isOperatorModuleEnabled({})).toBe(false);
    expect(isOperatorModuleEnabled({ operator_module: "true" })).toBe(false);
  });
  it("включается ответом сервера", () => {
    expect(isOperatorModuleEnabled({ operator_module: true })).toBe(true);
    expect(isOperatorModuleEnabled({ operator_module: false })).toBe(false);
  });
});
