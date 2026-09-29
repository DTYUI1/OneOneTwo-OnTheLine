import { expect } from "@playwright/test";
import { test, login } from "./captain-fixture";

test.describe("Фокус формы статуса после ответа сервера", () => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");

  test("Переход в «Номер наряда» во время отправки не отменяется возвратом в «Статус»", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    const status = page.getByRole("combobox", { name: "Статус", exact: true });
    const number = page.getByRole("textbox", { name: "Номер наряда" });
    const comment = page.getByRole("textbox", {
      name: "Комментарий",
      exact: true,
    });
    const history = page.locator('[data-help="card-history"]');
    // Форма видна сразу, без клика по плашке службы.
    await expect(status).toBeVisible();

    // Проверка докладов перед отправкой — первый await; задерживаем её ответ,
    // чтобы обучаемый успел перейти в другое поле.
    let delay = true;
    await page.route(/\/cards\/[^/]+\/training$/, async (route) => {
      if (delay) await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });

    await status.selectOption("rejected");
    await comment.fill("Требуется другая служба.");
    await page
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();
    await number.focus();
    await expect(history).toContainText("Требуется другая служба.");
    await expect(status).toHaveValue("");
    await expect(number).toBeFocused();

    // Без перехода фокус, как и раньше, возвращается в «Статус» — следующий
    // статус ставится подряд без клика.
    delay = false;
    await status.selectOption("accepted");
    await comment.fill("Сведения проверены дежурным.");
    await comment.press("Enter");
    await expect(history).toContainText(
      "Принята — Сведения проверены дежурным.",
    );
    await expect(status).toBeFocused();
  });
});
