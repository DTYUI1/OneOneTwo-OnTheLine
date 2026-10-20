import { expect, it } from "vitest";
import { validationMessage } from "./validationErrors";
it("объясняет вложенную ошибку схемы звонка", () => {
  expect(
    validationMessage({
      details: {
        errors: [
          {
            field: "",
            reason:
              "Value error, Поле reference.expected_call.phone_ext: '' does not match",
          },
        ],
      },
    }),
  ).toContain("снимите галочку");
});
it("сохраняет неизвестное поле и текст сервера", () => {
  expect(
    validationMessage({
      details: {
        errors: [
          { field: "participants.0.future", reason: "Нужно выбрать значение" },
        ],
      },
    }),
  ).toBe("participants.0.future: Нужно выбрать значение");
});
it("объясняет знакомое поле и не ломает ошибки без details", () => {
  expect(
    validationMessage({
      details: { errors: [{ field: "title", reason: "Field required" }] },
    }),
  ).toBe("Название: Заполните поле.");
  expect(validationMessage({ message: "Ошибка" })).toBeNull();
});
