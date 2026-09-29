import { expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { test, login } from "./captain-fixture";

test("Значок вкладки и чистая консоль входа", async ({ page }) => {
  const errors: string[] = [];
  const missing: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (e) => {
    if (e.type() === "error") errors.push(e.text());
  });
  page.on("response", (r) => {
    if (r.url().endsWith("/favicon.ico") && r.status() === 404)
      missing.push(r.url());
  });
  await page.goto("/app/login");
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute("href", /^data:image\/svg\+xml,/);
  const href = (await icon.getAttribute("href"))!;
  const svg = decodeURIComponent(href.slice(href.indexOf(",") + 1));
  expect(svg).toContain("112");
  expect(svg).toContain("#2e353b");
  expect(svg).toContain("white");
  const loaded = await page.evaluate(async () => {
    const image = new Image();
    image.src =
      document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href;
    await image.decode();
    return image.naturalWidth > 0;
  });
  expect(loaded).toBe(true);
  await expect(
    page.getByRole("button", { name: "Объяснение экрана" }),
  ).toHaveCount(0);
  expect(missing).toEqual([]);
  expect(errors).toEqual([]);
});

test.describe("Стенд с БД", () => {
  test.use({ secondCard: true });
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");
  test("Пустой поиск объясняет отсутствие совпадений и позволяет сбросить фильтр", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    const row = page.locator(`[data-card-id="${lesson.card.id}"]`);
    await expect(row).toBeVisible();
    await page
      .getByRole("textbox", { name: "Поиск происшествий" })
      .fill("Несуществующий адрес для проверки поиска");
    await expect(row).toBeHidden();
    await expect(page.getByRole("status")).toHaveText(
      "По вашему запросу ничего не найдено. Измените запрос или нажмите «сбросить».",
    );
    await expect(
      page.getByText("Происшествий нет. Дождитесь карточки от Системы 112."),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "сбросить", exact: true }).click();
    await expect(row).toBeVisible();
  });

  test("Сбой загрузки списка не выдаётся за отсутствие происшествий", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    await page.route("**/api/cards", async (route) => {
      const retryClicked = await page.evaluate(
        () => document.documentElement.dataset.retryCards === "true",
      );
      if (retryClicked) await route.continue();
      else await route.abort("failed");
    });
    await page.reload();
    await expect(page.getByRole("alert")).toContainText(
      "Не удалось загрузить происшествия.",
      { timeout: 20_000 },
    );
    await expect(
      page.getByText("Происшествий нет. Дождитесь карточки от Системы 112."),
    ).toHaveCount(0);
    const retry = page.getByRole("button", { name: "Повторить", exact: true });
    // Соединение восстанавливается именно при нажатии. Иначе запрос из WS
    // успевает убрать ошибку и кнопку между unroute и настоящим кликом.
    await page.evaluate(() => {
      document.addEventListener(
        "click",
        (event) => {
          // При автоматическом запросе кнопка может перемонтироваться.
          if (
            event.target instanceof Element &&
            event.target.closest("button")?.textContent?.trim() === "Повторить"
          )
            document.documentElement.dataset.retryCards = "true";
        },
        { capture: true },
      );
    });
    await retry.click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-retry-cards",
      "true",
    );
    await expect(
      page.locator(`[data-card-id="${lesson.card.id}"]`),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    // Дожидаемся обработчиков: unroute во время page.evaluate мог продолжить
    // запрос раньше route.continue и вызвать в Firefox «Route is already handled».
    await page.unrouteAll({ behavior: "wait" });
  });
  test("Материалы: русский выбор файла доступен с клавиатуры", async ({
    page,
  }) => {
    await login(page, "teacher");
    await page.getByRole("button", { name: "Материалы", exact: true }).click();
    await expect(page.locator('input[type="file"]')).toBeHidden();
    await expect(
      page.getByText("Файл не выбран", { exact: true }),
    ).toBeVisible();
    const choose = page.getByRole("button", {
      name: "Выбрать файл",
      exact: true,
    });
    await choose.focus();
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.keyboard.press("Enter"),
    ]);
    await chooser.setFiles({
      name: "Памятка.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"текст":"Учебный материал"}'),
    });
    await expect(page.getByRole("status")).toHaveText("Памятка.json");
    await expect(
      page.getByRole("textbox", { name: "Название", exact: true }),
    ).toHaveValue("Памятка");
    await expect(
      page.getByRole("button", { name: "Загрузить", exact: true }),
    ).toBeEnabled();
    await page.locator('input[type="file"]').setInputFiles({
      name: "Программа.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("не документ"),
    });
    await expect(
      page.getByText(/^Тип файла не поддерживается\./),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Загрузить", exact: true }),
    ).toBeDisabled();
  });
  test("Карточка: адрес, история, новая выдача и размеры окна", async ({
    page,
    lesson,
  }) => {
    test.setTimeout(90_000);
    await login(page, "trainee05");
    await page.setViewportSize({ width: 1280, height: 300 });
    await page
      .getByRole("textbox", { name: "Поиск происшествий" })
      .fill(lesson.card.source.incident_class);
    const row = page.locator(`[data-card-id="${lesson.card.id}"]`);
    await row.scrollIntoViewIfNeeded();
    const scroll = await page.evaluate(() => scrollY);
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/arm/cards/${lesson.card.id}$`));
    await expect(page).toHaveTitle(`Происшествие ${lesson.card.source.number}`);
    await expect(
      page.getByRole("heading", { name: "Список происшествий" }),
    ).toBeHidden();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goBack();
    await expect(row).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Поиск происшествий" }),
    ).toHaveValue(lesson.card.source.incident_class);
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(scroll);
    await page.goForward();
    await expect(
      page.getByRole("button", { name: "Закрыть карточку" }),
    ).toBeVisible();
    await page.reload();
    await expect(page).toHaveTitle(`Происшествие ${lesson.card.source.number}`);
    // После reload заголовок приходит раньше подтверждённых действий и очереди.
    // Снимок должен показывать уже открытую карточку, а не промежуточную загрузку.
    await expect(page.locator('[data-help="card-history"]')).toContainText(
      "карточка открыта",
    );
    await expect(
      page.getByRole("button", { name: /Служба 102.*Получена/ }),
    ).toBeVisible();
    await expect(
      page.getByText("Действия ещё не подтверждены сервером", { exact: true }),
    ).toHaveCount(0, { timeout: 30_000 });
    mkdirSync("scripts/ralph/artwox/logs", { recursive: true });
    for (const [width, height] of [
      [1280, 600],
      [1920, 1080],
    ]) {
      await page.setViewportSize({ width, height });
      await expect(
        page.getByRole("button", { name: "Закрыть карточку" }),
      ).toBeInViewport({ ratio: 1 });
      const dimensions = await page.evaluate(() => ({
        height: document.documentElement.scrollHeight,
        width: document.documentElement.scrollWidth,
        header: document.querySelector("header")!.getBoundingClientRect()
          .height,
        top: document.querySelector("main")!.getBoundingClientRect().top,
      }));
      expect(dimensions.height).toBeLessThanOrEqual(height);
      expect(dimensions.width).toBeLessThanOrEqual(width);
      expect(dimensions.header).toBeLessThanOrEqual(68);
      expect(dimensions.top).toBe(dimensions.header);
      await page.screenshot({
        path: `scripts/ralph/artwox/logs/after-${width}x${height}.png`,
      });
    }
    const second = await lesson.issue();
    await page.getByRole("button", { name: "Закрыть карточку" }).click();
    await expect(
      page.getByRole("textbox", { name: "Поиск происшествий" }),
    ).toHaveValue(lesson.card.source.incident_class);
    await expect(page.locator(`[data-card-id="${second.id}"]`)).toBeVisible();
    await page.goto(`/app/arm/cards/${lesson.card.id}`);
    await expect(page).toHaveTitle(`Происшествие ${lesson.card.source.number}`);
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/app\/arm$/);
    await page.goto("/app/arm/cards/unknown");
    await expect(page.getByRole("alert")).toContainText("Карточка не найдена");
    await page.getByRole("button", { name: "К списку происшествий" }).click();
    await expect(page).toHaveURL(/\/app\/arm$/);
  });

  test("Карточка на телефоне и переходы преподавателя", async ({
    page,
    browser,
    lesson,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    // Снимок и размеры проверяем после загрузки прав, подсказок и истории.
    await expect(page.locator('[data-help="card-history"]')).toContainText(
      "карточка открыта",
    );
    await expect(
      page.getByRole("button", { name: /Служба 102.*Получена/ }),
    ).toBeVisible();
    await expect(
      page.getByText("Действия ещё не подтверждены сервером", { exact: true }),
    ).toHaveCount(0, { timeout: 30_000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole("button", { name: "Объяснение экрана" }),
    ).toBeInViewport({ ratio: 1 });
    await page.getByRole("button", { name: "Объяснение экрана" }).click();
    await expect(page.locator("[data-help-ui] h2")).toHaveText(/^\d+\. /);
    await page.screenshot({
      path: "scripts/ralph/artwox/logs/mobile-card-help.png",
    });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Закрыть карточку" }).click();
    await expect(page).toHaveURL(/\/app\/arm$/);
    const teacher = await browser.newPage({
      baseURL: test.info().project.use.baseURL,
    });
    try {
      await login(teacher, "teacher");
      const navigation = teacher.getByRole("navigation", {
        name: "Переходы по кабинету",
      });
      await navigation.getByRole("button", { name: "На главную" }).click();
      await teacher.getByRole("button", { name: "+ Новое занятие" }).click();
      await teacher.getByRole("button", { name: /^Студия сценариев/ }).click();
      await navigation
        .getByRole("button", { name: "Назад", exact: true })
        .click();
      await expect(
        teacher.getByRole("heading", { name: "Новое занятие", exact: true }),
      ).toBeVisible();
      await navigation
        .getByRole("button", { name: "Вперёд", exact: true })
        .click();
      await expect(
        teacher.getByRole("heading", { name: "Студия сценариев", exact: true }),
      ).toBeVisible();
      await teacher.goBack();
      await expect(
        teacher.getByRole("heading", { name: "Новое занятие", exact: true }),
      ).toBeVisible();
      await teacher.reload();
      await expect(
        teacher.getByRole("heading", { name: "Новое занятие", exact: true }),
      ).toBeVisible();
      await navigation.getByRole("button", { name: "На главную" }).click();
      await expect(
        teacher.getByRole("heading", { name: "Занятие не выбрано" }),
      ).toBeVisible();
    } finally {
      await teacher.close();
    }
  });

  test("Esc после справки возвращает из карточки к найденной строке", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    const search = page.getByRole("textbox", { name: "Поиск происшествий" });
    await search.fill(lesson.card.source.number);
    const row = page.locator(`[data-card-id="${lesson.card.id}"]`);
    await row.focus();
    await page.keyboard.press("Enter");
    const help = page.getByRole("button", {
      name: "Объяснение экрана",
      exact: true,
    });
    await help.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-help-ui] [role="region"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(help).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/arm/cards/${lesson.card.id}$`));
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/app\/arm$/);
    await expect(search).toHaveValue(lesson.card.source.number);
    await expect(row).toBeFocused();
  });

  test("Возврат после перезагрузки сохраняет обе прокрутки и поиск", async ({
    page,
    lesson,
  }) => {
    await page.setViewportSize({ width: 390, height: 400 });
    await login(page, "trainee05");
    const search = page.getByRole("textbox", { name: "Поиск происшествий" });
    await search.fill(lesson.card.source.number);
    const row = page.locator(`[data-card-id="${lesson.card.id}"]`);
    await expect(row).toContainText("Получена службой");
    await expect(
      page.getByRole("button", { name: "Объяснение экрана" }),
    ).toBeVisible();
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
    await page.reload();
    await expect(page).toHaveTitle(`Происшествие ${lesson.card.source.number}`);
    await page
      .getByRole("button", { name: "Закрыть карточку", exact: true })
      .click();
    await expect(search).toHaveValue(lesson.card.source.number);
    await expect(row).toBeFocused();
    mkdirSync("scripts/ralph/artwox/logs/recheck", { recursive: true });
    writeFileSync(
      `scripts/ralph/artwox/logs/recheck/scroll-${test.info().project.name}.json`,
      JSON.stringify(
        {
          before: position,
          after: await row.evaluate((element) => ({
            y: scrollY,
            maxY: document.documentElement.scrollHeight - innerHeight,
            tableX: element.closest("table")!.parentElement!.scrollLeft,
            maxTableX:
              element.closest("table")!.parentElement!.scrollWidth -
              element.closest("table")!.parentElement!.clientWidth,
            saved: Object.entries(sessionStorage).filter(([key]) =>
              key.startsWith("arm:return:"),
            ),
          })),
        },
        null,
        2,
      ),
    );
    await expect
      .poll(() =>
        row.evaluate((element) => ({
          y: scrollY,
          tableX: element.closest("table")!.parentElement!.scrollLeft,
        })),
      )
      .toEqual(position);
  });

  test("Рабочие панели не расширяют карточку на невысоком экране", async ({
    page,
    lesson,
  }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    await page.getByRole("button", { name: /Служба 102.*Получена/ }).click();
    await page
      .getByRole("button", { name: "Подсказка: комментарий", exact: true })
      .click();
    await expect(page.getByRole("note")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Подтвердить", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(
      page.getByRole("button", { name: "Закрыть карточку", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    expect(
      await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      })),
    ).toEqual({ width: 1280, height: 600 });
    await page.screenshot({
      path: "scripts/ralph/artwox/logs/recheck/card-action-1280x600.png",
    });
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/arm/cards/${lesson.card.id}$`));
    await page.getByRole("button", { name: "Отменить", exact: true }).click();
    await page.getByRole("button", { name: "Телефон", exact: true }).click();
    expect(
      await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      })),
    ).toEqual({ width: 1280, height: 600 });
    await expect(
      page.getByRole("button", { name: "Закрыть карточку", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: "scripts/ralph/artwox/logs/recheck/card-phone-1280x600.png",
    });
  });

  for (const account of ["trainee05", "teacher"]) {
    test(`Мобильная шапка: ${account}`, async ({ page, lesson }) => {
      expect(lesson.card.id).toBeTruthy();
      await page.setViewportSize({ width: 390, height: 844 });
      await login(page, account);
      if (account === "teacher") {
        await page.getByRole("button", { name: lesson.session.title }).click();
        await expect(page.getByRole("tabpanel")).toBeVisible();
        await expect(
          page.getByText(/^(?:Загрузка|Загружаем)(?:\s.*)?…$/i),
        ).toHaveCount(0);
      }
      const help = page.getByRole("button", { name: "Объяснение экрана" });
      await expect(help).toBeInViewport({ ratio: 1 });
      await expect(
        page.getByRole("button", { name: "Выйти", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `scripts/ralph/artwox/logs/mobile-${account}.png`,
        // Накопленные тестовые карточки делают полный снимок списка нечитаемым.
        // Шапку обучаемого снимаем в размере проверяемого окна 390×844.
        fullPage: account === "teacher",
      });
      await help.click();
      await expect(
        page.locator('[data-help-ui] [role="region"]'),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await expect(help).toBeFocused();
    });
  }
});

// Реестр и навигация (ux/registry-nav): первый экран без занятия, группа кнопок
// в порядке пути, подпись службы, «/» к поиску, строка «Описание:».
test.describe("Первый экран реестра", () => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");

  test("Без занятия реестр ведёт на тренировку текущей ступени", async ({
    page,
  }) => {
    const json = (body: unknown) => ({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    await page.route("**/api/cards", (route) => route.fulfill(json([])));
    await page.route("**/api/sessions", (route) => route.fulfill(json([])));
    await page.route("**/api/materials", (route) => route.fulfill(json([])));
    await page.route("**/api/progress", (route) =>
      route.fulfill(
        json([
          { user_id: "u", full_name: "Обучаемый", current_step: 3, steps: [] },
        ]),
      ),
    );
    await login(page, "trainee05");

    // Подсказка называет кнопку так же, как она подписана: текущая ступень пути.
    await expect(page.getByRole("status")).toHaveText(
      "Занятие ещё не начато. Чтобы потренироваться самостоятельно, нажмите «Тренировка: ступень 3».",
    );
    await expect(
      page.getByText("Происшествий нет. Дождитесь карточки от Системы 112."),
    ).toHaveCount(0);

    // Подпись службы — обычным кеглем, имя службы выделено.
    const counter = page.locator("h2 span", { hasText: "ваша служба:" });
    await expect(counter.locator("strong")).toHaveText("занятие не начато");
    const sizes = await counter.evaluate((el) => ({
      size: getComputedStyle(el).fontSize,
      token: getComputedStyle(document.documentElement)
        .getPropertyValue("--font-size")
        .trim(),
    }));
    expect(sizes.size).toBe(sizes.token);

    // Кнопки — одной группой в порядке пути, «Тренировка» — текущая ступень.
    const group = page
      .getByRole("button", { name: "Мой путь", exact: true })
      .locator("..");
    await expect(group.getByRole("button")).toHaveText([
      "Тренировка: ступень 3",
      "Мой путь",
      "Проверьте себя",
      "Мои результаты",
      "Справка",
    ]);

    // «/» вне поля ввода — к поиску; в поле «/» печатается как обычно.
    const search = page.getByRole("textbox", { name: "Поиск происшествий" });
    await expect(search).toHaveAttribute("placeholder", /\/ — поиск/);
    await page.locator("body").click({ position: { x: 5, y: 300 } });
    await page.keyboard.press("/");
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("");
    await page.keyboard.press("/");
    await expect(search).toHaveValue("/");

    // «Справка» без материалов показывает порядок работы, а не пустой экран.
    await page.getByRole("button", { name: "Справка", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/arm\/reference$/);
    await expect(
      page
        .getByRole("region", { name: "Справка" })
        .getByText("Карточка поступила", { exact: true }),
    ).toBeVisible();

    // «Мои результаты» в шапке — тот же экран, что кнопка над реестром.
    await page
      .getByRole("banner")
      .getByRole("link", { name: "Мои результаты" })
      .click();
    await expect(page).toHaveURL(/\/app\/arm\/results$/);
  });

  test("Строка «Описание:» и клавиши реестра", async ({ page }) => {
    // Две карточки из фикстуры ответа: стенд не нужен занятием, проверка — о реестре.
    const card = (id: string, number: string, description: string) => ({
      id,
      assignment_id: `a-${id}`,
      trainee_id: "t",
      session_id: "00000000-0000-4000-8000-00000000abcd",
      state: "received",
      appeared_at: new Date(
        Date.now() - Number(number.slice(-1)) * 1000,
      ).toISOString(),
      delivered_at: null,
      opened_at: null,
      closed_at: null,
      interrupted_at: null,
      source: {
        number,
        emergency: false,
        incident_class: "Пожар",
        victims: false,
        description,
        address: { city: "Москва", street: "ул. Тверская", house: "1" },
      },
      current: {},
    });
    const cards = [
      card(
        "11111111-1111-4111-8111-111111111111",
        "5000001",
        "Горит мусор во дворе, дым у окон",
      ),
      card(
        "22222222-2222-4222-8222-222222222222",
        "5000002",
        "Задымление в подъезде",
      ),
    ];
    await page.route("**/api/cards", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(cards),
      }),
    );
    await login(page, "trainee05");
    const rows = page.locator("[data-card-id]");
    await expect(rows).toHaveCount(2);

    // Описание — второй строкой под происшествием (arm_dds/03).
    const first = rows.first();
    const description = first.locator("xpath=following-sibling::tr[1]");
    await expect(description).toContainText("Описание:");
    await expect(description).toContainText("Горит мусор во дворе");
    await expect(description).not.toHaveAttribute("data-card-id");

    // ↓ из поиска — к первой строке; ↓ дальше — к следующей карточке,
    // строка описания пропускается.
    await page.getByRole("textbox", { name: "Поиск происшествий" }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(first).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(first).toBeFocused();

    // Щелчок по строке описания открывает ту же карточку.
    await description.click();
    await expect(page).toHaveURL(new RegExp(`/app/arm/cards/${cards[0].id}$`));
  });
});
