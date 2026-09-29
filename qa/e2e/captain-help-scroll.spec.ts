import { expect } from "@playwright/test";
import { test, login } from "./captain-fixture";

test.describe("Закрытие справки на прокрученной странице", () => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");

  for (const role of ["trainee05", "teacher", "admin"] as const) {
    for (const dismiss of ["Escape", "кнопка"] as const) {
      test(`${role}: ${dismiss} сохраняет место чтения и возвращает фокус`, async ({
        page,
        lesson,
      }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await login(page, role);
        if (role === "trainee05") {
          await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
          await expect(
            page.locator('[data-help="card-history"]'),
          ).toContainText("карточка открыта");
        } else if (role === "teacher") {
          await page
            .getByRole("button", { name: "+ Новое занятие", exact: true })
            .click();
          // Пустая форма почти помещается в окно. Состав из трёх рабочих мест
          // даёт настоящую длинную страницу без изменения разметки в тесте.
          for (let place = 0; place < 3; place++)
            await page
              .getByRole("button", {
                name: "Добавить рабочее место",
                exact: true,
              })
              .click();
          await expect(
            page.getByRole("combobox", { name: "Обучаемый", exact: true }),
          ).toHaveCount(3);
        } else {
          await page
            .getByRole("button", { name: "Нормативы и оценка", exact: true })
            .click();
        }
        await expect(
          page.getByText(/^(?:Загрузка|Загружаем)(?:\s.*)?…$/i),
        ).toHaveCount(0);
        const trigger = page.getByRole("button", {
          name: "Объяснение экрана",
          exact: true,
        });
        await trigger.click();
        const help = page.locator('[data-help-ui] [role="region"]');
        await expect(help).toBeVisible();
        // Пользователь читает нижнюю часть длинной страницы, пока справка открыта.
        await page.evaluate(() =>
          scrollTo(0, document.documentElement.scrollHeight),
        );
        await expect(trigger).not.toBeInViewport();
        const before = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
        expect(before.y).toBeGreaterThan(100);
        await page.screenshot({
          path: test.info().outputPath("before-close.png"),
        });
        if (dismiss === "Escape") await page.keyboard.press("Escape");
        else
          await help
            .getByRole("button", { name: "Закрыть объяснение", exact: true })
            .click();
        await expect(help).toHaveCount(0);
        await expect(trigger).toBeFocused();
        const after = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
        await test.info().attach("scroll-position", {
          body: JSON.stringify({ before, after }),
          contentType: "application/json",
        });
        await page.screenshot({
          path: test.info().outputPath("after-close.png"),
        });
        expect(after).toEqual(before);
        if (role === "trainee05")
          await expect(page).toHaveURL(
            new RegExp(`/arm/cards/${lesson.card.id}$`),
          );
      });
    }
  }
});
