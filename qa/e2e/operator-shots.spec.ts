import { expect, test, type Page } from "@playwright/test";
import {
  ask,
  calm,
  confirmAddress,
  fillAddress,
  moveTalkAside,
  openCall,
  talk,
} from "./operator-call";

// Снимки этапа 3 для docs/operator_112_review/stage3/ — только по запросу (OPERATOR_SHOTS=1):
// шаги опроса, проводник, «?», разбор звонка на окнах ноутбука и 1920×1080, в том числе на
// высотах с панелью браузера (1366×650, 1536×730).
test.skip(
  process.env.E2E_DATABASE !== "1" || process.env.OPERATOR_SHOTS !== "1",
  "Снимки — по запросу: E2E_DATABASE=1 OPERATOR_SHOTS=1",
);

const OUT = process.env.OPERATOR_SHOTS_OUT ?? "docs/operator_112_review/stage3";
const SIZES = [
  { width: 1366, height: 650 },
  { width: 1366, height: 768 },
  { width: 1536, height: 730 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
];

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

for (const viewport of SIZES) {
  const size = `${viewport.width}x${viewport.height}`;
  test.describe(`окно ${size}`, () => {
    test.use({ viewport });

    test("звонок девушки по шагам: проводник, повтор адреса, разбор", async ({
      page,
    }) => {
      await openCall(page, "fire_apartment_smoke", {
        guide: true,
        moveAside: false,
      });
      await shot(page, `${size}_centered_talk`);
      await moveTalkAside(page);
      await expect(
        page.getByRole("status", { name: "Проводник" }),
      ).toBeVisible();
      await shot(page, `${size}_guide_hysteria`);
      await calm(page);
      await calm(page);
      await fillAddress(page, {
        "Улица:": "Дубининская улица",
        "Дом/Вл:": "12",
        "Квартира/офис:": "47",
      });
      await confirmAddress(page);
      await shot(page, `${size}_readback_trap`);
      await fillAddress(page, { "Улица:": "Дубнинская улица" });
      await confirmAddress(page);
      await ask(page, "Что рядом с домом — магазин, школа, остановка?");
      await ask(page, "Это ваш номер? Если связь прервётся, я перезвоню.");
      await page.getByLabel("Тип происшествия").fill("задымление квартира");
      await page.getByRole("button", { name: /^задымление: квартира/ }).click();
      await shot(page, `${size}_steps`);
      await moveTalkAside(page, "right");
      await page.getByRole("button", { name: "Объяснение экрана" }).click();
      await shot(page, `${size}_help`);
      await page.keyboard.press("Escape");
      await moveTalkAside(page);
      const title = (await talk(page).getByRole("heading").boundingBox())!;
      await page.mouse.move(
        title.x + title.width / 2,
        title.y + title.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        title.x + title.width / 2 + 300,
        title.y + title.height / 2 - 120,
        { steps: 8 },
      );
      await page.mouse.up();
      await shot(page, `${size}_moved_talk`);
      const handle = talk(page).getByRole("button", {
        name: "Изменить размер окна разговора",
      });
      const corner = (await handle.boundingBox())!;
      await page.mouse.move(
        corner.x + corner.width / 2,
        corner.y + corner.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        corner.x + corner.width / 2 + 100,
        corner.y + corner.height / 2 + 60,
        { steps: 6 },
      );
      await page.mouse.up();
      await shot(page, `${size}_resized_talk`);
      // После снимка возвращаем окно: запись описания делается в левой колонке.
      const movedTitle = (await talk(page).getByRole("heading").boundingBox())!;
      await page.mouse.move(
        movedTitle.x + movedTitle.width / 2,
        movedTitle.y + movedTitle.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        movedTitle.x + movedTitle.width / 2 - 300,
        movedTitle.y + movedTitle.height / 2 + 120,
        { steps: 8 },
      );
      await page.mouse.up();
      await page
        .getByLabel("Описание со слов заявителя")
        .fill("Задымление в квартире 47, огня нет, бабушка не открывает.");
      await page
        .getByRole("button", { name: "сохранить", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Результат попытки" }),
      ).toBeVisible();
      await shot(page, `${size}_review`);
      await expect(talk(page)).toBeVisible();
    });
  });
}
