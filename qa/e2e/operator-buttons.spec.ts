import { expect, test } from "@playwright/test";
import { calm, openCall, scenario, talk } from "./operator-call";
import { OPERATOR_MODULE, OPERATOR_OFF_REASON } from "./operator-module";

test.skip(!OPERATOR_MODULE, OPERATOR_OFF_REASON);

test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");
test.use({ viewport: { width: 1536, height: 864 } });

test("значки объясняются мышью и клавиатурой; ссылка открывает нужную часть справки", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openCall(page, "elevator_stuck");
  // Разговор не закрывает значки в карточке.
  await talk(page).getByRole("button", { name: "Свернуть разговор" }).click();
  const items = [
    ["Создать связь", "Создать связь"],
    ["Установить напоминание", "Установить напоминание"],
    ["Рука", "Рука"],
    ["Сообщить о проблеме", "Сообщить о проблеме"],
    ["список SMS", "Список SMS"],
    ["Действия телефона: АОН", "Значки телефона"],
    ["Сведения о номере: АОН", "Значки телефона"],
    ["Действия телефона: предоставленный", "Значки телефона"],
    ["Сведения о номере: предоставленный", "Значки телефона"],
    ["Действия телефона: телефон на место", "Значки телефона"],
    ["Сведения о номере: телефон на место", "Значки телефона"],
    ["Язык заявителя", "Язык заявителя"],
    ["Категория заявителя", "Категория заявителя"],
    ["Переводчик", "Переводчик"],
    ["Карта происшествия", "Карта происшествия"],
  ];
  for (const [label, title] of items) {
    const button = page.getByRole("button", { name: label!, exact: true });
    await button.click();
    const panel = page.getByRole("dialog", { name: title!, exact: true });
    await expect(panel).toContainText("В АРМ 112:");
    await expect(panel).toContainText("В тренажёре:");
    await expect(panel).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(button).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Закрыть подсказку" }).click();
  }
  await page
    .getByRole("button", { name: "Карта происшествия", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Открыть раздел справки «?»" })
    .click();
  await expect(
    page.getByRole("region", { name: "Объяснение экрана оператора 112" }),
  ).toContainText("Адрес");
  expect(errors).toEqual([]);
});

test("колокольчик записывается однажды и остаётся после следующего ответа и в разборе", async ({
  page,
}) => {
  await openCall(page, "elevator_stuck", { user: "trainee01" });
  const bell = page.getByRole("button", {
    name: "Важное происшествие",
    exact: true,
  });
  await bell.click();
  const panel = page.getByRole("dialog", {
    name: "Важное происшествие",
    exact: true,
  });
  await expect(panel).toContainText("Главный специалист оповещён");
  await expect(panel).toContainText("АРМ 1");
  await page.keyboard.press("Escape");
  await calm(page);
  await bell.click();
  await expect(panel).toContainText("Уже оповещён");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "сохранить", exact: true }).click();
  const result = page.getByRole("dialog", { name: "Результат попытки" });
  await expect(result).toBeVisible();
  await expect(
    result
      .getByRole("list", { name: "Лента разговора" })
      .getByText("позвал старшего", { exact: true }),
  ).toHaveCount(1);
});

test("записи содержат первую реплику и ответы, проигрываются и доступны после завершения", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = window as unknown as { recordingPlayback: string[] };
    state.recordingPlayback = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      state.recordingPlayback.push(this.currentSrc || this.src);
      return play.call(this);
    };
  });
  const id = "elevator_stuck";
  await openCall(page, id);
  await calm(page);
  await page
    .getByRole("button", { name: "записи звонков", exact: true })
    .click();
  const panel = page.getByRole("dialog", {
    name: "Записи звонков",
    exact: true,
  });
  await expect(panel).toContainText(scenario(id).opening);
  await expect(panel.getByRole("listitem")).toHaveCount(2);
  const plays = () =>
    page.evaluate(
      () =>
        (window as unknown as { recordingPlayback: string[] }).recordingPlayback
          .length,
    );
  const before = await plays();
  await panel
    .getByRole("button", { name: "Прослушать реплику 1", exact: true })
    .click();
  // Повтор может брать файл из кэша без нового сетевого запроса.
  await expect.poll(plays).toBeGreaterThan(before);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "срыв звонка", exact: true }).click();
  await page
    .getByRole("button", { name: "записи звонков", exact: true })
    .click();
  await expect(panel).toContainText(scenario(id).opening);
});
