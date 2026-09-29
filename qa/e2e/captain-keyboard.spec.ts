import { expect } from "@playwright/test";
import { test, login } from "./captain-fixture";

test.describe("Клавиатура и подсказки карточки", () => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");

  test("Форма статуса принимает фокус и возвращает его после отмены и сохранения", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    const service = page.getByRole("button", { name: /Служба 102.*Получена/ });
    await service.focus();
    await page.keyboard.press("Enter");
    const status = page.getByRole("combobox", { name: "Статус", exact: true });
    await expect(status).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("textbox", { name: "Номер наряда" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    const comment = page.getByRole("textbox", {
      name: "Комментарий",
      exact: true,
    });
    await expect(comment).toBeFocused();
    await page.keyboard.insertText("Сведения проверены дежурным.");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Отменить", exact: true }),
    ).toBeFocused();
    // «Отменить» не закрывает форму: сбрасывает ввод и возвращает фокус к статусу.
    await page.keyboard.press("Enter");
    await expect(status).toBeFocused();
    await expect(comment).toHaveValue("");
    await status.selectOption("accepted");
    await comment.fill("Сведения проверены дежурным.");
    await status.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Подтвердить", exact: true }),
    ).toBeFocused();
    // Форма остаётся открытой, фокус снова в статусе — следующий ставится сразу.
    await page.keyboard.press("Enter");
    await expect(status).toBeFocused();
    await expect(status).toHaveValue("");
    await expect(comment).toHaveValue("");
    await expect(page.locator('[data-help="card-history"]')).toContainText(
      "Принята — Сведения проверены дежурным.",
    );
    await page.screenshot({
      path: test.info().outputPath("status-keyboard.png"),
    });
    await status.selectOption("completed");
    await comment.fill("Работы завершены, сведения переданы дежурному.");
    await page
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();
    await expect(page.getByText(/Нажмите ✓ ещё раз/)).toBeVisible();
    await page
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();
    await expect(status).toHaveCount(0);
    const close = page.getByRole("button", {
      name: "Закрыть карточку",
      exact: true,
    });
    await expect(close).toBeFocused();
    await expect(
      page.getByRole("button", { name: /Служба 102.*Работы завершены/ }),
    ).toBeDisabled();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/app\/arm$/);
    await expect(
      page.locator(`[data-card-id="${lesson.card.id}"]`),
    ).toBeFocused();
  });

  test("Карандаш и перенаправление возвращают фокус на свою кнопку", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    await page
      .getByRole("button", { name: "Развернуть Служба 102", exact: true })
      .click();
    const pencil = page.getByRole("button", {
      name: "Изменить статус",
      exact: true,
    });
    await pencil.focus();
    await page.keyboard.press("Enter");
    const status = page.getByRole("combobox", { name: "Статус", exact: true });
    await expect(status).toBeFocused();
    await page.getByRole("button", { name: "Отменить", exact: true }).click();
    await expect(status).toBeFocused();
    await status.selectOption("rejected");
    await page
      .getByRole("textbox", { name: "Комментарий", exact: true })
      .fill("Требуется другая служба.");
    await page
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();
    const redirect = page.getByRole("button", {
      name: "Перенаправить",
      exact: true,
    });
    await redirect.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("combobox", { name: "Служба для перенаправления" }),
    ).toBeFocused();
    // «Отменить» возвращает форму к статусу; «Перенаправить» — снова к службе.
    await page.getByRole("button", { name: "Отменить", exact: true }).click();
    await expect(status).toBeFocused();
    await redirect.focus();
    await page.keyboard.press("Enter");
    await page
      .getByRole("combobox", { name: "Служба для перенаправления" })
      .selectOption("101");
    await page
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Служба для перенаправления" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Закрыть карточку", exact: true }),
    ).toBeFocused();
    await expect(page.locator('[data-help="card-history"]')).toContainText(
      "перенаправление",
    );
  });

  test("Enter в поле отправляет статус, Esc закрывает только форму", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    const card = page.getByRole("region", {
      name: `Происшествие ${lesson.card.source.number}`,
      exact: true,
    });
    // Пока нет первичного статуса, в шапке горит норма реакции.
    await expect(card.locator("header")).toContainText("реакция");
    await expect(card).not.toContainText("Код типа");
    const service = page.getByRole("button", { name: /Служба 102.*Получена/ });
    await service.click();
    const status = page.getByRole("combobox", { name: "Статус", exact: true });
    const comment = page.getByRole("textbox", {
      name: "Комментарий",
      exact: true,
    });
    const confirm = page.getByRole("button", {
      name: "Подтвердить",
      exact: true,
    });
    await expect(confirm).toHaveAttribute("title", "Подтвердить");

    // Esc в комментарии: ввод сброшен, форма и карточка на месте, фокус в статусе.
    await status.selectOption("accepted");
    await comment.fill("Черновик");
    await comment.focus();
    await page.keyboard.press("Escape");
    await expect(status).toBeVisible();
    await expect(status).toHaveValue("");
    await expect(comment).toHaveValue("");
    await expect(page).toHaveURL(new RegExp(`/arm/cards/${lesson.card.id}$`));
    await expect(status).toBeFocused();

    // Ошибка пустого комментария уходит с первым введённым символом.
    await service.click();
    await status.selectOption("accepted");
    await comment.fill("");
    await confirm.click();
    const error = page
      .getByRole("group", { name: "Действие по карточке" })
      .locator("..")
      .getByRole("alert");
    await expect(error).toBeVisible();
    await comment.focus();
    await page.keyboard.type("П");
    await expect(error).toHaveCount(0);

    // Shift+Enter не отправляет, Enter — отправляет.
    await page.keyboard.insertText("ринята, наряд направлен.");
    await page.keyboard.press("Shift+Enter");
    await expect(status).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(status).toHaveValue("");
    await expect(page.locator('[data-help="card-history"]')).toContainText(
      "Принята — Принята, наряд направлен.",
    );
    await expect(card.locator("header")).toContainText("обработка");

    // Новый статус: прошлый комментарий карточки уступает место подсказке.
    await page.getByRole("button", { name: /Служба 102.*Принята/ }).click();
    await status.selectOption("completed");
    await expect(comment).toHaveValue("");
    await expect(comment).toHaveAttribute("placeholder", /результаты работ/);
    await comment.fill("Работы завершены, сведения переданы.");
    await page.keyboard.press("Enter");
    await expect(page.getByText(/Нажмите ✓ ещё раз/)).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(status).toHaveCount(0);
    await expect(page.locator('[data-help="card-history"]')).toContainText(
      "Работы завершены — Работы завершены, сведения переданы.",
    );
  });

  test("Лента описания стоит выше ввода адреса", async ({ page, lesson }) => {
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    const feed = page.locator('[data-help="card-description"]');
    await expect(feed).toBeVisible();
    const before = await feed.evaluate((element) => {
      const input = document.querySelector('[data-help="card-address-input"]')!;
      return Boolean(
        element.compareDocumentPosition(input) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
    expect(before).toBe(true);
  });

  test("Каждая подсказка помещается на мобильном экране", async ({
    page,
    lesson,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    await page.getByRole("button", { name: /Служба 102.*Получена/ }).click();
    for (const label of ["адрес", "статус", "номер наряда", "комментарий"]) {
      const hint = page.getByRole("button", {
        name: `Подсказка: ${label}`,
        exact: true,
      });
      await hint.click();
      const note = page.getByRole("note");
      await expect(note).toBeVisible();
      await note.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: test.info().outputPath(`hint-${label}.png`),
      });
      const trigger = await hint.boundingBox();
      // Длинный текст не должен сжимать кнопку в почти неразличимую полоску.
      expect(trigger!.width, label).toBeGreaterThanOrEqual(20);
      expect(trigger!.height, label).toBeGreaterThanOrEqual(20);
      const bounds = await note.boundingBox();
      expect(bounds!.x, label).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width, label).toBeLessThanOrEqual(390);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
        label,
      ).toBeLessThanOrEqual(390);
      await page.keyboard.press("Escape");
      await expect(note).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/arm/cards/${lesson.card.id}$`));
    }
  });
});
