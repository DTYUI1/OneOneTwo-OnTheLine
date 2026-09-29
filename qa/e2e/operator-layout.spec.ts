import { expect, test, type Locator } from "@playwright/test";
import { ask, cardQuestions, openCall, question } from "./operator-call";

// Этап 1 плана docs/operator_112_review/PLAN.md: экран оператора 112 был свёрстан под
// 1920×1080, и на ноутбуке разговор с заявителем сжимался до нуля. Проверяем три окна:
// 1366×768, 1536×864 (Full HD при масштабе 125 %) и 1920×1080. Этап 3 — ещё высоты с
// панелью браузера: окно 1366×768 даёт страницу около 1366×650, 1536×864 — около 1536×730.
test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");

const SIZES = [
  { width: 1366, height: 650 },
  { width: 1366, height: 768 },
  { width: 1536, height: 730 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
];
const UNUSED = "В тренажёре не используется";

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  expect(result).not.toBeNull();
  return result!;
}

for (const viewport of SIZES) {
  test.describe(`окно ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test("разговор, вопросы и опросная карта видны вместе", async ({
      page,
    }) => {
      // Взрослый звонит спокойно — видна подсказка начала звонка (у девушки — про истерику).
      const talk = await openCall(page, "dtp_victims_fuel");
      // До первого вопроса — с чего начать, отдельно от реплик заявителя.
      await expect(
        talk.getByText(/^Звонок принят, входящий номер/),
      ).toBeVisible();
      await expect(talk.getByRole("listitem")).toHaveCount(1);

      await page.getByLabel("Тип происшествия").fill("задымление квартира");
      await page.getByRole("button", { name: /^задымление: квартира/ }).click();
      const questions = talk.getByRole("group", { name: "Вопросы заявителю" });
      for (const [index, item] of cardQuestions("dtp_victims_fuel")
        .slice(0, 3)
        .entries()) {
        await ask(page, item.text);
        await expect(talk.getByRole("listitem")).toHaveCount(3 + index * 2);
      }
      await expect(talk.getByText(/^Звонок принят/)).toHaveCount(0);

      // Этап 3: все пять вкладок шагов на виду, описание слева не сжато до нуля.
      for (let step = 1; step <= 5; step++)
        await expect(
          talk
            .getByRole("group", { name: "Шаги опроса" })
            .getByRole("button", { name: new RegExp(`^${step}\\. `) }),
        ).toBeInViewport();
      const description = await box(
        page.getByLabel("Описание со слов заявителя"),
      );
      expect(description.height).toBeGreaterThanOrEqual(40);
      expect(description.y + description.height).toBeLessThanOrEqual(
        viewport.height,
      );

      // Последняя реплика видна между заголовком разговора и полосой вопросов,
      // полоса — внутри окна, карточка занимает всю доступную высоту колонки.
      const title = await box(talk.getByRole("heading"));
      const windowBox = await box(talk);
      expect(windowBox.x).toBeGreaterThanOrEqual(8);
      expect(windowBox.y).toBeGreaterThanOrEqual(8);
      expect(windowBox.x + windowBox.width).toBeLessThanOrEqual(
        viewport.width - 7,
      );
      expect(windowBox.y + windowBox.height).toBeLessThanOrEqual(
        viewport.height - 7,
      );
      for (const button of await questions.getByRole("button").all())
        await expect(button).toBeInViewport({ ratio: 1 });
      const last = await box(talk.getByRole("listitem").last());
      const strip = await box(questions);
      const card = await box(
        page.getByRole("heading", { name: "Происшествие 101" }),
      );
      expect(last.y).toBeGreaterThanOrEqual(title.y + title.height);
      expect(last.y + last.height).toBeLessThanOrEqual(strip.y + 1);
      expect(strip.y + strip.height).toBeLessThanOrEqual(viewport.height);
      const cardPanel = await box(
        page
          .getByRole("heading", { name: "Происшествие 101" })
          .locator("..")
          .locator(".."),
      );
      const column = await box(
        page.locator('[data-help="operator-quick"]').locator(".."),
      );
      expect(card.y + card.height).toBeLessThanOrEqual(
        cardPanel.y + cardPanel.height,
      );
      expect(cardPanel.y + cardPanel.height).toBeCloseTo(
        column.y + column.height,
        0,
      );
      const hardMode = await box(
        talk.getByRole("checkbox", { name: /Сложно/ }).locator(".."),
      );
      expect(hardMode.x + hardMode.width).toBeLessThanOrEqual(viewport.width);
      expect(hardMode.y + hardMode.height).toBeLessThanOrEqual(viewport.height);
      // Лента вмещает 4–5 последних строк при открытой опросной карте.
      const logHeight = await talk
        .getByRole("list")
        .evaluate((list) => list.parentElement!.clientHeight);
      expect(logHeight).toBeGreaterThanOrEqual(110);

      // Заданный вопрос не похож на выбранный тег карточки (вопрос — на вкладке шага 1).
      const asked = await question(
        page,
        cardQuestions("dtp_victims_fuel")[0]!.text,
      );
      await expect(asked).toHaveAccessibleDescription("Вопрос уже задан");
      const tag = page
        .getByRole("group", { name: "Внутридомовые объекты (пламя, дым)" })
        .getByRole("button", { name: "Квартира", exact: true });
      await expect(tag).toHaveAttribute("aria-pressed", "true");
      const background = (locator: Locator) =>
        locator.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        );
      expect(await background(asked)).not.toBe(await background(tag));
    });

    test("подписи шапки не обрезаны, нерабочие кнопки неактивны", async ({
      page,
    }) => {
      await openCall(page, "fire_apartment_smoke");
      for (const name of ["записи звонков", "список SMS"]) {
        const button = page.getByRole("button", { name, exact: true });
        await expect(button).toBeDisabled();
        await expect(button).toHaveAttribute("title", UNUSED);
        const fits = await button.evaluate((element) => {
          const own = element.getBoundingClientRect();
          const panel = element.parentElement!.getBoundingClientRect();
          const header = element.closest("header")!.getBoundingClientRect();
          return (
            own.right <= panel.right + 0.5 &&
            own.bottom <= panel.bottom + 0.5 &&
            own.bottom <= header.bottom + 0.5
          );
        });
        expect(fits, name).toBe(true);
      }
      await expect(
        page.getByRole("button", { name: "Переводчик" }),
      ).toBeDisabled();
      for (const name of ["Статус заявителя", "Язык заявителя"])
        await expect(page.getByLabel(name)).toBeDisabled();
      // Рабочие элементы не задеты.
      await expect(
        page.getByRole("button", { name: "сохранить", exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByRole("button", { name: "Добавить службы" }),
      ).toBeEnabled();
    });
  });
}
