import { expect, test, type Page } from "@playwright/test";

// Блок «Учётные записи для проверки» на экране входа (рекомендации организаторов 16.10, п. 2).
// Ответ API подменён: проверяется экран, а сам API и настройка — в apps/api/tests/test_demo_accounts.py.
const logins = [
  ["admin", "admin", "Администратор"],
  ["teacher", "teacher", "Преподаватель"],
  ["trainee01", "trainee", "Обучаемый 01"],
  ["trainee02", "trainee", "Обучаемый 02"],
];

async function stub(page: Page, enabled: boolean) {
  await page.route("**/api/auth/demo-accounts", (route) =>
    route.fulfill({
      json: {
        enabled,
        password: enabled ? "stand-secret" : null,
        accounts: enabled
          ? logins.map(([login, role, full_name]) => ({
              login,
              role,
              full_name,
            }))
          : [],
      },
    }),
  );
}

test("на экране входа видны логины ролей и пароль стенда, клик подставляет", async ({
  page,
}) => {
  await stub(page, true);
  await page.goto("/app/login");
  const block = page.getByRole("region", {
    name: "Учётные записи для проверки",
  });
  for (const [login] of logins) {
    await expect(block.getByRole("button", { name: login })).toBeVisible();
  }
  await expect(block).toContainText("stand-secret");
  await block.getByRole("button", { name: "trainee02" }).click();
  await expect(page.getByLabel("Логин", { exact: true })).toHaveValue(
    "trainee02",
  );
  await expect(page.getByLabel("Пароль")).toHaveValue("stand-secret");
});

test("выключенная настройка стенда убирает блок", async ({ page }) => {
  await stub(page, false);
  await page.goto("/app/login");
  await expect(page.getByLabel("Логин", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Учётные записи для проверки" }),
  ).toHaveCount(0);
});
