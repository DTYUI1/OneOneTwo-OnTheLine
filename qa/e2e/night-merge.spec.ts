import { expect } from "@playwright/test";
import { test, login } from "./captain-fixture";

test.describe("Совместимость интерфейса и ночных изменений", () => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");

  test("Справка по F1 записывает событие и защищает карточку от щелчков", async ({
    page,
    lesson,
  }) => {
    await login(page, "trainee05");
    await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
    await expect(page.locator('[data-help="card-history"]')).toContainText(
      "карточка открыта",
    );
    await page.keyboard.press("F1");
    await expect(page.locator('[data-help-ui] [role="region"]')).toBeVisible();
    const close = page.getByRole("button", {
      name: "Закрыть карточку",
      exact: true,
    });
    const bounds = await close.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.click(
      bounds!.x + bounds!.width / 2,
      bounds!.y + bounds!.height / 2,
    );
    await expect(page).toHaveURL(new RegExp(lesson.card.id));
    await expect(page.locator('[data-help-ui] [role="region"]')).toBeVisible();
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `/api/cards/${lesson.card.id}/events`,
        );
        expect(response.ok()).toBeTruthy();
        const events: { type: string; payload: { hint_id?: string } }[] =
          await response.json();
        return events.filter(
          (event) =>
            event.type === "hint_open" && event.payload.hint_id === "help",
        ).length;
      })
      .toBe(1);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-help-ui]")).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(lesson.card.id));
    await close.click();
    await expect(page).toHaveURL(/\/app\/arm$/);
  });

  test("Вкладки занятия сохраняют историю и переживают перезагрузку", async ({
    page,
    lesson,
  }) => {
    await login(page, "teacher");
    await page
      .getByRole("navigation", { name: "Занятия", exact: true })
      .getByRole("button")
      .filter({ hasText: lesson.session.title })
      .click();
    await expect(
      page.getByRole("tab", { name: "Ход занятия", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Отчёт", exact: true }).click();
    await page.goBack();
    await expect(
      page.getByRole("tab", { name: "Ход занятия", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.goForward();
    await expect(
      page.getByRole("tab", { name: "Отчёт", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.reload();
    await expect(
      page.getByRole("tab", { name: "Отчёт", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  });
});
