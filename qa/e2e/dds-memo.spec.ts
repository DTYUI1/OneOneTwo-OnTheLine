import { expect } from "@playwright/test";
import { test, login } from "./captain-fixture";
import { lesson, waitCard } from "./memo-lesson";

// Рабочее поле ДДС по памятке (GP-16, docs/dds_memo_check.md): предпросмотр строки
// реестра, шапка реестра без учебных кнопок, «кто сохранил» в истории, служба 103 без
// отказных статусов.
test.skip(
  process.env.E2E_DATABASE !== "1",
  "Нужен стенд с базой: E2E_DATABASE=1",
);

test("реестр: предпросмотр «⌄» и история статусов по памятке (с. 13, 25)", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const current = await lesson(request, "102");
  try {
    await login(page, "trainee05");
    const card = await waitCard(page, current.id);
    const row = page.locator(`[data-card-id="${card.id}"]`);

    // Учебные кнопки — в шапке реестра одной группой: колонку тренажёра убрали по проверке
    // 17.10 (ArmPage, `arm-list-head`); в строках и предпросмотре реестра их нет.
    const list = page.locator('[data-help="arm-list"]');
    await expect(
      page
        .locator('[data-help="arm-list-head"]')
        .getByRole("button", { name: "Мой путь", exact: true }),
    ).toBeVisible();
    await expect(list.getByRole("button", { name: "Мой путь" })).toHaveCount(1);

    // «⌄» раскрывает предпросмотр и карточку не открывает.
    const preview = row.getByRole("button", { name: "Предпросмотр карточки" });
    await preview.click();
    await expect(preview).toHaveAttribute("aria-expanded", "true");
    await expect(page).toHaveURL(/\/app\/arm$/);
    const services = list.locator("tr", { hasText: /^Службы:/ });
    await expect(services).toContainText(/Служба 102 — \d\d:\d\d:\d\d /);
    await expect(list.locator("tr", { hasText: /^Заявитель:/ })).toBeVisible();
    await preview.click();
    await expect(services).toHaveCount(0);

    await row.click();
    const cardView = page.getByRole("region", {
      name: `Происшествие ${card.source.number}`,
      exact: true,
    });
    await cardView
      .getByRole("button", { name: "Изменить статус", exact: true })
      .click();
    await cardView
      .getByLabel("Статус", { exact: true })
      .selectOption("accepted");
    await cardView
      .getByLabel("Комментарий", { exact: true })
      .fill("Принята, направлен наряд");
    await cardView
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();
    await expect(cardView.getByText(/^\d\d:\d\d Принята$/)).toBeVisible();
    const cancel = cardView.getByRole("button", {
      name: "Отменить",
      exact: true,
    });
    if (await cancel.isVisible()) await cancel.click();
    const toggle = cardView.getByRole("button", {
      name: "История статусов",
      exact: true,
    });
    if ((await toggle.getAttribute("aria-expanded")) !== "true")
      await toggle.click();
    const history = cardView.locator('[data-help="card-history"]');
    // «Добавлена» сохраняет оператор 112 — «оп. 0»; у своих записей — Ф.И.О. при наведении.
    await expect(
      history.locator("li", { hasText: "Добавлена" }).getByText("оп. 0"),
    ).toBeVisible();
    await expect(
      history.locator("li", { hasText: "Получена службой" }).getByTitle(/\S/),
    ).toHaveText("оп. 23");
  } finally {
    await current.finish();
  }
});

test("служба 103: в «Карандаше» нет «Не принята» (памятка, с. 23)", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const current = await lesson(request, "103");
  try {
    await login(page, "trainee05");
    const card = await waitCard(page, current.id);
    await page.locator(`[data-card-id="${card.id}"]`).click();
    const cardView = page.getByRole("region", {
      name: `Происшествие ${card.source.number}`,
      exact: true,
    });
    await cardView
      .getByRole("button", { name: "Изменить статус", exact: true })
      .click();
    await expect(
      cardView.getByLabel("Статус", { exact: true }).locator("option"),
    ).toHaveText(["Статус", "Принята"]);
  } finally {
    await current.finish();
  }
});
