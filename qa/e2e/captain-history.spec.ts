import { expect } from "@playwright/test";
import { test, login } from "./captain-fixture";
import { confirmAgain } from "./trainer";

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
      // На узком экране значки строки (макет B, arm_dds/03) скрыты: докручиваем
      // до последней видимой колонки — «Состояние».
      await row.locator("td:visible").last().scrollIntoViewIfNeeded();
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
    // Реестр истории строк не грузит (колонки «Реакция» нет — макет B). На занятии
    // (тест) строк «Принята» ждёт нет совсем (решение 17.10): историю другой карточки
    // не читает никто, и открытие своей ничто не задерживает.
    test("История другой карточки на занятии не грузится и не задерживает открытие", async ({
      page,
      lesson,
    }) => {
      test.setTimeout(60_000);
      const second = await lesson.issue();
      let release = () => {};
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      let requested = false;
      const path = `/api/cards/${second.id}/events`;
      await page.route(`**${path}`, async (route) => {
        if (route.request().method() === "GET") {
          requested = true;
          await ready;
        }
        await route.continue();
      });
      try {
        await login(page, "trainee05");
        await expect(
          page.locator(`[data-card-id="${second.id}"]`),
        ).toBeVisible();
        await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
        await expect(page).toHaveURL(
          new RegExp(`/arm/cards/${lesson.card.id}$`),
        );
        await expect(page.locator('[data-help="card-history"]')).toContainText(
          "карточка открыта",
        );
        expect(requested).toBe(false);
        await expect(
          page.getByRole("region", { name: "Подсказка тренажёра" }),
        ).toHaveCount(0);
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
      // Кроме открытой карточки историю не читает никто: строк «Принята» ждёт по
      // другим карточкам на занятии нет (решение 17.10), скрытый реестр историй не грузит.
      const visible = new Set([`/api/cards/${lesson.card.id}/events`]);
      expect(historyRequests).toContain(`/api/cards/${lesson.card.id}/events`);
      expect(
        [...new Set(historyRequests)].filter((item) => !visible.has(item)),
      ).toEqual([]);
    });
  });
});

test.describe("История статусов в карточке", () => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");

  test("Панель истории: свежий статус виден, служебное скрыто", async ({
    page,
    lesson,
  }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    const history = page.locator('[data-help="card-history"]');
    // Журнал целиком в разметке, но окно закрыто, пока его не откроют (arm_dds/06).
    await expect(history).toContainText("карточка открыта");
    await expect(history).toBeHidden();
    const toggle = page.getByRole("button", {
      name: "История статусов",
      exact: true,
    });
    await toggle.click();
    await expect(history).toBeVisible();
    await expect(history).toContainText("Добавлена");
    let releaseHistory = () => {};
    const historyReady = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    const eventsRoute = `**/api/cards/${lesson.card.id}/events`;
    // После подтверждённого статуса строка уже готова к следующему. Медленная
    // история не должна блокировать отправку следующего статуса по Enter (#93).
    await page.route(eventsRoute, async (route) => {
      if (route.request().method() === "GET") await historyReady;
      await route.continue();
    });
    try {
      for (const [state, text] of [
        ["rejected", "Требуется уточнение адреса у заявителя."],
        ["accepted", "Адрес уточнён, наряд направлен."],
      ] as const) {
        await page
          .getByRole("button", { name: "Изменить статус", exact: true })
          .click();
        await page.getByLabel("Статус", { exact: true }).selectOption(state);
        await page.getByLabel("Комментарий", { exact: true }).fill(text);
        await page.keyboard.press("Enter");
        // «Не принята» — второй Enter сохраняет её (первый взводит, подпись у ✓).
        if (state === "rejected") {
          await expect(confirmAgain(page)).toBeVisible();
          await page.keyboard.press("Enter");
        }
        // Строка статуса всегда на виду (DT-19): после сохранения она очищена.
        await expect(page.getByLabel("Статус", { exact: true })).toHaveValue(
          "",
        );
      }
    } finally {
      releaseHistory();
      await page.unrouteAll({ behavior: "wait" });
    }
    await toggle.click();
    // По умолчанию видны статусы и комментарии, технические записи — в «Все действия».
    const last = history.locator("tr[data-history-id]:not([hidden])").last();
    await expect(last).toContainText("Адрес уточнён, наряд направлен.");
    await expect(last).toBeInViewport();
    await expect(history.getByText(/карточка открыта/)).toBeHidden();
    await history.getByRole("button", { name: "Все действия", exact: true }).click();
    await expect(history.getByText(/карточка открыта/)).toBeVisible();
    await history.getByRole("button", { name: "Статусы и комментарии", exact: true }).click();
    await history.getByRole("searchbox", { name: "Поиск по истории" }).fill("Адрес уточнён");
    const comment = history.getByRole("button", { name: /^Комментарий: Принята,/ });
    await comment.click();
    await expect(history.getByRole("region", { name: "Полный комментарий: Принята" })).toHaveText(
      "Адрес уточнён, наряд направлен.",
    );
    // Esc закрывает окно истории, карточка остаётся открытой.
    await page.keyboard.press("Escape");
    await expect(history).toBeHidden();
    await expect(toggle).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/arm/cards/${lesson.card.id}$`));
  });
});
