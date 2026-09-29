import { expect } from "@playwright/test";
import { test, login } from "./captain-fixture";

test.describe("Клавиатурные переходы по справке", () => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");

  for (const role of ["trainee05", "teacher", "admin"] as const) {
    test(`${role}: края объяснения сохраняют фокус и позволяют вернуться`, async ({
      page,
      lesson,
    }) => {
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
      const trigger = page.getByRole("button", {
        name: "Объяснение экрана",
        exact: true,
      });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const help = page.locator('[data-help-ui] [role="region"]');
      const heading = help.getByRole("heading");
      const next = help.getByRole("button", { name: "Далее", exact: true });
      const previous = help.getByRole("button", {
        name: "Назад",
        exact: true,
      });
      await expect(heading).toHaveText(/^1\. /);
      await expect(next).toBeEnabled();
      const count = await page.locator("[data-help-ui] > button").count();
      expect(count).toBeGreaterThan(1);
      await next.focus();
      for (let part = 2; part <= count; part++) {
        await page.keyboard.press("Enter");
        await expect(heading).toHaveText(new RegExp(`^${part}\\. `));
      }
      await page.screenshot({ path: test.info().outputPath("last-part.png") });
      await expect(next).toBeDisabled();
      // Фокус не должен исчезать при достижении края: иначе Shift+Tab
      // возвращает человека к произвольному элементу основного экрана.
      await expect(next).toBeFocused();
      const lastTitle = await heading.innerText();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Space");
      await expect(heading).toHaveText(lastTitle);
      await page.keyboard.press("Shift+Tab");
      await expect(previous).toBeFocused();
      for (let part = count - 1; part >= 1; part--) {
        await page.keyboard.press("Enter");
        await expect(heading).toHaveText(new RegExp(`^${part}\\. `));
      }
      await expect(previous).toBeDisabled();
      await expect(previous).toBeFocused();
      const firstTitle = await heading.innerText();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Space");
      await expect(heading).toHaveText(firstTitle);
      await page.keyboard.press("Tab");
      await expect(next).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(heading).toHaveText(/^2\. /);
      await page.keyboard.press("Escape");
      await expect(help).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });
  }
});
