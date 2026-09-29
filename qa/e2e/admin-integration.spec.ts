import { expect, test } from "@playwright/test";
import { passWelcome } from "./captain-fixture";

test("Админка: разделы и сохранение нормативов с полной проверкой весов", async ({
  page,
}) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужен изолированный database-стенд",
  );
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill("admin");
  await page
    .getByLabel("Пароль")
    .fill(process.env.DEMO_PASSWORD ?? "demo-local");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await passWelcome(page);
  await expect(
    page.getByRole("heading", { name: "Администрирование", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("всё работает", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Пользователи", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "trainee01", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Службы ДДС", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "102", exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Нормативы и оценка", exact: true })
    .click();
  const headers = {
    "X-CSRF-Token": (await page.context().cookies()).find(
      (c) => c.name === "csrf",
    )!.value,
  };
  const original = await (await page.request.get("/api/settings")).json();
  const reaction = page.getByLabel("Реакция, с", { exact: true });
  try {
    await expect(reaction).toHaveValue(String(original.reaction_normative_s));
    const weights = page.getByRole("spinbutton", { name: /^Вес:/ });
    // Семь критериев карточки и два комментария (#57): грамотность, ключевые сведения.
    expect(await weights.count()).toBe(9);
    await reaction.fill("0");
    await expect(
      page.getByRole("button", { name: "Сохранить", exact: true }),
    ).toBeDisabled();
    await reaction.fill(String(original.reaction_normative_s + 1));
    const saving = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/settings") && r.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    expect((await saving).status()).toBe(200);
    // Статус сохранения — в разделе: на странице бывает и системное предупреждение
    // (например, «Резервных копий нет…» на стенде без контейнера копий).
    await expect(
      page
        .getByRole("region", { name: "Нормативы и оценка" })
        .getByRole("status"),
    ).toContainText("Сохранено.");
    await page.reload();
    await page
      .getByRole("button", { name: "Нормативы и оценка", exact: true })
      .click();
    await expect(reaction).toHaveValue(
      String(original.reaction_normative_s + 1),
    );
  } finally {
    // Только настройки собственного QA-проекта; историю занятий не меняем.
    expect(
      (
        await page.request.put("/api/settings", { headers, data: original })
      ).status(),
    ).toBe(200);
  }
});
