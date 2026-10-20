import { expect, test, type Page } from "@playwright/test";
import { passWelcome } from "./captain-fixture";

// GP-10, docs/dds_gameplay.md §9: от «Новое занятие» до идущего занятия — один
// экран без переходов по вкладкам; «Начать занятие» сразу под выдачей.
async function login(page: Page, name: string) {
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(name);
  await page
    .getByLabel("Пароль")
    .fill(process.env.DEMO_PASSWORD ?? "demo-local");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  await passWelcome(page);
}

test("Преподаватель: новое занятие → места → подбор → «Начать занятие» рядом с выдачей", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL и явное E2E_DATABASE=1",
  );
  test.skip(testInfo.project.name !== "chromium", "Обучаемый один на прогон");
  test.setTimeout(90_000);
  const title = `Путь преподавателя ${Date.now()}`;
  let sessionId = "";
  await login(page, "teacher");
  const headers = {
    "X-CSRF-Token":
      (await page.context().cookies()).find((cookie) => cookie.name === "csrf")
        ?.value ?? "",
  };
  try {
    await page
      .getByRole("button", { name: "+ Новое занятие", exact: true })
      .click();
    await page.getByLabel("Название", { exact: true }).fill(title);
    await page.getByRole("button", { name: "Добавить рабочее место" }).click();
    await page.getByLabel("Обучаемый", { exact: true }).fill("trainee02");
    await page.getByLabel("Служба ДДС", { exact: true }).selectOption("101");
    const creation = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/sessions") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Создать занятие", exact: true })
      .click();
    const created = await creation;
    expect(created.status(), await created.text()).toBe(201);
    sessionId = (await created.json()).id;

    const detail = page.locator('section[aria-labelledby="session-title"]');
    const tab = (name: string) => detail.getByRole("tab", { name });
    // После создания сразу открыта выдача — вкладки никто не нажимает.
    await expect(tab("Состав и раздача")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const start = detail.getByRole("button", { name: "Начать занятие" });
    await expect(start).toBeDisabled();

    const issue = detail.getByRole("button", {
      name: /^Выдать задания \(\d+\)$/,
    });
    await detail
      .getByRole("button", { name: "Подобрать по службе и уровню" })
      .click();
    await expect(issue).toBeEnabled();
    await issue.click();
    await expect(detail.getByText(/^Выдано заданий: \d+\./)).toBeVisible();
    // Выданное ушло из плана, но место не пишет «нет заданий».
    await expect(detail.getByText(/^выдано: \d+$/)).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("after-issue.png"),
      fullPage: true,
    });

    // «Начать занятие» — в одном ряду с «Выдать задания», правее неё (капитан, 19.10),
    // на виду без прокрутки к шапке.
    await expect(start).toBeEnabled();
    await expect(start).toBeInViewport();
    const issueBox = (await issue.boundingBox())!;
    const startBox = (await start.boundingBox())!;
    expect(Math.abs(startBox.y - issueBox.y)).toBeLessThan(4);
    expect(startBox.x).toBeGreaterThan(issueBox.x);

    await start.click();
    await expect(detail.getByText("Занятие запущено.")).toBeVisible();
    await expect(tab("Ход занятия")).toHaveAttribute("aria-selected", "true");
    await page.screenshot({
      path: testInfo.outputPath("running.png"),
      fullPage: true,
    });
  } finally {
    if (sessionId)
      await page.request.post(`/api/sessions/${sessionId}/finish`, { headers });
  }
});
