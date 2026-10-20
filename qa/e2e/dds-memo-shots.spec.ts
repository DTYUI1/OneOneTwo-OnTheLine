import { mkdirSync, writeFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { test, login } from "./captain-fixture";
import { lesson, waitCard } from "./memo-lesson";

// Сверка рабочего поля ДДС с памяткой (GP-16, docs/dds_memo_check.md) — снимки «до и
// после» только по запросу: E2E_DATABASE=1 DDS_MEMO_SHOTS=1. Папка — DDS_MEMO_SHOTS_OUT
// (по умолчанию docs/dds_memo_check), начало имени — DDS_MEMO_SHOTS_PREFIX («after»).
// Рядом со снимками пишется список статусов «Карандаша» для служб 102 и 103.
test.skip(
  process.env.E2E_DATABASE !== "1" || process.env.DDS_MEMO_SHOTS !== "1",
  "Снимки — по запросу: E2E_DATABASE=1 DDS_MEMO_SHOTS=1",
);

const OUT = process.env.DDS_MEMO_SHOTS_OUT ?? "docs/dds_memo_check";
const PREFIX = process.env.DDS_MEMO_SHOTS_PREFIX ?? "after";

async function options(page: Page): Promise<string[]> {
  const texts = await page
    .getByLabel("Статус", { exact: true })
    .locator("option")
    .allInnerTexts();
  return texts.map((text) => text.trim()).filter((text) => text !== "Статус");
}

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
]) {
  const size = `${viewport.width}x${viewport.height}`;
  test.describe(`Рабочее поле ДДС по памятке ${size}`, () => {
    test.use({ viewport });

    test("реестр, предпросмотр, карточка, «Карандаш», история", async ({
      page,
      request,
    }) => {
      test.setTimeout(240_000);
      page.setDefaultTimeout(20_000);
      mkdirSync(OUT, { recursive: true });
      const shot = async (name: string) => {
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${OUT}/${PREFIX}-${size}-${name}.png` });
      };
      const current = await lesson(request, "102");
      try {
        await login(page, "trainee05");
        const card = await waitCard(page, current.id);
        const row = page.locator(`[data-card-id="${card.id}"]`);
        await shot("01-list");
        // Предпросмотр строки (памятка, с. 13–14) — «⌄» в начале строки.
        const preview = row.getByRole("button", {
          name: "Предпросмотр карточки",
        });
        if (await preview.count()) {
          await preview.click();
          await shot("02-list-preview");
          await preview.click();
        }
        await row.click();
        const cardView = page.getByRole("region", {
          name: `Происшествие ${card.source.number}`,
          exact: true,
        });
        await expect(cardView).toBeVisible();
        await shot("03-card");
        const pencil = cardView.getByRole("button", {
          name: "Изменить статус",
          exact: true,
        });
        await pencil.click();
        await expect(
          cardView.getByLabel("Статус", { exact: true }),
        ).toBeVisible();
        writeFileSync(
          `${OUT}/${PREFIX}-${size}-options-102.txt`,
          `${(await options(page)).join("\n")}\n`,
        );
        await shot("04-pencil");
        // «Принята» позже 30 с после поступления — время в истории выделено (с. 25).
        await page.waitForTimeout(32_000);
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
        const history = cardView.getByRole("button", {
          name: "История статусов",
          exact: true,
        });
        if ((await history.getAttribute("aria-expanded")) !== "true")
          await history.click();
        await expect(
          cardView
            .locator('[data-help="card-history"]')
            .getByText(/ Принята$/)
            .first(),
        ).toBeVisible();
        await shot("05-history");
        await pencil.click();
        writeFileSync(
          `${OUT}/${PREFIX}-${size}-options-102-accepted.txt`,
          `${(await options(page)).join("\n")}\n`,
        );
      } finally {
        await current.finish();
      }
    });

    test("служба 103: «Карандаш» без отказных статусов", async ({
      page,
      request,
    }) => {
      test.setTimeout(120_000);
      page.setDefaultTimeout(20_000);
      mkdirSync(OUT, { recursive: true });
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
          cardView.getByLabel("Статус", { exact: true }),
        ).toBeVisible();
        writeFileSync(
          `${OUT}/${PREFIX}-${size}-options-103.txt`,
          `${(await options(page)).join("\n")}\n`,
        );
        await page.waitForTimeout(400);
        await page.screenshot({
          path: `${OUT}/${PREFIX}-${size}-06-pencil-103.png`,
        });
      } finally {
        await current.finish();
      }
    });
  });
}
