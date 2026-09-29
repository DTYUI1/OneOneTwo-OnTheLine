import { expect, test } from "@playwright/test";
import { openCall, talk } from "./operator-call";

test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");
test.use({ viewport: { width: 1536, height: 864 } });

test("сворачивание сохраняет разговор, его журнал и доступ к приёмам", async ({
  page,
}) => {
  const conversation = await openCall(page, "dtp_victims_fuel");
  const opening = await conversation.getByRole("listitem").first().innerText();
  await conversation
    .getByRole("button", { name: "Свернуть разговор", exact: true })
    .click();
  await expect(conversation.getByRole("heading")).toBeVisible();
  await expect(
    conversation.getByRole("group", { name: "Вопросы заявителю" }),
  ).toBeHidden();
  await conversation
    .getByRole("button", { name: "Развернуть разговор", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(conversation.getByRole("listitem").first()).toHaveText(opening);
  await expect(
    talk(page).getByRole("button", { name: /^Успокоить/ }),
  ).toBeEnabled();
});

test("фокус открывает группы, выбор газа и взрыва меняет фишку и заголовок", async ({
  page,
}) => {
  await openCall(page, "dtp_victims_fuel");
  await page.getByLabel("Тип происшествия", { exact: true }).focus();
  const groups = page.getByRole("list", { name: "Группы происшествий" });
  await expect(
    groups.getByRole("button", { name: "101", exact: true }),
  ).toBeVisible();
  await groups.getByRole("button", { name: "104", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Происшествие 104", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Признаки происшествия", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Тип происшествия", { exact: true }).click();
  await groups.getByRole("button", { name: "Взрыв", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "П: Взрыв", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Где взрыв", exact: true }),
  ).toBeVisible();
});

test("отметки карточки добавляют службы; полные названия и ручной выбор сохраняются", async ({
  page,
}) => {
  await openCall(page, "dtp_victims_fuel");
  await page
    .getByLabel("Тип происшествия", { exact: true })
    .fill("задымление квартира");
  await page.getByRole("button", { name: /^задымление: квартира/ }).click();
  for (const label of ["Угроза людям", "Проведена ли газификация"]) {
    await page
      .getByRole("group", { name: label, exact: true })
      .getByRole("button", { name: "Да", exact: true })
      .click();
  }
  const bar = page.getByRole("list", { name: "Службы", exact: true });
  await expect(bar).toContainText("Служба 103");
  await expect(bar).toContainText("Служба 104");
  await page
    .getByRole("button", { name: "Добавить службы", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Добавьте службы" });
  await expect(
    dialog.getByRole("button", { name: /^Служба 101 \(ГУ МЧС/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Деп. ЖКХ", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Сохранить и закрыть", exact: true })
    .click();
  await expect(bar).toContainText("Деп. ЖКХ");
  await bar
    .getByRole("button", { name: "Убрать: Деп. ЖКХ", exact: true })
    .click();
  await expect(bar).not.toContainText("Деп. ЖКХ");
});
