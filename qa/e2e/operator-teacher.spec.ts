import { expect, test, type BrowserContext } from "@playwright/test";
import { login } from "./captain-fixture";
import { openCall } from "./operator-call";
import { OPERATOR_MODULE, OPERATOR_OFF_REASON } from "./operator-module";

test.skip(!OPERATOR_MODULE, OPERATOR_OFF_REASON);

test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");

test("преподаватель фильтрует и открывает попытку обучаемого; чужие попытки закрыты", async ({
  page,
  browser,
  baseURL,
}) => {
  await openCall(page, "elevator_stuck", { user: "trainee01" });
  await page.getByLabel("Описательный адрес:").fill("Возле учебной школы");
  const saving = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/operator/save") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "сохранить", exact: true }).click();
  const attempt = await (await saving).json();
  const contexts: BrowserContext[] = [];
  try {
    const second = await browser.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
    });
    contexts.push(second);
    const signedIn = await second.request.post("/api/auth/login", {
      data: {
        login: "trainee02",
        password: process.env.DEMO_PASSWORD ?? "demo-local",
      },
    });
    expect(signedIn.ok()).toBe(true);
    const csrf = (await second.cookies()).find(
      (cookie) => cookie.name === "csrf",
    )!.value;
    const secondSave = await second.request.post("/api/operator/save", {
      headers: { "X-CSRF-Token": csrf },
      data: {
        scenario_id: "elevator_stuck",
        elapsed_s: 12,
        card: {},
      },
    });
    expect(secondSave.ok()).toBe(true);
    const other = await secondSave.json();
    expect(
      (
        await second.request.get(`/api/operator/attempts/${attempt.id}`)
      ).status(),
    ).toBe(404);
    expect(
      (await page.request.get(`/api/operator/attempts/${other.id}`)).status(),
    ).toBe(404);
    const own = await (await page.request.get("/api/operator/attempts")).json();
    expect(
      own.every(
        (item: { actor_id: string }) => item.actor_id === attempt.actor_id,
      ),
    ).toBe(true);
    await page.goto("/app/operator/results");
    await expect(page.getByRole("combobox", { name: "Обучаемый" })).toHaveCount(
      0,
    );

    const teacher = await browser.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
    });
    contexts.push(teacher);
    const teacherPage = await teacher.newPage();
    await login(teacherPage, "teacher");
    await teacherPage
      .getByRole("button", { name: "Оператор 112: попытки" })
      .click();
    const filter = teacherPage.getByRole("combobox", { name: "Обучаемый" });
    await expect(
      filter.getByRole("option", { name: attempt.actor_name, exact: true }),
    ).toBeAttached();
    await filter.selectOption(attempt.actor_id);
    const all = await (
      await teacher.request.get("/api/operator/attempts")
    ).json();
    expect(all.some((item: { id: string }) => item.id === other.id)).toBe(true);
    const selected = teacherPage
      .getByRole("complementary", { name: "Сводка и попытки" })
      .locator('button[aria-current="true"]');
    await expect(selected).toContainText(attempt.actor_name);
    await expect(
      teacherPage.getByRole("region", { name: "Баллы попытки" }),
    ).toContainText(attempt.actor_name);
    await expect(
      teacherPage.getByRole("group", { name: "Сохранённый адрес" }),
    ).toContainText("Возле учебной школы");
    await expect(
      teacherPage.getByRole("list", { name: "Лента разговора" }),
    ).toContainText("Звонок начался");
  } finally {
    for (const context of contexts) await context.close();
  }
});
