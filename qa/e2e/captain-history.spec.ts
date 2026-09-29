import { expect } from "@playwright/test";
import { test, login } from "./captain-fixture";

test.describe("Восстановление списка происшествий", () => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");

  for (const method of ["Назад браузера", "Escape"] as const) {
    test(`${method} до загрузки карточки сохраняет поиск, прокрутки и фокус`, async ({
      page,
      lesson,
    }) => {
      await page.setViewportSize({ width: 390, height: 400 });
      await login(page, "trainee05");
      const search = page.getByRole("textbox", { name: "Поиск происшествий" });
      await search.fill(lesson.card.source.number);
      const row = page.locator(`[data-card-id="${lesson.card.id}"]`);
      await expect(row).toContainText("Получена службой");
      await row.focus();
      await row.locator("td").last().scrollIntoViewIfNeeded();
      const position = await row.evaluate((element) => ({
        y: scrollY,
        tableX: element.closest("table")!.parentElement!.scrollLeft,
      }));
      expect(position.y).toBeGreaterThan(0);
      expect(position.tableX).toBeGreaterThan(0);
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/arm/cards/${lesson.card.id}$`));
      await expect(
        page.getByRole("button", { name: "Закрыть карточку", exact: true }),
      ).toBeVisible();

      let release = () => {};
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Задерживаем настоящий ответ после reload: список пока пуст и короче окна.
      await page.route("**/api/cards", async (route) => {
        await ready;
        await route.continue();
      });
      try {
        // В этой версии Firefox page.reload() добавляет запись в историю даже
        // на пустой HTML-странице. Нативное обновление сохраняет её корректно.
        const historyLength = await page.evaluate(() => history.length);
        await Promise.all([
          page.waitForEvent("load"),
          page.evaluate(() => location.reload()),
        ]);
        await expect(page.getByText("Загружаем карточку…")).toBeVisible();
        expect(await page.evaluate(() => history.length)).toBe(historyLength);
        if (method === "Escape") await page.keyboard.press("Escape");
        else await page.goBack();
        await expect(page).toHaveURL(/\/app\/arm$/);
        await expect(search).toHaveValue(lesson.card.source.number);
        release();
        await expect(row).toBeVisible();
        await expect(row).toBeFocused();
        await expect
          .poll(() =>
            row.evaluate((element) => ({
              y: scrollY,
              tableX: element.closest("table")!.parentElement!.scrollLeft,
            })),
          )
          .toEqual(position);
        // После восстановления пользователь может заново менять фильтр и позицию.
        await search.focus();
        await expect(search).toBeFocused();
        // На экране 390×400 над поиском стоят вкладки происшествий, и кнопка уходит
        // за край: click() прокрутил бы к ней сам. Проверяем, что прокручивает
        // (или нет) приложение. Фокусируем кнопку без прокрутки, как при
        // обычном нажатии, чтобы Firefox не тянул экран к прежнему input.
        const reset = page.getByRole("button", {
          name: "сбросить",
          exact: true,
        });
        await reset.evaluate((element) =>
          (element as HTMLElement).focus({ preventScroll: true }),
        );
        await page.evaluate(() => scrollTo(0, 0));
        await reset.dispatchEvent("click");
        await expect(search).toHaveValue("");
        await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      } finally {
        release();
      }
    });
  }

  test.describe("Загрузка отдельной карточки", () => {
    test.use({ secondCard: true });
    test("Переход из списка отменяет незавершённую загрузку скрытой истории", async ({
      page,
      lesson,
    }) => {
      test.setTimeout(60_000);
      const second = await lesson.issue();
      let release = () => {};
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Наблюдаем отмену браузером, не меняя fetch, ответ API или его данные.
      let requested = false;
      let cancelled = false;
      const path = `/api/cards/${second.id}/events`;
      page.on("requestfailed", (request) => {
        if (new URL(request.url()).pathname === path) cancelled = true;
      });
      await page.route(`**${path}`, async (route) => {
        if (route.request().method() === "GET") {
          requested = true;
          await ready;
        }
        await route.continue();
      });
      try {
        await login(page, "trainee05");
        await page
          .locator(`[data-card-id="${second.id}"]`)
          .scrollIntoViewIfNeeded();
        await expect.poll(() => requested).toBe(true);
        await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
        await expect(page).toHaveURL(
          new RegExp(`/arm/cards/${lesson.card.id}$`),
        );
        await expect.poll(() => cancelled).toBe(true);
        await expect(page.locator('[data-help="card-history"]')).toContainText(
          "карточка открыта",
        );
      } finally {
        release();
        await page.unrouteAll({ behavior: "wait" });
      }
    });

    test("Прямая ссылка не загружает истории скрытого списка", async ({
      page,
      lesson,
    }) => {
      test.setTimeout(60_000);
      const second = await lesson.issue();
      expect(second.id).not.toBe(lesson.card.id);
      await login(page, "trainee05");
      const historyRequests: string[] = [];
      page.on("request", (request) => {
        if (
          request.frame().url().endsWith(`/arm/cards/${lesson.card.id}`) &&
          /\/api\/cards\/[^/]+\/events$/.test(request.url()) &&
          request.method() === "GET"
        )
          historyRequests.push(new URL(request.url()).pathname);
      });
      await page.goto(`/app/arm/cards/${lesson.card.id}`);
      await expect(page.locator('[data-help="card-history"]')).toContainText(
        "карточка открыта",
      );
      expect(historyRequests.length).toBeGreaterThan(0);
      expect([...new Set(historyRequests)]).toEqual([
        `/api/cards/${lesson.card.id}/events`,
      ]);
    });
  });
});

test.describe("История статусов в карточке", () => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");

  test("Свежий статус виден без прокрутки, служебное — по «все действия»", async ({
    page,
    lesson,
  }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    const history = page.locator('[data-help="card-history"]');
    await expect(history).toContainText("карточка открыта");
    // По умолчанию на экране только ключевые записи (arm_dds/12).
    await expect(history.getByText(/карточка открыта/)).toBeHidden();
    await expect(history.getByText("Статусов пока нет.")).toBeVisible();
    for (const [state, text] of [
      ["rejected", "Требуется уточнение адреса у заявителя."],
      ["accepted", "Адрес уточнён, наряд направлен."],
    ] as const) {
      await page.getByRole("button", { name: /^Служба 102/ }).click();
      await page.getByLabel("Статус", { exact: true }).selectOption(state);
      await page.getByLabel("Комментарий", { exact: true }).fill(text);
      await page.keyboard.press("Enter");
      // Форма остаётся открытой: успешная отправка сбрасывает выбор статуса.
      await expect(page.getByLabel("Статус", { exact: true })).toHaveValue("");
    }
    const last = history.locator("li:not([hidden])").last();
    await expect(last).toContainText("Адрес уточнён, наряд направлен.");
    await expect(last).toBeInViewport();
    await history.getByRole("button", { name: "все действия" }).click();
    await expect(history.getByText(/карточка открыта/)).toBeVisible();
    await expect(history.locator("li").last()).toBeInViewport();
    await history.getByRole("button", { name: "только статусы" }).click();
    await expect(history.getByText(/карточка открыта/)).toBeHidden();
  });
});
