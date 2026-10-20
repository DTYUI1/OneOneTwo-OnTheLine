import { expect } from "@playwright/test";
import { test, login } from "./captain-fixture";

test.describe("Инструменты карточек: сверка с ПОВ-112", () => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен локальный стенд с БД");
  test.use({ viewport: { width: 1440, height: 1000 } });

  test("В реестре нет кнопок на номерах; закладка работает; справка не предлагает операций", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    const row = page.locator(`[data-card-id="${lesson.card.id}"]`);
    await row
      .getByRole("button", { name: "Закрепить карточку", exact: true })
      .click();
    await page.reload();
    await expect(
      row.getByRole("button", { name: "Открепить карточку", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    // Предпросмотр + связи + закладка + важность + таймер. Опер./АРМ — текст.
    await expect(row.getByRole("button")).toHaveCount(5);
    for (const name of [
      "Связанные карточки — справка тренажёра",
      "Важное происшествие — справка тренажёра",
    ]) {
      const opener = row.getByRole("button", { name, exact: true });
      await opener.click();
      const dialog = page.getByRole("dialog", { name: /^Справка тренажёра:/ });
      await expect(dialog.getByRole("button")).toHaveCount(1);
      await expect(dialog.locator("input,textarea,select,form")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(opener).toBeFocused();
      await expect(page).toHaveURL(/\/arm$/);
    }
    await row
      .getByRole("button", { name: "Открепить карточку", exact: true })
      .click();
  });

  test("Таймер: состав формы, сохранение, закрытая карточка, повтор через 20 секунд, перенос и удаление", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    await page.clock.install();
    const row = page.locator(`[data-card-id="${lesson.card.id}"]`);
    await row
      .getByRole("button", { name: "Поставить напоминание", exact: true })
      .click();
    let dialog = page.getByRole("dialog", {
      name: "Поставить напоминание",
      exact: true,
    });
    await expect(dialog.getByRole("button")).toHaveCount(3); // x, сохранить, отмена
    await expect(dialog.locator("input")).toHaveCount(2);
    await expect(dialog.locator("textarea")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "сохранить", exact: true }),
    ).toBeDisabled();
    await dialog.getByLabel("Минуты", { exact: true }).fill("1");
    await dialog.getByLabel("О чем напомнить?", { exact: true }).fill("   ");
    await expect(
      dialog.getByRole("button", { name: "сохранить", exact: true }),
    ).toBeDisabled();
    await dialog
      .getByLabel("О чем напомнить?", { exact: true })
      .fill("Проверить прибытие наряда 17");
    await page.screenshot({
      path: "qa/results/arm-authentic-timer.png",
      fullPage: false,
    });
    await dialog.screenshot({
      path: "qa/results/arm-authentic-timer-form.png",
    });
    await dialog
      .getByRole("button", { name: "сохранить", exact: true })
      .click();
    await page.reload();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row
      .getByRole("button", { name: "Изменить напоминание", exact: true })
      .click();
    dialog = page.getByRole("dialog", {
      name: "Поставить напоминание",
      exact: true,
    });
    await expect(
      dialog.getByLabel("О чем напомнить?", { exact: true }),
    ).toHaveValue("Проверить прибытие наряда 17");
    await dialog.getByRole("button", { name: "отмена", exact: true }).click();
    await row.click();
    await page.clock.fastForward(61_000);
    const notice = page.getByRole("dialog", {
      name: `Напоминание для карточки: ${lesson.card.source.number}`,
      exact: true,
    });
    await expect(notice).toHaveCount(0); // Пока карточка открыта, напоминание не показывается.
    await page
      .getByRole("button", { name: "Закрыть карточку", exact: true })
      .click();
    await expect(notice).toBeVisible();
    await expect(notice.getByRole("button")).toHaveCount(4); // x, переход, перенос, удаление
    await expect(notice).toContainText("Проверить прибытие наряда 17");
    await page.screenshot({
      path: "qa/results/arm-authentic-notice.png",
      fullPage: false,
    });
    await notice.screenshot({
      path: "qa/results/arm-authentic-notice-form.png",
    });
    await notice
      .getByRole("button", { name: "Закрыть окно", exact: true })
      .click();
    await page.clock.fastForward(19_000);
    await expect(notice).toHaveCount(0);
    await page.clock.fastForward(1_100);
    await expect(notice).toBeVisible();
    await notice.getByLabel("Минуты", { exact: true }).fill("2");
    await notice
      .getByRole("button", { name: "напомнить позже", exact: true })
      .click();
    await expect(notice).toHaveCount(0);
    await page.clock.fastForward(121_000);
    await expect(notice).toBeVisible();
    await notice
      .getByRole("button", { name: "перейти в карточку", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(lesson.card.id));
    await page.clock.fastForward(21_000);
    await expect(notice).toHaveCount(0);
    await page
      .getByRole("button", { name: "Закрыть карточку", exact: true })
      .click();
    await expect(notice).toBeVisible();
    await notice
      .getByRole("button", { name: "удалить напоминание", exact: true })
      .click();
    await expect(notice).toHaveCount(0);
    await expect(
      row.getByRole("button", { name: "Поставить напоминание", exact: true }),
    ).toBeVisible();
  });

  test("Неподтверждённые элементы дают только подписанную справку; нет выдуманных форм и записей", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    await expect(
      page.getByRole("button", { name: "просмотр", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByTitle("Просмотр карточки", { exact: true }),
    ).toBeVisible();
    for (const title of [
      "ЧС — справка тренажёра",
      "ЧП — справка тренажёра",
      "Карандаш у признаков — справка тренажёра",
      "Дополнение карточки",
    ]) {
      await page.getByTitle(title, { exact: true }).click();
      const dialog = page.getByRole("dialog", { name: /^Справка тренажёра:/ });
      await expect(dialog.locator("input,textarea,select,form")).toHaveCount(0);
      await expect(dialog.getByRole("button")).toHaveCount(1);
      await expect(dialog).not.toContainText(
        /не описан|не раскрыт|в предоставленных материалах/,
      );
      await page.keyboard.press("Alt+z");
      await expect(dialog).toBeFocused();
      if (title.startsWith("ЧС"))
        await page.screenshot({
          path: "qa/results/arm-authentic-help.png",
          fullPage: false,
        });
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(new RegExp(lesson.card.id));
    }
    const events = await (
      await page.request.get(`/api/cards/${lesson.card.id}/events`)
    ).json();
    expect(
      events.filter((event: { type: string }) =>
        ["comment", "field_change", "status_change"].includes(event.type),
      ),
    ).toHaveLength(0);
    await page.screenshot({
      path: "qa/results/arm-authentic-card.png",
      fullPage: false,
    });
  });
});
