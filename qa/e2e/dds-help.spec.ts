import { mkdirSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { test, login } from "./captain-fixture";
import { trainingLabel } from "../../apps/web/src/arm/listModel";
import { lesson, waitCard } from "./memo-lesson";
import { progress, unlockStep2 } from "./practice";
import { closePhone, dialTyped, phoneButton, phoneWindow } from "./phone";

// GP-23: подсказки по интерфейсу ДДС для самостоятельного знакомства (рекомендация 7,
// docs/meetings/2026-10-16_recommendations.md). Кнопка «?» («Объяснение экрана», F1)
// нумерует части рабочего поля; у каждой — пояснение и страница памятки. Пока подсказки
// выключены, экран тот же, что на снимках GP-16 (docs/dds_memo_check): подсказки только
// поверх. Занятие — trainee02 (служба 102): trainee05 может занимать другой прогон.
// Снимки к отчёту docs/dds_help.md — DDS_HELP_SHOTS=1.
test.skip(process.env.E2E_DATABASE !== "1", "Нужен стенд с БД");

const SHOTS = process.env.DDS_HELP_SHOTS === "1";
const OUT = process.env.DDS_HELP_SHOTS_OUT ?? "docs/dds_help";
const TRAINEE = "trainee02";

/** Части списка происшествий: каждое окно и кнопка (телефона на списке нет). */
const LIST_PARTS = [
  "Происшествия в работе",
  "Поиск происшествий",
  "Дата, часы и ваша служба",
  "Шапка списка",
  "Столбцы списка",
  "Список происшествий",
  "Строка происшествия",
  "Предпросмотр карточки",
  // Панели тренажёра нет (решение 17.10); этапы обучения — в шапке списка только на
  // ступени 1, у trainee02 их нет; подсказка тренажёра на занятии не появляется.
  "Тренировка",
  "Мой путь",
  "Разминка",
  "Мои результаты",
  "Справка",
];

/**
 * Телефон — только в открытой карточке (docs/decisions.md, «Телефон — только в открытой
 * карточке»): на списке ни значка, ни окна, ни их частей в справке.
 */
const NOT_ON_LIST = [
  "Значок телефона",
  "Телефон ДДС",
  "Верхняя полоса окна телефона",
  "Контакты телефона",
];

/** Карточка со строкой статуса. */
const CARD_PARTS = [
  "Телефоны и номер происшествия",
  "Заявитель",
  "Адрес происшествия",
  "Описание происшествия",
  "Признаки происшествия",
  "Отметки «ЧС» и «ЧП»",
  "Тип происшествия",
  "Класс происшествия",
  "Службы и закрытие",
  "Плитка вашей службы",
  "История статусов: кнопка",
  "Карандаш",
  "Закрыть карточку",
  "Изменение статуса",
  "Список «Статус»",
  "Номер наряда",
  "Комментарий к статусу",
  "Подтвердить статус",
  "Отменить ввод",
  "Значок телефона",
];

/** Звонок в 112 из карточки. */
const CALL_PARTS = [
  "Телефон ДДС",
  "Верхняя полоса окна телефона",
  "Управление разговором",
  "Ряд ответа",
];

/**
 * Вид экрана без подсказок: размеры и места кнопок, полей, таблиц и заголовков. Часы и
 * строки, где бегут секунды, из сравнения исключены. Два снимка подряд совпадают до пикселя
 * с допуском на дробные размеры текста.
 */
async function layout(page: Page): Promise<Record<string, number[]>> {
  return page.evaluate(() => {
    const out: Record<string, number[]> = {};
    const seen = new Map<string, number>();
    const skip =
      '[data-help-ui], [role="note"], [class*="clock"], [data-urgency]';
    document
      .querySelectorAll<HTMLElement>(
        "button, input, select, textarea, nav, table, tr, section, h2, h3, [data-help]",
      )
      .forEach((el) => {
        if (el.closest(skip)) return;
        const rect = el.getBoundingClientRect();
        if (!rect.width && !rect.height) return;
        const name = `${el.tagName} ${
          el.getAttribute("aria-label") ??
          el.getAttribute("data-help") ??
          (el.textContent ?? "").trim().slice(0, 30)
        }`;
        const n = (seen.get(name) ?? 0) + 1;
        seen.set(name, n);
        out[`${name} #${n}`] = [
          Math.round(rect.left + scrollX),
          Math.round(rect.top + scrollY),
          Math.round(rect.width),
          Math.round(rect.height),
        ];
      });
    return out;
  });
}

function expectSameLayout(
  before: Record<string, number[]>,
  after: Record<string, number[]>,
  step: string,
) {
  const changed = Object.entries(before)
    .filter(([name, box]) => {
      const next = after[name];
      return !next || box.some((value, i) => Math.abs(value - next[i]) > 2);
    })
    .map(([name, box]) => `${name}: ${box} → ${after[name] ?? "нет"}`);
  expect(changed, step).toEqual([]);
  expect(Object.keys(after).sort(), step).toEqual(Object.keys(before).sort());
}

const trigger = (page: Page) =>
  page.getByRole("button", { name: "Объяснение экрана", exact: true });
const panel = (page: Page) => page.locator('[data-help-ui] [role="region"]');
const marks = (page: Page) =>
  page.locator("[data-help-ui] button[aria-pressed]");

/** Названия частей, получивших номер, — без номера в начале. */
async function partTitles(page: Page): Promise<string[]> {
  const labels = await marks(page).evaluateAll((els) =>
    els.map((el) => el.getAttribute("aria-label") ?? ""),
  );
  return labels.map((label) => label.replace(/^\d+\.\s*/, ""));
}

/**
 * Обходит все части кнопкой «Далее»: у каждой есть заголовок с номером, текст и строка
 * со ссылкой на страницу памятки (или пометка, что в памятке этого нет).
 */
async function walk(page: Page, expected: number): Promise<string[]> {
  const help = panel(page);
  const next = help.getByRole("button", { name: "Далее", exact: true });
  const memo = help.locator("p", {
    hasText: /^(Памятка ДДС, с\. \d|В памятке ДДС этого нет)/,
  });
  const headings: string[] = [];
  for (let step = 0; step < expected + 2; step++) {
    await expect(memo, `часть ${step + 1}: строка про памятку`).toHaveCount(1);
    headings.push(
      (await help.getByRole("heading").innerText()).replace(/^\d+\.\s*/, ""),
    );
    if ((await next.getAttribute("aria-disabled")) === "true") break;
    await next.click();
  }
  expect(headings.length).toBe(expected);
  expect(new Set(headings).size, "заголовки частей не повторяются").toBe(
    expected,
  );
  return headings;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

test.describe("Подсказки по интерфейсу ДДС", () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test("список: включение, пояснения со страницей памятки, выключение", async ({
    page,
    request,
    playwright,
    baseURL,
  }) => {
    test.setTimeout(360_000);
    page.setDefaultTimeout(20_000);
    // Прогресс trainee02 задаём явно: ступень 1 пройдена (её проходит через API и
    // practice-scenarios). Прогресс меняют и другие спеки — подпись кнопки «Тренировка»
    // берём из его текущей ступени, а не терпим любую.
    const own = await playwright.request.newContext({ baseURL });
    let step: number;
    try {
      expect(
        (
          await own.post("/api/auth/login", {
            data: {
              login: TRAINEE,
              password: process.env.DEMO_PASSWORD ?? "demo-local",
            },
          })
        ).ok(),
      ).toBeTruthy();
      await unlockStep2(own);
      step = (await progress(own)).current_step;
    } finally {
      await own.dispose();
    }
    const current = await lesson(request, "102", TRAINEE);
    try {
      await login(page, TRAINEE);
      await waitCard(page, current.id);
      // После первой ступени у кнопки — номер текущей («Тренировка: ступень 2»).
      await expect(
        page.getByRole("button", {
          name: trainingLabel({ current_step: step }),
          exact: true,
        }),
      ).toBeVisible();
      // Без подсказок: нет ни номеров, ни панели; «?» стоит в шапке.
      await expect(page.locator("[data-help-ui]")).toHaveCount(0);
      await expect(trigger(page)).toHaveCount(1);
      await page.mouse.move(0, 0);
      const before = await layout(page);
      await shot(page, "list-off");

      await trigger(page).click();
      await expect(panel(page)).toBeVisible();
      const titles = await partTitles(page);
      await shot(page, "list-on");
      for (const part of LIST_PARTS)
        expect(titles, `нет части «${part}»`).toContain(part);
      for (const part of NOT_ON_LIST)
        expect(titles, `на списке часть «${part}»`).not.toContain(part);
      await walk(page, titles.length);

      // Кнопки правой колонки: панель их не закрывает (при нужде уходит влево).
      for (const [title, key] of [
        ["Тренировка", "tool-practice"],
        ["Мой путь", "tool-path"],
        ["Разминка", "tool-warmup"],
        ["Мои результаты", "tool-results"],
        ["Справка", "tool-reference"],
      ]) {
        await page
          .getByRole("button", { name: new RegExp(`^\\d+\\. ${title}$`) })
          .focus();
        await expect(panel(page).getByRole("heading")).toContainText(title);
        const panelBox = (await panel(page).boundingBox())!;
        const toolBox = (await page
          .locator(`[data-help="${key}"]`)
          .boundingBox())!;
        const apart =
          panelBox.x + panelBox.width <= toolBox.x ||
          toolBox.x + toolBox.width <= panelBox.x ||
          panelBox.y + panelBox.height <= toolBox.y ||
          toolBox.y + toolBox.height <= panelBox.y;
        expect(apart, `панель закрывает кнопку «${title}»`).toBe(true);
      }

      // Щелчок по кнопке экрана объясняет её и ничего не запускает.
      await page.getByRole("button", { name: "Мой путь", exact: true }).click();
      await expect(panel(page).getByRole("heading")).toContainText("Мой путь");
      await expect(page.getByRole("dialog", { name: "Мой путь" })).toHaveCount(
        0,
      );
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-help-ui]")).toHaveCount(0);
      await page.mouse.move(0, 0);
      expectSameLayout(before, await layout(page), "после Esc");

      // Те же включение и выключение клавишей F1 и самой кнопкой «?».
      await page.keyboard.press("F1");
      await expect(panel(page)).toBeVisible();
      await page.keyboard.press("F1");
      await expect(page.locator("[data-help-ui]")).toHaveCount(0);
      await trigger(page).click();
      await expect(panel(page)).toBeVisible();
      await panel(page)
        .getByRole("button", { name: "Закрыть объяснение", exact: true })
        .click();
      await expect(page.locator("[data-help-ui]")).toHaveCount(0);
      await page.mouse.move(0, 0);
      expectSameLayout(before, await layout(page), "после «Закрыть»");

      // Нижняя строка списка получает номер, когда до неё прокрутили экран.
      await page.locator('[data-help="arm-pager"]').scrollIntoViewIfNeeded();
      await page.keyboard.press("F1");
      await expect(panel(page)).toBeVisible();
      expect(await partTitles(page)).toContain("Страницы списка");
      await page.keyboard.press("Escape");
      await page.evaluate(() => scrollTo(0, 0));

      // Телефона на списке нет: ни значка, ни окна.
      await expect(phoneButton(page)).toHaveCount(0);
      await expect(phoneWindow(page)).toBeHidden();
    } finally {
      await current.finish();
    }
  });

  test("карточка: строка статуса, телефон и звонок получают пояснения", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    page.setDefaultTimeout(20_000);
    const current = await lesson(request, "102", TRAINEE);
    try {
      await login(page, TRAINEE);
      const card = await waitCard(page, current.id);
      await page.locator(`[data-card-id="${card.id}"]`).click();
      const view = page.getByRole("region", {
        name: `Происшествие ${card.source.number}`,
        exact: true,
      });
      await expect(view).toBeVisible();
      await view
        .getByRole("button", { name: "Изменить статус", exact: true })
        .click();
      await expect(view.getByLabel("Статус", { exact: true })).toBeVisible();
      await page.mouse.move(0, 0);
      const before = await layout(page);
      await shot(page, "card-off");

      await trigger(page).click();
      const titles = await partTitles(page);
      for (const part of CARD_PARTS)
        expect(titles, `нет части «${part}»`).toContain(part);
      await shot(page, "card-on");
      await walk(page, titles.length);
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-help-ui]")).toHaveCount(0);
      // Строка статуса осталась открытой: справка её не закрывает и не сдвигает.
      await expect(view.getByLabel("Статус", { exact: true })).toBeVisible();
      await page.mouse.move(0, 0);
      expectSameLayout(before, await layout(page), "карточка после Esc");

      // Звонок в 112: управление разговором и ряд ответа.
      await view.getByRole("button", { name: "Отменить", exact: true }).click();
      await dialTyped(page, "112");
      await trigger(page).click();
      const call = await partTitles(page);
      for (const part of CALL_PARTS)
        expect(call, `нет части «${part}»`).toContain(part);
      await shot(page, "call-on");
      await walk(page, call.length);
      await page.keyboard.press("Escape");
      await phoneWindow(page)
        .getByRole("button", { name: "Положить трубку", exact: true })
        .click();
      await closePhone(page);
      await expect(phoneButton(page).first()).toBeVisible();
    } finally {
      await current.finish();
    }
  });

  test("подсказки выключены преподавателем: кнопки «?» нет", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(20_000);
    const current = await lesson(request, "102", TRAINEE, 0);
    try {
      await login(page, TRAINEE);
      await waitCard(page, current.id);
      await expect(
        page.getByRole("button", { name: "Выйти", exact: true }),
      ).toBeVisible();
      await expect(trigger(page)).toHaveCount(0);
      await page.keyboard.press("F1");
      await expect(page.locator("[data-help-ui]")).toHaveCount(0);
    } finally {
      await current.finish();
    }
  });
});
