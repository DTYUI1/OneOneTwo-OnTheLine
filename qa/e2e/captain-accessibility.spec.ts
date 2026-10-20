import { expect } from "@playwright/test";
import { test, login } from "./captain-fixture";
import { confirmAgain } from "./trainer";

test.describe("Подсказки и форма карточки", () => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");

  test("Поздний ответ истории не закрывает новую форму перенаправления", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    await expect(page.locator('[data-help="card-history"]')).toContainText(
      "карточка открыта",
    );
    await page
      .getByRole("button", { name: "Изменить статус", exact: true })
      .click();
    let release = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events = `**/api/cards/${lesson.card.id}/events`;
    // Задерживаем обновление истории, но сохраняем настоящий ответ и обновления WS.
    await page.route(events, async (route) => {
      if (route.request().method() === "GET") await ready;
      await route.continue();
    });
    try {
      await page
        .getByRole("combobox", { name: "Статус", exact: true })
        .selectOption("rejected");
      await page
        .getByRole("textbox", { name: "Комментарий", exact: true })
        .fill("Требуется другая служба.");
      await page
        .getByRole("button", { name: "Подтвердить", exact: true })
        .click();
      // «Не принята» — вторым ✓: первое только взводит, у ✓ подпись (17.10).
      await expect(confirmAgain(page)).toBeVisible();
      await page
        .getByRole("button", { name: "Подтвердить", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Перенаправить", exact: true })
        .click();
      const target = page.getByRole("combobox", {
        name: "Служба для перенаправления",
      });
      const comment = page.getByRole("textbox", {
        name: "Комментарий",
        exact: true,
      });
      await expect(target).toBeVisible();
      await comment.fill("Уточняю адресата для перенаправления.");
      release();
      await expect(page.locator('[data-help="card-history"]')).toContainText(
        "Не принята — Требуется другая служба.",
      );
      await expect(target).toBeVisible();
      await expect(comment).toHaveValue(
        "Уточняю адресата для перенаправления.",
      );
      await page
        .getByRole("button", { name: "Объяснение экрана", exact: true })
        .click();
      // Справка самой формы — по её отступу, мимо полей. «Номера наряда» в форме
      // перенаправления нет (HQ-030, решение 18.10): только служба и причина.
      await expect(
        page.getByRole("textbox", { name: "Номер наряда" }),
      ).toHaveCount(0);
      await page
        .getByRole("group", { name: "Действие по карточке" })
        .hover({ position: { x: 3, y: 2 } });
      await expect(page.locator("[data-help-ui] h2")).toContainText(
        "Перенаправление карточки",
      );
      await page.screenshot({
        path: test.info().outputPath("redirect-after-history.png"),
      });
    } finally {
      release();
    }
  });

  // Подсказки «?» у полей карточки убраны 29.09 (df0b29c): подсказывает проводник
  // тренировки у нужной кнопки (DT-07, qa/e2e/tutor-pointer.spec.ts). Проверки
  // подсказки у поля (Esc закрывает её, связь с кнопкой, жизнь под общей справкой)
  // сняты; отмена ввода и выход из карточки проверяются отдельно.
  test("Esc в строке статуса не стирает ввод; вне строки возвращает к карточке в списке", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    // Строка статуса всегда на виду (DT-19, макет B): открывать её не нужно.
    const comment = page.getByRole("textbox", {
      name: "Комментарий",
      exact: true,
    });
    await comment.focus();
    await page.keyboard.insertText(
      "Проверяю сведения перед принятием карточки.",
    );
    // Esc в строке уводит фокус к карандашу, написанное не теряется (DT-19).
    // Вне строки Esc возвращает к строке в списке.
    await page.keyboard.press("Escape");
    await expect(comment).toHaveValue(
      "Проверяю сведения перед принятием карточки.",
    );
    await expect(
      page.getByRole("button", { name: "Изменить статус", exact: true }),
    ).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/arm/cards/${lesson.card.id}$`));
    await page
      .getByRole("button", { name: "Закрыть карточку", exact: true })
      .focus();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/app\/arm$/);
    await expect(
      page.locator(`[data-card-id="${lesson.card.id}"]`),
    ).toBeFocused();
  });
});
