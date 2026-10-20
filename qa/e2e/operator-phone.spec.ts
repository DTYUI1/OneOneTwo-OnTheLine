import { expect, test } from "@playwright/test";
import { openCall } from "./operator-call";
import { OPERATOR_MODULE, OPERATOR_OFF_REASON } from "./operator-module";

test.skip(!OPERATOR_MODULE, OPERATOR_OFF_REASON);

// Телефон по маске АРМ «+7 (___) ___-__-__» (docs/screenshots/card_112): неполный номер
// не уходит на сервер, оператор видит, какое поле дописать.

test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");
test.use({ viewport: { width: 1366, height: 768 } });

test("номер набирается по маске, неполный номер останавливает сохранение с понятной причиной", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openCall(page, "fire_apartment_smoke");
  const saves: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/operator/save") &&
      request.method() === "POST"
    )
      saves.push(request.url());
  });

  const provided = page.getByRole("textbox", {
    name: "предоставленный",
    exact: true,
  });
  await provided.click();
  await provided.pressSequentially("89161234567");
  await expect(provided).toHaveValue("+7 (916) 123-45-67");

  const scene = page.getByRole("textbox", {
    name: "телефон на место",
    exact: true,
  });
  await scene.click();
  await scene.pressSequentially("916123");
  await expect(scene).toHaveValue("+7 (916) 123");

  const save = page.getByRole("button", { name: "сохранить", exact: true });
  await save.click();
  await expect(page.getByRole("alert")).toHaveText(
    "Телефон «телефон на место»: нужно 10 цифр после +7. Допишите номер или очистите поле.",
  );
  await expect(scene).toBeFocused();
  await expect(scene).toHaveAttribute("aria-invalid", "true");
  await expect(provided).not.toHaveAttribute("aria-invalid", "true");
  expect(saves).toEqual([]);

  await scene.press("End");
  await scene.pressSequentially("4567");
  await expect(scene).toHaveValue("+7 (916) 123-45-67");
  await expect(scene).not.toHaveAttribute("aria-invalid", "true");

  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/operator/save") &&
      response.request().method() === "POST",
  );
  await save.click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  const attempt = await response.json();
  expect(attempt.operator_card).toMatchObject({
    phone_provided: "+79161234567",
    phone_scene: "+79161234567",
  });
  await expect(
    page.getByRole("dialog", { name: "Результат попытки" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
