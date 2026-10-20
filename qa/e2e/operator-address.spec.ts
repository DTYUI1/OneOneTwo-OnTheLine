import { expect, test } from "@playwright/test";
import {
  calm,
  confirmAddress,
  lastLine,
  openCall,
  scenario,
} from "./operator-call";
import { OPERATOR_MODULE, OPERATOR_OFF_REASON } from "./operator-module";

test.skip(!OPERATOR_MODULE, OPERATOR_OFF_REASON);

test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");

test("офлайн-подсказки предлагают обе улицы; ошибку исправляет повтор адреса", async ({
  page,
}) => {
  await openCall(page, "fire_apartment_smoke");
  await calm(page);
  await calm(page);
  const external: string[] = [];
  const origin = new URL(page.url()).origin;
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) external.push(request.url());
  });
  const input = page.getByRole("combobox", { name: "Адрес одной строкой" });
  await input.fill("дубн, 12");
  const streets = page.getByRole("listbox", { name: "Подсказки улиц" });
  await expect(streets.getByRole("option")).toHaveCount(2);
  await expect(streets).toContainText("Дубнинская улица");
  await expect(streets).toContainText("Дубининская улица");
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(page.getByLabel("Улица:")).toHaveValue("Дубининская улица");
  await expect(page.getByLabel("Дом/Вл:")).toHaveValue("12");
  await expect(page.getByLabel("Округ:")).toHaveValue("");
  await confirmAddress(page);
  expect(await lastLine(page)).toBe(
    `Заявитель: ${scenario("fire_apartment_smoke").address_confirmation.wrong_street}`,
  );
  await input.fill("дубн, 12");
  await streets
    .getByRole("option")
    .filter({ hasText: "Дубнинская улица" })
    .click();
  await expect(page.getByLabel("Округ:")).toHaveValue("САО");
  await expect(page.getByLabel("Район:")).toHaveValue("Западное Дегунино");
  await page.getByLabel("Подъезд:").fill("2");
  await page.getByLabel("Этаж:").fill("5");
  await expect(page.getByLabel("Подъезд:")).toHaveValue("2");
  expect(external).toEqual([]);
});
