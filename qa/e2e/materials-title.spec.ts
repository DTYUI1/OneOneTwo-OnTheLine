import { test, expect } from "@playwright/test";

test("название материала следует за файлом до ручного изменения", async ({
  page,
}) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужен стенд с демонстрационными учётками",
  );
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill("teacher");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill(process.env.DEMO_PASSWORD ?? "demo-local");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/login/);
  const welcome = page.getByRole("button", {
    name: "Начать работу",
    exact: true,
  });
  if (await welcome.isVisible()) await welcome.click();
  await page.getByRole("button", { name: "Материалы", exact: true }).click();
  const title = page.getByLabel("Название", { exact: true });
  const choose = (name: string) =>
    page.getByLabel("Файл материала").setInputFiles({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from("Памятка диспетчеру"),
    });
  await choose("Первая памятка.txt");
  await expect(title).toHaveValue("Первая памятка");
  await choose("Другая памятка.txt");
  await expect(title).toHaveValue("Другая памятка");
  await title.fill("Моё название");
  await choose("Третья памятка.txt");
  await expect(title).toHaveValue("Моё название");
  await title.fill("");
  await choose("Четвёртая памятка.txt");
  await expect(title).toHaveValue("Четвёртая памятка");
  await choose("Проверка названия материала.txt");
  await expect(title).toHaveValue("Проверка названия материала");
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/materials") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Загрузить", exact: true }).click();
  const saved = await response;
  expect(saved.status()).toBe(201);
  const material = await saved.json();
  expect(material.title).toBe("Проверка названия материала");
  await expect(title).toHaveValue("");
  await choose("После загрузки.txt");
  await expect(title).toHaveValue("После загрузки");
  await choose("Снова другой.txt");
  await expect(title).toHaveValue("Снова другой");
  const row = page
    .getByRole("row")
    .filter({ has: page.locator(`a[href*="${material.id}"]`) });
  await row.getByRole("button", { name: "Новая версия", exact: true }).click();
  await choose("Исправленный файл.txt");
  await expect(title).toHaveValue(material.title);
});
