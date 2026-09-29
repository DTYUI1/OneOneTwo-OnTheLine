import { expect } from "@playwright/test";
import { test, login } from "./captain-fixture";

test("Мобильная форма занятия: таблица прокручивается, шапка остаётся в окне", async ({
  page,
}) => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "teacher");
  await page
    .getByRole("button", { name: "+ Новое занятие", exact: true })
    .click();
  for (let place = 0; place < 3; place++)
    await page
      .getByRole("button", { name: "Добавить рабочее место", exact: true })
      .click();
  await expect(
    page.getByRole("combobox", { name: "Обучаемый", exact: true }),
  ).toHaveCount(3);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: test.info().outputPath("form-before-scroll.png"),
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  for (const name of ["Выйти", "Объяснение экрана"])
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toBeInViewport({ ratio: 1 });

  const table = page.getByRole("region", {
    name: "Состав по рабочим местам",
    exact: true,
  });
  await table.focus();
  await expect(table).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => table.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  // Последние столбцы доступны без горизонтального сдвига всей страницы.
  const level = table
    .getByRole("spinbutton", { name: "Уровень сложности", exact: true })
    .last();
  await level.focus();
  await expect(level).toBeInViewport({ ratio: 1 });
  await level.fill("3");
  await expect(level).toHaveValue("3");
  await page.keyboard.press("Tab");
  const remove = table
    .getByRole("button", { name: "Убрать", exact: true })
    .last();
  await expect(remove).toBeFocused();
  await expect(remove).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => scrollX)).toBe(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: test.info().outputPath("form-last-column.png"),
  });
  await page.keyboard.press("Enter");
  await expect(
    table.getByRole("combobox", { name: "Обучаемый", exact: true }),
  ).toHaveCount(2);
});
