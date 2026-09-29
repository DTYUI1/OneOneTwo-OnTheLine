import { expect, test, type Page } from "@playwright/test";
import { passWelcome } from "./captain-fixture";

// L-04: только trainee подтверждает образцы часов v2 (contracts/openapi.draft.yaml,
// registerClockSample x-roles: [trainee]). У teacher/admin такого права нет — клиент
// не должен слать POST /api/clock/samples и получать честный, но лишний 403.

async function login(page: Page, name: string) {
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(name);
  await page
    .getByLabel("Пароль")
    .fill(process.env.DEMO_PASSWORD ?? "demo-local");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  const begin = page.getByRole("button", { name: "Диспетчер служб" });
  if (await begin.isVisible().catch(() => false)) await begin.click();
  if (!name.startsWith("trainee")) await passWelcome(page);
}

test("преподаватель на пульте занятия не шлёт POST /api/clock/samples", async ({
  page,
}) => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен database-стенд");
  const samples: number[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/clock/samples"))
      samples.push(response.status());
  });
  await login(page, "teacher");
  await page.waitForTimeout(8_000);
  expect(samples).toEqual([]);
});

test("обучаемый по-прежнему подтверждает образцы часов", async ({ page }) => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен database-стенд");
  let accepted = false;
  page.on("response", async (response) => {
    if (!response.url().includes("/api/clock/samples")) return;
    expect(response.status()).toBe(200);
    if ((await response.json()).accepted) accepted = true;
  });
  await login(page, "trainee01");
  await expect.poll(() => accepted, { timeout: 15_000 }).toBe(true);
});
