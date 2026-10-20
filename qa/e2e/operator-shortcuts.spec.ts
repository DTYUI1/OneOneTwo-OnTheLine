import { expect, test, type Locator } from "@playwright/test";
import { login } from "./captain-fixture";
import { idle, talk } from "./operator-call";
import { OPERATOR_MODULE, OPERATOR_OFF_REASON } from "./operator-module";

test.skip(!OPERATOR_MODULE, OPERATOR_OFF_REASON);

test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");
test.use({ viewport: { width: 1536, height: 864 } });

test("приём вызова, заполнение и сохранение с клавиатуры; Alt не сдвигает карточку", async ({
  page,
}) => {
  const errors: string[] = [];
  const tabTo = async (target: Locator) => {
    for (let count = 0; count < 120; count++) {
      await page.keyboard.press("Shift+Tab");
      if (
        await target.evaluate((element) => element === document.activeElement)
      )
        return;
    }
    throw new Error("Кнопка недоступна последовательным переходом Tab");
  };
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page, "trainee01");
  await page.goto("/app/operator?scenario=elevator_stuck");
  const incoming = page.getByRole("dialog", { name: "Входящий вызов 112" });
  const guide = incoming.getByRole("checkbox", {
    name: "Проводник: подсказка на каждом шаге",
  });
  await guide.focus();
  if (await guide.isChecked()) await page.keyboard.press("Space");
  await incoming.getByRole("button", { name: "Принять вызов" }).focus();
  // После фокуса на приёме используем только клавиатуру.
  await page.keyboard.press("Enter");
  await tabTo(talk(page).getByRole("button", { name: "звук вкл." }));
  await page.keyboard.press("Enter");
  await idle(page);
  await tabTo(talk(page).getByRole("button", { name: "Свернуть разговор" }));
  await page.keyboard.press("Enter");
  const address = page.getByRole("combobox", { name: "Адрес одной строкой" });
  const before = await address.boundingBox();
  await page.keyboard.down("Alt");
  await expect(page.locator('[data-shortcuts="true"]')).toBeVisible();
  expect(await address.boundingBox()).toEqual(before);
  await page.keyboard.up("Alt");
  await expect(page.locator('[data-shortcuts="true"]')).toHaveCount(0);

  for (const [key, name, value] of [
    ["F1", "АОН", ""],
    ["F2", "предоставленный", "+79000000001"],
    ["F3", "телефон на место", "+79000000002"],
  ]) {
    await page.keyboard.press(`Alt+${key}`);
    await expect(
      page.getByRole("textbox", { name: name!, exact: true }),
    ).toBeFocused();
    if (value) await page.keyboard.insertText(value);
  }
  await page.keyboard.press("Alt+q");
  await expect(page.getByLabel("Фамилия и имя заявителя")).toBeFocused();
  await page.keyboard.insertText("Учебный заявитель");
  await page.keyboard.press("Alt+a");
  await expect(address).toBeFocused();
  await page.keyboard.insertText("Новочерёмушкинская, 8 к2");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Дом/Вл:")).toHaveValue("8");
  await expect(page.getByLabel("Корпус:")).toHaveValue("2");

  // При русской раскладке физическая клавиша A остаётся KeyA.
  await page.evaluate(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ф",
        code: "KeyA",
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await expect(address).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Alt+p");
  await expect(
    page.getByRole("button", { name: "Пострадавшие", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Alt+n");
  await expect(
    page.getByRole("button", { name: "нет контакта", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Alt+t");
  await expect(page.getByLabel("Тип происшествия")).toBeFocused();
  await page.keyboard.press("Alt+r");
  await expect(page.getByLabel("Тип происшествия")).toBeFocused();
  await page.keyboard.insertText("застревание лифт");
  const found = page.getByRole("list", { name: "Найденные типы" });
  const firstType = found.getByRole("button").first();
  await expect(firstType).toBeVisible();
  await page.keyboard.press("Tab");
  // Firefox включает прокручиваемый список в штатный порядок Tab.
  if (await found.evaluate((element) => element === document.activeElement))
    await page.keyboard.press("Tab");
  await expect(firstType).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-help="operator-card"]')).toBeVisible();
  await page.keyboard.press("Alt+1");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!document.activeElement?.closest(
            '[data-help="operator-card"] [role="group"]',
          ),
      ),
    )
    .toBe(true);
  await page.keyboard.press("Control+Alt+1");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!document.activeElement?.closest(
            '[data-help="operator-card"] [role="group"]',
          ),
      ),
    )
    .toBe(true);
  await page.keyboard.press("Alt+o");
  await expect(page.getByLabel("Описание со слов заявителя")).toBeFocused();
  await page.keyboard.insertText("Ребёнок застрял в лифте, требуется помощь.");
  await page.keyboard.press("Alt+z");
  await expect(
    page.getByRole("button", { name: "Добавить службы" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Добавьте службы" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Добавьте службы" }),
  ).toBeHidden();

  for (const [key, title] of [
    ["w", "Создать связь"],
    ["b", "Установить напоминание"],
    ["v", "Важное происшествие"],
    ["m", "Сообщить о проблеме"],
  ]) {
    await page.keyboard.press(`Alt+${key}`);
    await expect(
      page.getByRole("dialog", { name: title!, exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
  }
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/operator/save") &&
      response.request().method() === "POST",
  );
  await page.keyboard.press("Alt+s");
  const response = await saved;
  expect(response.ok()).toBe(true);
  const attempt = await response.json();
  expect(attempt.operator_card).toMatchObject({
    caller_name: "Учебный заявитель",
    phone_provided: "+79000000001",
    phone_scene: "+79000000002",
    address: { street: "Новочерёмушкинская улица", house: "8", building: "2" },
  });
  await expect(
    page.getByRole("dialog", { name: "Результат попытки" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
