import { expect } from "@playwright/test";
import { test, login } from "./captain-fixture";
import { confirmAgain } from "./trainer";

test.describe("Клавиатура и подсказки карточки", () => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");

  // Строка статуса всегда на виду (DT-19): карандаш ставит фокус в «Статус»,
  // ✕ и сохранение очищают её и возвращают фокус к карандашу.
  test("Строка статуса принимает фокус и возвращает его к карандашу", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    const pencil = page.getByRole("button", {
      name: "Изменить статус",
      exact: true,
    });
    await pencil.focus();
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
    // Tab по полям строки по кругу: с ✕ — снова в «Статус».
    await page.keyboard.press("Tab");
    await expect(status).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    // ✕ очищает строку без сохранения, фокус — на карандаше.
    await page.keyboard.press("Enter");
    await expect(comment).toHaveValue("");
    await expect(pencil).toBeFocused();
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
    await page.keyboard.press("Enter");
    await expect(status).toHaveValue("");
    await expect(pencil).toBeFocused();
    await expect(page.locator('[data-help="card-history"]')).toContainText(
      "Принята — Сведения проверены дежурным.",
    );
    await page.screenshot({
      path: test.info().outputPath("status-keyboard.png"),
    });
    await pencil.click();
    await status.selectOption("completed");
    await comment.fill("Работы завершены, сведения переданы дежурному.");
    await page
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();
    // Необратимый статус — вторым ✓: у ✓ подпись «Нажмите ✓ или Enter ещё раз» (17.10).
    await expect(confirmAgain(page)).toBeVisible();
    await page
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();
    await expect(status).toHaveCount(0);
    const close = page.getByRole("button", {
      name: "Закрыть карточку",
      exact: true,
    });
    await expect(close).toBeFocused();
    // Карточка закрыта — карандаша на своей плитке нет.
    await expect(pencil).toHaveCount(0);
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
    const pencil = page.getByRole("button", {
      name: "Изменить статус",
      exact: true,
    });
    await pencil.focus();
    await page.keyboard.press("Enter");
    const status = page.getByRole("combobox", { name: "Статус", exact: true });
    await expect(status).toBeFocused();
    await page.getByRole("button", { name: "Отменить", exact: true }).click();
    await expect(pencil).toBeFocused();
    await pencil.click();
    await status.selectOption("rejected");
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
    const redirect = page.getByRole("button", {
      name: "Перенаправить",
      exact: true,
    });
    await redirect.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("combobox", { name: "Служба для перенаправления" }),
    ).toBeFocused();
    // «Отменить» закрывает строку; «Перенаправить» — снова к службе.
    await page.getByRole("button", { name: "Отменить", exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: "Служба для перенаправления" }),
    ).toHaveCount(0);
    await redirect.focus();
    await page.keyboard.press("Enter");
    await page
      .getByRole("combobox", { name: "Служба для перенаправления" })
      .selectOption("101");
    // Причина перенаправления обязательна (T-013); «Отменить» выше очистил поле.
    await page
      .getByRole("textbox", { name: "Комментарий", exact: true })
      .fill("Требуется служба 101.");
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

  test("Enter в поле отправляет статус, Esc уводит фокус из строки", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    const card = page.getByRole("region", {
      name: `Происшествие ${lesson.card.source.number}`,
      exact: true,
    });
    // Учебных таймеров в АРМ нет (макет B): время до «Принята» — в учебном слое.
    await expect(card.locator("header")).not.toContainText("реакция");
    await expect(card).not.toContainText("Код типа");
    const pencil = page.getByRole("button", {
      name: "Изменить статус",
      exact: true,
    });
    await pencil.click();
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

    // Esc в комментарии: фокус на карандаше, черновик цел, карточка на месте.
    await status.selectOption("accepted");
    await comment.fill("Черновик");
    await comment.focus();
    await page.keyboard.press("Escape");
    await expect(comment).toHaveValue("Черновик");
    await expect(page).toHaveURL(new RegExp(`/arm/cards/${lesson.card.id}$`));
    await expect(pencil).toBeFocused();

    // Ошибка пустого комментария уходит с первым введённым символом.
    await page.getByRole("button", { name: "Отменить", exact: true }).click();
    await expect(comment).toHaveValue("");
    await status.selectOption("accepted");
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

    // Новый статус: поле комментария пустое, в нём подсказка, что писать (DT-19).
    await pencil.click();
    await status.selectOption("completed");
    await expect(comment).toHaveValue("");
    await expect(comment).toHaveAttribute("placeholder", /^результаты работ/);
    await comment.fill("Работы завершены, сведения переданы.");
    await page.keyboard.press("Enter");
    // Второй Enter сохраняет взведённый необратимый статус (подпись у ✓, 17.10).
    await expect(confirmAgain(page)).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(status).toHaveCount(0);
    await expect(page.locator('[data-help="card-history"]')).toContainText(
      "Работы завершены — Работы завершены, сведения переданы.",
    );
  });

  // DT-14 (08.10): адрес у ДДС только для чтения, как на снимках arm_dds 06–20.
  test("Адрес в карточке только для чтения", async ({ page, lesson }) => {
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    await expect(page.locator('[data-help="card-address"]')).toBeVisible();
    await expect(page.locator('[data-help="card-address-input"]')).toHaveCount(
      0,
    );
    await expect(page.getByLabel(/^Адрес: /)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Сохранить адрес" }),
    ).toHaveCount(0);
  });

  // Подсказки «?» у полей карточки (адрес, статус, номер наряда, комментарий) убраны
  // 29.09 (df0b29c): подсказывает проводник тренировки у нужной кнопки — DT-07,
  // qa/e2e/tutor-pointer.spec.ts. Проверка их размеров на мобильном экране снята.
});
