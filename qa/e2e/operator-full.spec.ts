import { expect, test, type Page } from "@playwright/test";
import {
  ask,
  calm,
  cardQuestions,
  confirmAddress,
  lastLine,
  openCall,
  scenario,
} from "./operator-call";

const ID = "fire_apartment_smoke";
const QUESTION = Object.fromEntries(
  cardQuestions(ID).map((question) => [question.key, question.text]),
);
const GIRL = scenario(ID);
// Этап 3: лишние вопросы — правдоподобные для шага (в истерике не слышны, как и все).
const EXTRA = GIRL.distractors.map((item) => item.text).slice(0, 2);

// OP-10: сквозной путь модуля «Оператор 112» — спокойный и панический сценарии,
// русский интерфейс экрана (без латиницы, как russian-ui.spec.ts), консоль и сеть без ошибок.
test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");
test.use({ viewport: { width: 1920, height: 1080 } });

function watch(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (e) => {
    if (e.type() === "error") errors.push(e.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
  });
  return errors;
}

// SMS — общепринятая аббревиатура, как CSV в russian-ui.spec.ts.
const ALLOWED = /(?<![A-Za-z])SMS(?![A-Za-z])/g;

async function assertRussian(page: Page) {
  await expect(
    page.getByText(/^(?:Загрузка|Загружаем)(?:\s.*)?…$/i),
  ).toHaveCount(0);
  const content = (await page.locator("body").innerText()).replace(ALLOWED, "");
  const words = [...new Set(content.match(/[A-Za-z]{3,}/g) ?? [])];
  expect(words).toEqual([]);
}

async function chooseFire(page: Page) {
  await page.getByLabel("Тип происшествия").fill("задымление квартира");
  await page.getByRole("button", { name: /^задымление: квартира/ }).click();
}

test("спокойный путь — верные вопросы, полная карточка, высокая оценка", async ({
  page,
}) => {
  const errors = watch(page);
  await openCall(page, ID, { user: "trainee01" });
  await chooseFire(page);
  // Этап 2: девушка в истерике — «Успокоить» подряд, адрес она назовёт сама.
  await calm(page);
  await calm(page);
  // Этап 3, стандарт приёма вызова: адрес — в карточку и повтором вслух, ориентир, номер
  // для обратной связи, затем что случилось и угроза людям.
  await page.getByLabel("Субъект:").fill("Москва");
  await page.getByLabel("Округ:").fill("САО");
  await page.getByLabel("Район:").fill("Западное Дегунино");
  await page.getByLabel("Улица:").fill("Дубнинская улица");
  await page.getByLabel("Дом/Вл:").fill("12");
  await page.getByLabel("Квартира/офис:").fill("47");
  await confirmAddress(page);
  expect(await lastLine(page)).toBe(
    `Заявитель: ${GIRL.address_confirmation.ok}`,
  );
  for (const key of ["landmark", "callback", "what_happened", "victims", "gas"])
    await ask(page, QUESTION[key]!);

  await page.getByRole("button", { name: "Пострадавшие", exact: true }).click();
  // «У соседей обычная газовая плита» — дом газифицирован, подставится Мосгаз.
  await page
    .getByRole("group", { name: "Проведена ли газификация" })
    .getByRole("button", { name: "Да", exact: true })
    .click();
  await page
    .getByLabel("Описание со слов заявителя")
    .fill(
      "Задымление в квартире 47 на пятом этаже дома 12 по Дубнинской улице: из-под двери " +
        "идёт густой дым, открытого огня заявитель не видит; в квартире пожилая соседка, не " +
        "выходит на стук, квартира заперта изнутри, подъезд открыт.",
    );
  await page.getByRole("button", { name: "сохранить", exact: true }).click();

  const result = page.getByRole("dialog", { name: "Результат попытки" });
  await expect(result).toBeVisible();
  const [total, max] = (await result.getByText(/^\d+ из \d+$/).innerText())
    .split(" из ")
    .map(Number);
  expect(total).toBeGreaterThanOrEqual(max - 5);
  await expect(result).toContainText("Тип происшествия определён верно");
  await expect(result).toContainText("Адрес указан верно");
  await expect(result).toContainText("Заявитель полностью успокоился");
  await expect(result).toContainText("Порядок по стандарту");

  await assertRussian(page);
  expect(errors).toEqual([]);
});

test("панический путь — нерелевантные вопросы, неполная карточка, низкая оценка с пояснениями", async ({
  page,
}) => {
  const errors = watch(page);
  await openCall(page, ID, { user: "trainee01" });
  // Без «Успокоить» девушка в истерике вопросов не слышит — и лишних тоже.
  for (const text of EXTRA) await ask(page, text);
  expect(scenario(ID).reactions.hysteria).toContain(
    (await lastLine(page)).replace(/^Заявитель: /, ""),
  );
  await page.getByRole("button", { name: "сохранить", exact: true }).click();

  const result = page.getByRole("dialog", { name: "Результат попытки" });
  await expect(result).toBeVisible();
  const [total, max] = (await result.getByText(/^\d+ из \d+$/).innerText())
    .split(" из ")
    .map(Number);
  expect(total).toBeLessThan(max * 0.3);
  await expect(result).toContainText("Тип происшествия указан неверно");
  await expect(result).toContainText("Описание не заполнено");
  await expect(result).toContainText("в панике");
  await expect(result).toContainText("первым спрошен не адрес");

  await assertRussian(page);
  expect(errors).toEqual([]);
});
