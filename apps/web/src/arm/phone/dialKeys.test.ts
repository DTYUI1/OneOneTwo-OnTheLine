import { describe, expect, it } from "vitest";
import { DIAL_KEYS, eraseLast, pressKey, type DialKey } from "./dialKeys";
import { dialNumber, virtualPhone } from "../softphone/contacts";

/** Нажать кнопки клавиатуры по очереди, начиная с пустого поля. */
function press(keys: string, start = ""): string {
  return [...keys].reduce(
    (value, key) => pressKey(value, key as DialKey),
    start,
  );
}

describe("набор номера кнопками (HQ-023)", () => {
  it("клавиатура — 1 2 3 / 4 5 6 / 7 8 9 / 0, без «*» и «#» (решение 18.10)", () => {
    expect(DIAL_KEYS.join("")).toBe("1234567890");
  });

  it("кнопки дописывают в конец набранного с клавиатуры компьютера", () => {
    expect(pressKey("", "1")).toBe("1");
    expect(pressKey("10", "3")).toBe("103");
    expect(press("1", "+7 (495) ")).toBe("+7 (495) 1");
  });

  it("короткий номер, набранный кнопками, звонит так же, как из поля", () => {
    expect(dialNumber(press("103"), [], [])).toBe(dialNumber("103", [], []));
    expect(dialNumber(press("103"), [], [])).toBe("103");
  });

  it("городской номер службы, набранный кнопками, ведёт на её короткий номер", () => {
    const services = [{ phone_ext: "104", phone: "+74950000104" }];
    expect(dialNumber(press("84950000104"), [], [], services)).toBe("104");
    expect(dialNumber(press("4950000104"), [], [], services)).toBe("104");
  });

  it("полный условный номер бригады своей ДДС, набранный кнопками, — её короткий", () => {
    const digits = virtualPhone("103", "205").replace(/\D/g, "");
    expect(dialNumber(press(digits), [], [], [], "103")).toBe("205");
  });

  it("«стереть» стирает последнюю цифру вместе с оформлением после неё", () => {
    expect(eraseLast("103")).toBe("10");
    expect(eraseLast("1")).toBe("");
    expect(eraseLast("")).toBe("");
    expect(eraseLast("+7 (495) 103-")).toBe("+7 (495) 10");
    expect(eraseLast("12*#")).toBe("12*");
    expect(eraseLast("  ")).toBe("");
  });
});
