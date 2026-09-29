import { expect, test, type Page } from "@playwright/test";
import { passWelcome } from "./captain-fixture";

async function signIn(page: Page, name: string) {
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(name);
  await page
    .getByLabel("Пароль")
    .fill(process.env.DEMO_PASSWORD ?? "demo-local");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

// Приветствие есть у каждой роли, а после него стрелка показывает на «?» (28.09).
for (const name of ["teacher", "admin"] as const) {
  test(`Первое знакомство ${name === "teacher" ? "преподавателя" : "администратора"}: приветствие и стрелка к «?»`, async ({
    page,
  }) => {
    await signIn(page, name);
    const greeting = page.getByRole("heading", { name: "Добро пожаловать" });
    await expect(greeting).toBeFocused();
    await page.getByRole("button", { name: "Начать работу" }).click();
    await expect(greeting).toHaveCount(0);

    const help = page.getByRole("button", { name: "Объяснение экрана" });
    const tip = page.getByRole("note", { name: "Подсказка" });
    await expect(tip).toContainText("Объяснение экрана");
    // Подсказка под кнопкой «?», у её правого края, и не выходит за экран.
    const button = (await help.boundingBox())!;
    const box = (await tip.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(button.y + button.height);
    expect(box.x + box.width).toBeGreaterThanOrEqual(button.x);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);

    // Подсказка не мешает работе и исчезает после первого щелчка — насовсем.
    await help.click();
    await expect(tip).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(page.getByRole("button", { name: "Выйти" })).toBeVisible();
    await expect(greeting).toHaveCount(0);
    await expect(tip).toHaveCount(0);
  });
}

test("Сообщение об ошибке от преподавателя видно администратору", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужна база: сообщение сохраняется на сервере",
  );
  const text = `Проверка сообщения ${Date.now()}`;
  await signIn(page, "teacher");
  await passWelcome(page);
  await page.getByRole("button", { name: "Сообщить об ошибке" }).click();
  const dialog = page.getByRole("dialog", { name: "Сообщить об ошибке" });
  await expect(dialog).toBeVisible();
  // Пустое описание не уходит: причина видна сразу.
  await dialog.getByRole("button", { name: "Отправить" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Опишите, что случилось.");
  await dialog.getByRole("radio", { name: "Непонятно, что делать" }).check();
  await dialog.getByLabel("Описание").fill(text);
  await dialog.getByRole("button", { name: "Отправить" }).click();
  await expect(
    dialog.getByText("Спасибо! Сообщение получит администратор тренажёра."),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Закрыть" }).first().click();
  await expect(dialog).toBeHidden();

  const adminContext = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    ignoreHTTPSErrors: true,
  });
  try {
    const admin = await adminContext.newPage();
    await signIn(admin, "admin");
    await passWelcome(admin);
    await admin
      .getByRole("button", { name: "Сообщения об ошибках", exact: true })
      .click();
    const row = admin.getByRole("row").filter({ hasText: text });
    await expect(row).toBeVisible();
    await expect(row).toContainText("преподаватель");
    await expect(row).toContainText("Непонятно, что делать");
    await expect(row).toContainText("Пульт преподавателя");
  } finally {
    await adminContext.close();
  }
});
