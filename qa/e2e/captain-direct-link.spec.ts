import { expect } from "@playwright/test";
import { passWelcome, test } from "./captain-fixture";

test.describe("Прямая ссылка до входа", () => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");

  for (const reloadLogin of [false, true]) {
    test(`Карточка открывается после входа${reloadLogin ? " и обновления формы" : ""}`, async ({
      page,
      lesson,
    }) => {
      const path = `/app/arm/cards/${lesson.card.id}`;
      await page.goto(path);
      await expect(page).toHaveURL(/\/app\/login$/);
      await expect(
        page.getByRole("button", { name: "Объяснение экрана" }),
      ).toHaveCount(0);
      if (reloadLogin) {
        // Настоящее обновление сохраняет запись истории и в Firefox.
        await Promise.all([
          page.waitForEvent("load"),
          page.evaluate(() => location.reload()),
        ]);
      }
      await page.getByLabel("Логин", { exact: true }).fill("trainee05");
      await page.getByLabel("Пароль").fill("wrong");
      await page.getByRole("button", { name: "Войти", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText(
        "Неверный логин или пароль",
      );
      await page
        .getByLabel("Пароль")
        .fill(process.env.DEMO_PASSWORD ?? "demo-local");
      await page.getByRole("button", { name: "Войти", exact: true }).click();
      await page.getByRole("button", { name: "Диспетчер служб" }).click();
      await page.screenshot({
        path: test.info().outputPath("after-login.png"),
      });
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page).toHaveTitle(
        `Происшествие ${lesson.card.source.number}`,
      );
      await expect(page.locator('[data-help="card-history"]')).toContainText(
        "карточка открыта",
      );
      await page.screenshot({ path: test.info().outputPath("card-ready.png") });
      await page.getByRole("button", { name: "Объяснение экрана" }).click();
      await expect(page.locator("[data-help-ui] h2")).toHaveText(/^\d+\. /);
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      if (reloadLogin) await page.keyboard.press("Escape");
      else await page.getByRole("button", { name: "Закрыть карточку" }).click();
      await expect(page).toHaveURL(/\/app\/arm$/);
      await expect(
        page.locator(`[data-card-id="${lesson.card.id}"]`),
      ).toBeVisible();
    });
  }

  test("Вход преподавателя по ссылке обучаемого открывает свой кабинет", async ({
    page,
    lesson,
  }) => {
    await page.goto(`/app/arm/cards/${lesson.card.id}`);
    await expect(page).toHaveURL(/\/app\/login$/);
    await page.getByLabel("Логин", { exact: true }).fill("teacher");
    await page
      .getByLabel("Пароль")
      .fill(process.env.DEMO_PASSWORD ?? "demo-local");
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/teacher$/);
    await passWelcome(page);
    await expect(
      page.getByRole("heading", { name: "Кабинет преподавателя" }),
    ).toBeVisible();
  });

  test("Прямая ссылка не открывает карточку другого обучаемого", async ({
    page,
    lesson,
  }) => {
    const path = `/app/arm/cards/${lesson.card.id}`;
    await page.goto(path);
    await expect(page).toHaveURL(/\/app\/login$/);
    await page.getByLabel("Логин", { exact: true }).fill("trainee04");
    await page
      .getByLabel("Пароль")
      .fill(process.env.DEMO_PASSWORD ?? "demo-local");
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await page.getByRole("button", { name: "Диспетчер служб" }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole("alert")).toHaveText(
      "Карточка не найдена или недоступна.",
    );
    await expect(
      page.getByRole("region", {
        name: `Происшествие ${lesson.card.source.number}`,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Объяснение экрана" }),
    ).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("unavailable.png") });
    await page.getByRole("button", { name: "К списку происшествий" }).click();
    await expect(page).toHaveURL(/\/app\/arm$/);
    await expect(
      page.locator(`[data-card-id="${lesson.card.id}"]`),
    ).toHaveCount(0);
  });
});

test.describe("Одна дорога к результатам", () => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");

  test("Старый адрес /results ведёт на разбор в АРМ", async ({ page }) => {
    await page.goto("/app/login");
    await page.getByLabel("Логин", { exact: true }).fill("trainee05");
    await page
      .getByLabel("Пароль")
      .fill(process.env.DEMO_PASSWORD ?? "demo-local");
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await page.getByRole("button", { name: "Диспетчер служб" }).click();
    await page.goto("/app/results");
    await expect(page).toHaveURL(/\/app\/arm\/results$/);
    await page.goto("/app/arm");
    await page
      .getByRole("banner")
      .getByRole("link", { name: "Мои результаты" })
      .click();
    await expect(page).toHaveURL(/\/app\/arm\/results$/);
  });
});
