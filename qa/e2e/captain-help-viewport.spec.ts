import { expect } from "@playwright/test";
import { test, login } from "./captain-fixture";

test.describe("Справка в невысоком окне", () => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");
  test.use({ viewport: { width: 844, height: 390 } });

  test("После перехода к длинному объяснению кнопки остаются видимыми", async ({
    page,
  }) => {
    await login(page, "admin");
    await page
      .getByRole("button", { name: "Нормативы и оценка", exact: true })
      .click();
    await page.getByLabel("Реакция, с", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Объяснение экрана" }).click();
    await page.evaluate(() => window.scrollTo(0, 200));
    const help = page.locator('[data-help-ui] [role="region"]');
    const next = help.getByRole("button", { name: "Далее", exact: true });
    await expect(next).toBeEnabled();
    await next.click();
    await expect(help.getByRole("heading")).toHaveText(/Нормативы и оценка/);
    await page.screenshot({ path: test.info().outputPath("next-part.png") });
    await expect(help.getByRole("heading")).toBeInViewport({ ratio: 1 });
    await expect(
      help.getByRole("button", { name: "Закрыть объяснение" }),
    ).toBeInViewport({ ratio: 1 });
    await expect(next).toBeInViewport({ ratio: 1 });
  });

  for (const role of ["trainee05", "teacher", "admin"] as const) {
    test(`${role}: текст читается с клавиатуры, переход начинает следующую часть сверху`, async ({
      page,
      lesson,
    }) => {
      await page.setViewportSize({ width: 1280, height: 390 });
      await login(page, role);
      if (role === "trainee05") {
        await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
        await expect(page.locator('[data-help="card-history"]')).toContainText(
          "карточка открыта",
        );
      } else if (role === "teacher") {
        await page.getByRole("button", { name: lesson.session.title }).click();
      }
      await expect(
        page.getByText(/^(?:Загрузка|Загружаем)(?:\s.*)?…$/i),
      ).toHaveCount(0);
      const trigger = page.getByRole("button", { name: "Объяснение экрана" });
      await trigger.click();
      const help = page.locator('[data-help-ui] [role="region"]');
      const text = help.getByRole("group");
      const next = help.getByRole("button", { name: "Далее", exact: true });
      const previous = help.getByRole("button", { name: "Назад", exact: true });
      const close = help.getByRole("button", { name: "Закрыть объяснение" });
      await expect(help.getByRole("heading")).toHaveText(/^1\. /);
      const count = await page.locator("[data-help-ui] > button").count();
      expect(count).toBeGreaterThan(1);
      let scrolled = false;
      for (let part = 1; part <= count; part++) {
        await expect(help.getByRole("heading")).toHaveText(
          new RegExp(`^${part}\\. `),
        );
        await expect(text).toHaveAccessibleName(
          await help.getByRole("heading").innerText(),
        );
        await expect.poll(() => text.evaluate((el) => el.scrollTop)).toBe(0);
        if (await text.evaluate((el) => el.scrollHeight > el.clientHeight)) {
          scrolled = true;
          await text.focus();
          await page.keyboard.press("End");
          await expect
            .poll(() => text.evaluate((el) => el.scrollTop))
            .toBeGreaterThan(0);
          await expect(close).toBeInViewport({ ratio: 1 });
          await expect(previous).toBeInViewport({ ratio: 1 });
          await expect(next).toBeInViewport({ ratio: 1 });
          await page.screenshot({
            path: test.info().outputPath(`part-${part}-end.png`),
          });
          await expect
            .poll(() =>
              text.evaluate((el) =>
                Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop),
              ),
            )
            .toBeLessThanOrEqual(1);
        }
        if (part < count) {
          await next.focus();
          await page.keyboard.press("Enter");
          await expect(next).toBeFocused();
        }
      }
      expect(scrolled).toBe(true);
      await page.keyboard.press("Escape");
      await expect(help).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });
  }
});
