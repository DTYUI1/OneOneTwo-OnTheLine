import { expect } from "@playwright/test";
import { test, login } from "./captain-fixture";

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
    await page.getByRole("button", { name: /Служба 102.*Получена/ }).click();
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
      await page.getByRole("group", { name: "Действие по карточке" }).hover();
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

  test("Esc после перехода к полю закрывает подсказку и сохраняет ввод", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    await page.getByRole("button", { name: /Служба 102.*Получена/ }).click();
    const hint = page.getByRole("button", {
      name: "Подсказка: статус",
      exact: true,
    });
    await hint.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("note")).toBeVisible();
    // Идём от подсказок к полю комментария. Подсказки стоят над формой статуса (форма —
    // в строке служб, как в arm_dds/09): «номер наряда», «комментарий», затем поля
    // «Статус», «Номер наряда», «Комментарий». Раньше подсказки шли после кнопок формы
    // и путь был назад, Shift+Tab ×3.
    for (let step = 0; step < 5; step++) await page.keyboard.press("Tab");
    const comment = page.getByRole("textbox", {
      name: "Комментарий",
      exact: true,
    });
    await expect(comment).toBeFocused();
    await page.keyboard.insertText(
      "Проверяю сведения перед принятием карточки.",
    );
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/arm/cards/${lesson.card.id}$`));
    await expect(page.getByRole("note")).toHaveCount(0);
    await expect(hint).toHaveAttribute("aria-expanded", "false");
    await expect(comment).toBeFocused();
    await expect(comment).toHaveValue(
      "Проверяю сведения перед принятием карточки.",
    );
    await page.screenshot({
      path: test.info().outputPath("hint-dismissed.png"),
    });
    // После закрытия подсказки обычное действие Esc остаётся доступным: в форме
    // статуса Esc закрывает форму (не уводит из карточки посреди звонка), следующий —
    // карточку.
    await page.keyboard.press("Escape");
    await expect(comment).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/arm/cards/${lesson.card.id}$`));
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/app\/arm$/);
    await expect(
      page.locator(`[data-card-id="${lesson.card.id}"]`),
    ).toBeFocused();
  });

  test("Подсказка связана с кнопкой и сохраняется под общей справкой", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    const hint = page.getByRole("button", {
      name: "Подсказка: адрес",
      exact: true,
    });
    await hint.click();
    const note = page.getByRole("note");
    await expect(note).toBeVisible();
    await expect(hint).toHaveAccessibleDescription(await note.innerText());
    await expect(hint).toHaveAttribute(
      "aria-controls",
      (await note.getAttribute("id"))!,
    );
    const help = page.getByRole("button", {
      name: "Объяснение экрана",
      exact: true,
    });
    await help.click();
    await expect(page.locator("[data-help-ui] h2")).toHaveText(/^\d+\. /);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-help-ui]")).toHaveCount(0);
    await expect(note).toBeVisible();
    await expect(help).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(note).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/arm/cards/${lesson.card.id}$`));
    await expect(help).toBeFocused();
    await expect(hint).not.toHaveAttribute("aria-describedby", /.+/);
  });
});
