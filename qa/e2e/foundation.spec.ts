import { expect, test } from "@playwright/test";

for (const [login, path, heading] of [
  ["trainee01", "/app/arm", "Список происшествий"],
  ["teacher", "/app/teacher", "Кабинет преподавателя"],
  ["admin", "/app/admin", "Администрирование"],
]) {
  test(`Вход, перезагрузка и выход: ${login}`, async ({ page }) => {
    await page.goto("/app/login");
    await page.getByLabel("Логин", { exact: true }).fill(login);
    await page
      .getByLabel("Пароль")
      .fill(process.env.DEMO_PASSWORD ?? "demo-local");
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(path + "$"));
    if (login === "trainee01") {
      await expect(
        page.getByRole("heading", { name: "Выберите обучение" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Диспетчер служб" }).click();
    } else {
      // С 28.09 приветствие есть у каждой роли; у преподавателя и администратора — своё.
      await expect(
        page.getByRole("heading", { name: /Добро пожаловать/ }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Диспетчер служб" }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: "Начать работу" }).click();
    }
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    if (login === "trainee01") {
      // Database seed не выдаёт учебные карточки; проверка входа допускает пустую историю.
      if (process.env.E2E_DATABASE === "1") {
        expect((await page.request.get("/api/cards")).status()).toBe(200);
      } else {
        await expect(page.getByText("10000001")).toBeVisible();
      }
      await page.goto("/app/admin");
      await expect(page.getByRole("alert")).toHaveText(
        "Недостаточно прав для этого раздела.",
      );
      await page.goto("/app/arm");
    }
    await page.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/login$/);
    await page.goto(path);
    await expect(page).toHaveURL(/\/app\/login$/);
  });
}

test("Неверный пароль не открывает АРМ", async ({ page }) => {
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill("trainee01");
  await page.getByLabel("Пароль").fill("wrong");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Неверный логин или пароль",
  );
});

test("Корень стенда ведёт на вход в систему", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/app\/login$/);
  await expect(
    page.getByRole("heading", { name: /Вход в систему/ }),
  ).toBeVisible();
});
