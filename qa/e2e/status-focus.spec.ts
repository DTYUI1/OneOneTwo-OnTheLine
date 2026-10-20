import { expect } from "@playwright/test";
import { test, login } from "./captain-fixture";
import { confirmAgain } from "./trainer";

// Строка статуса с клавиатуры — как в макете B (README «Строка статуса с клавиатуры»):
// строка всегда на виду (DT-19), карандаш или Alt+Z ставит фокус в «Статус», цифра —
// пункт списка, Tab по полям по кругу, Enter сохраняет и очищает строку, номер наряда
// остаётся.
test.describe("Фокус строки статуса", () => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");

  test("После сохранения фокус на карандаше, следующий статус — с клавиатуры", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    const pencil = page.getByRole("button", {
      name: "Изменить статус",
      exact: true,
    });
    const status = page.getByRole("combobox", { name: "Статус", exact: true });
    const number = page.getByRole("textbox", { name: "Номер наряда" });
    const comment = page.getByRole("textbox", {
      name: "Комментарий",
      exact: true,
    });
    const history = page.locator('[data-help="card-history"]');
    // Строка статуса на виду сразу, без карандаша.
    await expect(status).toBeVisible();

    await pencil.click();
    await expect(status).toBeFocused();
    await status.selectOption("rejected");
    await number.fill("12");
    await comment.fill("Требуется другая служба.");
    await page
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();
    // «Не принята» — первое ✓ только взводит (подпись у ✓), второй ✓ сохраняет (17.10).
    await expect(confirmAgain(page)).toBeVisible();
    await page
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();
    await expect(history).toContainText("Требуется другая служба.");
    await expect(status).toHaveValue("");
    await expect(pencil).toBeFocused();

    // Enter на карандаше — фокус в строку; номер наряда остался от прошлого статуса.
    await page.keyboard.press("Enter");
    await expect(status).toBeFocused();
    await expect(number).toHaveValue("12");
    await page.keyboard.press("1");
    await expect(status).toHaveValue("accepted");
    await page.keyboard.press("Tab");
    await expect(number).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(comment).toBeFocused();
    await page.keyboard.insertText("Сведения проверены дежурным.");
    await page.keyboard.press("Enter");
    await expect(history).toContainText(
      "Принята — Сведения проверены дежурным.",
    );
    await expect(pencil).toBeFocused();
  });
});
