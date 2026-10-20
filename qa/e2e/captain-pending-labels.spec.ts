import { expect } from "@playwright/test";
import { test, login } from "./captain-fixture";
import { dialTyped } from "./phone";

test.describe("Русские подписи ожидающих действий", () => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");
  for (const type of ["hint_open", "call_hangup"] as const) {
    test(`${type}: очередь объясняет действие до подтверждения сервера`, async ({
      page,
      lesson,
    }) => {
      await login(page, "trainee05");
      await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
      await expect(page.locator('[data-help="card-history"]')).toContainText(
        "карточка открыта",
      );
      let release = () => {};
      let held = false;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Задерживаем отправку настоящего события, не меняя данные и ответ сервера.
      await page.route(
        `**/api/cards/${lesson.card.id}/events`,
        async (route) => {
          if (
            route.request().method() === "POST" &&
            route.request().postDataJSON().type === type
          ) {
            held = true;
            await ready;
          }
          await route.continue();
        },
      );
      try {
        if (type === "hint_open") {
          // Подсказок «?» у полей с 29.09 нет (df0b29c): `hint_open` пишет
          // «Объяснение экрана» открытой карточки.
          await page
            .getByRole("button", { name: "Объяснение экрана", exact: true })
            .click();
        } else {
          // Телефон ДДС (GP-09): своя служба 102 набирается вручную.
          await dialTyped(page, "102");
          await page
            .getByRole("button", { name: "Положить трубку", exact: true })
            .click();
        }
        await expect.poll(() => held).toBe(true);
        const pending = page.locator("section").filter({
          has: page.getByText("Действия ещё не подтверждены сервером", {
            exact: true,
          }),
        });
        // Действие в пути плашка не показывает — только застрявшее дольше 3 с
        // (outboxNotice.ts, проверка капитана 20.10); очередь проверяется раз в 2 с.
        await expect(pending).toBeVisible({ timeout: 15_000 });
        await page.screenshot({
          path: test.info().outputPath("pending-action.png"),
        });
        await expect(pending).toContainText(
          type === "hint_open"
            ? "открытие подсказки — ожидает отправки"
            : "завершение звонка — ожидает отправки",
        );
        expect(await pending.innerText()).not.toMatch(/[A-Za-z]{3,}/);
        release();
        await expect(pending).toHaveCount(0);
        await expect(page.locator('[data-help="card-history"]')).toContainText(
          type === "hint_open" ? "открыта подсказка" : "звонок завершён",
        );
      } finally {
        release();
        await page.unrouteAll({ behavior: "wait" });
      }
    });
  }
});
