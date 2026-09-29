import { expect, type Page, type Locator } from "@playwright/test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { test, login } from "./captain-fixture";
import { visitAdmin, visitTeacher } from "./captain-screens";

async function readable(locator: Locator) {
  const measured = await locator.evaluate((el) => {
    const style = getComputedStyle(el);
    const channels = (value: string) =>
      value
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
        .map((v) => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
    const luminance = (value: string) => {
      const [r, g, b] = channels(value);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    let background = style.backgroundColor;
    for (
      let parent = el.parentElement;
      (background === "rgba(0, 0, 0, 0)" || background === "transparent") &&
      parent;
      parent = parent.parentElement
    )
      background = getComputedStyle(parent).backgroundColor;
    const text = luminance(style.color),
      fill = luminance(background);
    return {
      label: el.getAttribute("aria-label") ?? el.textContent?.slice(0, 80),
      size: parseFloat(style.fontSize),
      line: parseFloat(style.lineHeight) / parseFloat(style.fontSize),
      contrast: (Math.max(text, fill) + 0.05) / (Math.min(text, fill) + 0.05),
    };
  });
  expect(measured.size).toBeGreaterThanOrEqual(14);
  expect(measured.line).toBeGreaterThanOrEqual(1.4);
  expect(measured.contrast).toBeGreaterThanOrEqual(4.5);
  appendFileSync(
    "scripts/ralph/artwox/logs/readability.jsonl",
    JSON.stringify(measured) + "\n",
  );
}

async function explain(page: Page, name: string) {
  await expect(
    page.getByText(/^(?:Загрузка|Загружаем)(?:\s.*)?…$/i),
  ).toHaveCount(0);
  await page.evaluate(() => scrollTo(0, 0));
  const button = page.getByRole("button", {
    name: "Объяснение экрана",
    exact: true,
  });
  await expect(button, name).toHaveCount(1);
  await button.click();
  const help = page.locator('[data-help-ui] [role="region"]');
  await expect(help, name).toBeVisible();
  await expect(help.getByRole("heading")).toHaveText(/^\d+\. /);
  await readable(help);
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  await expect(button).toBeFocused();
}

test.describe("Справка всех ролей", () => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");
  test("Справка перенаправления объясняет выбор службы и причину", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    await page.getByRole("button", { name: /Служба 102.*Получена/ }).click();
    await page
      .getByRole("combobox", { name: "Статус", exact: true })
      .selectOption("rejected");
    await page
      .getByRole("textbox", { name: "Комментарий", exact: true })
      .fill("Карточка адресована другой службе, сведения переданы дежурному.");
    await page
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Перенаправить", exact: true })
      .click();
    await expect(
      page.getByText("Действия ещё не подтверждены сервером", { exact: true }),
    ).toHaveCount(0, { timeout: 30_000 });
    const action = page.getByRole("group", { name: "Действие по карточке" });
    await expect(
      action.getByRole("combobox", { name: "Служба для перенаправления" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Объяснение экрана", exact: true })
      .click();
    await action.hover();
    const help = page.locator('[data-help-ui] [role="region"]');
    await expect(help.getByRole("heading")).toContainText(
      "Перенаправление карточки",
    );
    await expect(help).toContainText("Служба для перенаправления");
    await expect(help).toContainText("причину");
    await expect(help).not.toContainText("Выберите статус");
    await readable(help);
    await page.screenshot({
      path: "scripts/ralph/artwox/logs/audit-next/redirect-help.png",
    });
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/arm/cards/${lesson.card.id}$`));
    await expect(
      action.getByRole("combobox", { name: "Служба для перенаправления" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Отменить", exact: true }).click();
    await page.getByRole("button", { name: /Служба 102.*Не принята/ }).click();
    await page
      .getByRole("button", { name: "Объяснение экрана", exact: true })
      .click();
    await action.hover();
    await expect(help.getByRole("heading")).toContainText("Изменение статуса");
    await expect(
      page.getByRole("button", { name: /\d+\. Перенаправление карточки/ }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
  });
  test("Прокрутка мобильной карточки обновляет части справки", async ({
    page,
    lesson,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    await page
      .getByRole("button", { name: "Объяснение экрана", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: /\d+\. Телефоны и номер происшествия/ }),
    ).toBeVisible();
    await page.locator('[data-help="card-services"]').scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("button", { name: /\d+\. Телефоны и номер происшествия/ }),
    ).toHaveCount(0);
    const help = page.locator('[data-help-ui] [role="region"]');
    // Переходы работают с клавиатуры и для частей у нижнего края экрана.
    const next = help.getByRole("button", { name: "Далее", exact: true });
    for (let step = 0; step < 10 && (await next.isEnabled()); step++) {
      await next.focus();
      await page.keyboard.press("Enter");
    }
    await expect(help.getByRole("heading")).toContainText("Службы и закрытие");
    await page.screenshot({
      path: "scripts/ralph/artwox/logs/recheck/mobile-help-scroll.png",
    });
    await page.keyboard.press("Escape");
    await expect(help).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/arm/cards/${lesson.card.id}$`));
  });
  test("Загрузка занятия не закрывает уже открытую справку преподавателя", async ({
    page,
    lesson,
  }) => {
    let allowSessions: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      allowSessions = resolve;
    });
    // Только задержка настоящего запроса: данные и ответы API не подменяются.
    await page.route("**/api/sessions", async (route) => {
      await ready;
      await route.continue();
    });
    try {
      await login(page, "teacher");
      await expect(
        page.getByRole("heading", { name: "Занятие не выбрано" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Объяснение экрана", exact: true })
        .click();
      const help = page.locator('[data-help-ui] [role="region"]');
      await expect(help).toBeVisible();
      allowSessions();
      await expect(
        page.getByRole("button", { name: lesson.session.title }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Занятие не выбрано" }),
      ).toHaveCount(0);
      await expect(help).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(help).toHaveCount(0);
    } finally {
      allowSessions();
    }
  });
  test("Все экраны, части карточки, клавиатура и читаемость", async ({
    page,
    browser,
    lesson,
  }) => {
    test.setTimeout(120_000);
    mkdirSync("scripts/ralph/artwox/logs", { recursive: true });
    writeFileSync("scripts/ralph/artwox/logs/readability.jsonl", "");
    await login(page, "trainee05");
    await explain(page, "Список");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    await expect(page).toHaveURL(new RegExp(lesson.card.id));
    await explain(page, "Карточка");
    await page
      .getByRole("button", { name: "Объяснение экрана", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: /\d+\. Службы и закрытие/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /\d+\. Поиск происшествий/ }),
    ).toHaveCount(0);
    await page.screenshot({ path: "scripts/ralph/artwox/logs/card-help.png" });
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(lesson.card.id));
    for (const label of ["адрес", "статус", "номер наряда", "комментарий"]) {
      if (label === "статус")
        await page
          .getByRole("button", { name: /Служба 102.*Получена/ })
          .click();
      await page
        .getByRole("button", { name: `Подсказка: ${label}`, exact: true })
        .click();
      const hint = page.getByRole("note");
      await expect(hint).toBeVisible();
      await readable(hint);
      await page.keyboard.press("Escape");
      await expect(hint).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(lesson.card.id));
    }
    await page.getByRole("button", { name: "Телефон", exact: true }).click();
    await explain(page, "Телефон в карточке");
    await page.getByRole("button", { name: "1", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(lesson.card.id));
    await expect(
      page.getByRole("button", { name: "1", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Закрыть карточку", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Мои результаты", exact: true })
      .click();
    await explain(page, "Результаты в АРМ");
    await page.goto("/app/results");
    await explain(page, "Результаты из шапки");
    await page.goto("/app/arm/reference");
    await explain(page, "Справка");
    const teacherContext = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
    });
    const teacher = await teacherContext.newPage();
    try {
      await visitTeacher(teacher, lesson.session.title, async (name) =>
        explain(teacher, name),
      );
      await teacher
        .getByRole("button", { name: "Объяснение экрана", exact: true })
        .click();
      await teacher
        .locator('[data-help="teacher-sessions"]')
        .hover({ position: { x: 80, y: 20 } });
      await expect(teacher.locator("[data-help-ui] h2")).toContainText(
        "Список занятий",
      );
      await expect(teacher.locator("[data-help-ui] p")).toContainText(
        "+ Новое занятие",
      );
      await teacher.screenshot({
        path: "scripts/ralph/artwox/logs/teacher-help.png",
      });
    } finally {
      await teacherContext.close();
    }
    const adminContext = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
    });
    const admin = await adminContext.newPage();
    try {
      await visitAdmin(admin, async (name) => explain(admin, name));
      await admin
        .getByRole("button", { name: "Объяснение экрана", exact: true })
        .click();
      const help = admin.locator('[data-help-ui] [role="region"]');
      const before = await help.getByRole("heading").innerText();
      await help.getByRole("button", { name: "Далее", exact: true }).click();
      await expect(help.getByRole("heading")).not.toHaveText(before);
      // Обход разделов заканчивается «Сообщениями об ошибках» (captain-screens.ts).
      await expect(help.getByRole("heading")).toContainText(
        "Сообщения об ошибках",
      );
      await admin.screenshot({
        path: "scripts/ralph/artwox/logs/admin-help.png",
      });
    } finally {
      await adminContext.close();
    }
  });
});

test.describe("Подсказки выключены", () => {
  test.use({ hintsLevel: 0 });
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");
  test("У обучаемого нет справки экрана и подсказок карточки", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    await expect(
      page.getByRole("button", { name: "Объяснение экрана" }),
    ).toHaveCount(0);
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    await expect(
      page.getByRole("button", { name: "Телефон", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Объяснение экрана" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Подсказка:/ })).toHaveCount(
      0,
    );
    await lesson.finish();
    await page.goto("/app/arm/results");
    await expect(
      page.getByRole("heading", { name: "Мои результаты", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Объяснение экрана" }),
    ).toHaveCount(0);
  });
});
