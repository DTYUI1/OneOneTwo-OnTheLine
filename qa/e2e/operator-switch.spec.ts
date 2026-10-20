import { passWelcome } from "./captain-fixture";
import { expect, test, type Page } from "@playwright/test";

// GP-20: модуль «Оператор 112» включает администратор (contracts/operator/module-switch.md).
const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-local";

async function login(page: Page, account: string) {
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(account);
  await page.getByLabel("Пароль").fill(PASSWORD);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
}

async function setModule(page: Page, enabled: boolean) {
  await login(page, "admin");
  await passWelcome(page);
  await page.getByRole("button", { name: "Модули", exact: true }).click();
  const box = page.getByRole("checkbox", { name: "Оператор 112" });
  await expect(box).toBeEnabled();
  if ((await box.isChecked()) !== enabled) await box.click();
  await expect(box).toBeChecked({ checked: enabled });
  await expect(
    page.getByText(enabled ? "Модуль включён" : "Модуль выключен"),
  ).toBeVisible();
}

test("Администратор включает и выключает модуль «Оператор 112»", async ({
  page,
  browser,
}) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужен изолированный database-стенд",
  );
  try {
    await setModule(page, true);

    const trainee = await (await browser.newContext()).newPage();
    await login(trainee, "trainee01");
    await expect(
      trainee.getByRole("heading", { name: "Выберите обучение" }),
    ).toBeVisible();
    const on = await trainee.request.get("/api/operator/config");
    expect(on.status()).toBe(200);
    await trainee.context().close();

    await setModule(page, false);

    const other = await (await browser.newContext()).newPage();
    await login(other, "trainee01");
    await expect(
      other.getByRole("heading", { name: "Добро пожаловать" }),
    ).toBeVisible();
    await expect(
      other.getByRole("button", { name: "Оператор 112" }),
    ).toHaveCount(0);
    const off = await other.request.get("/api/operator/config");
    expect(off.status()).toBe(404);
    await other.goto("/app/operator");
    await expect(other).toHaveURL(/\/app\/login$/);
    await other.context().close();
  } finally {
    // Стенд остаётся с выключенным модулем, как по умолчанию.
    const reset = await page.request.get("/api/features");
    if ((await reset.json()).operator_module === true) {
      await page.goto("/app/admin");
      await page.getByRole("button", { name: "Модули", exact: true }).click();
      const box = page.getByRole("checkbox", { name: "Оператор 112" });
      if (await box.isChecked()) await box.click();
    }
  }
});
