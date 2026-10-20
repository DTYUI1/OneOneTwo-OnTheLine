import {
  expect,
  test as base,
  type Locator,
  type Page,
} from "@playwright/test";
import { test as captain, login } from "./captain-fixture";
import { passWelcome, playTutorial, send, signIn } from "./practice-play";

// TC-10 (docs/dds_touches.md): каждое замечание разбора — последствие в мире вместо минуса,
// страница памятки ДДС и готовое «Повторите: …»; если есть — цитата сказанного или
// написанного. Статусы подряд быстрее порога — «карточку не читали», без снижения балла.
// Подсказки видны в разборе и на оценку не влияют.

/** Пункты «Что сделать иначе» блока «Итоги». */
function improvements(page: Page): Locator {
  return page
    .locator('[data-help="results-review"] dl')
    .locator("dt", { hasText: "Что сделать иначе" })
    .locator("xpath=following-sibling::dd[1]")
    .locator("ol > li");
}

async function expectEveryRemarkComplete(items: Locator) {
  const count = await items.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    await expect(item).toContainText("Последствие:");
    await expect(item).toContainText(/Памятка ДДС, с\. \d+\./);
    await expect(item).toContainText(/Повтор(ите|ять)/);
  }
}

base(
  "Разбор настоящей попытки: у каждой ошибки последствие и страница памятки",
  async ({ page }, testInfo) => {
    base.skip(
      process.env.E2E_DATABASE !== "1",
      "Нужны PostgreSQL, worker, app.seed.training и явное E2E_DATABASE=1",
    );
    base.skip(
      testInfo.project.name !== "chromium",
      "Одна учётка обучаемого: браузеры не делят тренировку",
    );
    base.setTimeout(240_000);
    page.setDefaultTimeout(15_000);
    await signIn(page, "trainee04");
    await page.goto("about:blank");
    // Подсказка сразу после открытия, «Принята» — меньше чем через 3 с: карточку не читали.
    const card = await playTutorial(page.request, (id) =>
      send(page.request, id, "hint_open", { hint_id: "status" }),
    );

    await page.goto("/app/arm");
    await passWelcome(page);
    await page.getByRole("link", { name: "Мои результаты" }).click();
    await page
      .getByRole("navigation", { name: "Закрытые карточки" })
      .getByRole("button", { name: new RegExp(card.source.number) })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Итоги" })).toBeVisible({
      timeout: 30_000,
    });
    const items = improvements(page);
    await expectEveryRemarkComplete(items);
    await expect(items.filter({ hasText: "карточку не читали" })).toContainText(
      "без снижения балла",
    );
    await expect(
      page.getByText("Подсказки открыты 1 раз: на оценку помощь не влияет"),
    ).toBeVisible();
  },
);

captain(
  "Разбор показывает цитату, замечание без штрафа и вопрос к данным",
  async ({ page, lesson }) => {
    const closed = {
      ...lesson.card,
      state: "completed",
      closed_at: new Date().toISOString(),
    };
    const remark = (
      text: string,
      kind: "error" | "notice" | "data",
      quote: string | null = null,
    ) => ({
      text,
      quote,
      consequence:
        kind === "data"
          ? "Без доклада статус по памятке не ставится: это ошибка данных сценария, а не ваша."
          : "Служба не оповещена — фактически не выехала: помощь заявителю не придёт.",
      memo_page: kind === "data" ? 22 : 26,
      repeat:
        kind === "data"
          ? "Повторять не нужно: на оценку это не влияет."
          : "Повторите: сверьте происшествие со своей службой.",
      kind,
    });
    const evaluation = {
      id: "e2e-evaluation-remarks",
      card_id: lesson.card.id,
      trainee_id: lesson.card.trainee_id,
      total: 0.5,
      status: "complete",
      teacher_comment: "",
      version: 1,
      model_info: { rules: "evalcore" },
      criteria: [
        {
          key: "routing",
          score: 0,
          weight: 1,
          critical: true,
          explanation: "Карточка маршрутизирована неверно.",
          evidence: [],
          remarks: [
            remark(
              "Карточка вашей службы не принята.",
              "error",
              "Не наша территория, передано в управу",
            ),
          ],
        },
        {
          key: "status_flow",
          score: 1,
          weight: 1,
          critical: false,
          explanation: "Последовательность статусов соответствует эталону.",
          evidence: [],
          remarks: [
            remark(
              "Статусы подряд быстрее 3 секунд: «Принята» — через 1 с после открытия карточки. Похоже, карточку не читали.",
              "notice",
            ),
            remark(
              "Вопрос к данным: эталон ждёт статус «Прибытие», но в плане сценария нет доклада бригады о нём.",
              "data",
            ),
          ],
        },
      ],
    };
    await page.route("**/api/cards", async (route) => {
      const response = await route.fetch();
      const cards = (await response.json()) as { id: string }[];
      await route
        .fulfill({
          response,
          json: cards.map((card) => (card.id === closed.id ? closed : card)),
        })
        .catch(() => undefined);
    });
    await page.route("**/api/evaluations", (route) =>
      route.fulfill({ json: [evaluation] }),
    );
    try {
      await login(page, "trainee05");
      await page.goto("/app/arm/results");
      const review = page.locator('[data-help="results-review"]');
      await expect(
        review.getByRole("heading", { name: "Итоги" }),
      ).toBeVisible();
      const items = improvements(page);
      await expect(items).toHaveCount(2);
      await expectEveryRemarkComplete(items);
      await expect(items.first()).toContainText(
        "Не наша территория, передано в управу",
      );
      await expect(items.nth(1)).toContainText("без снижения балла");
      await expect(
        review.locator("dt", { hasText: "Вопрос к данным" }),
      ).toBeVisible();
      await expect(
        review.getByText("Памятка ДДС, с. 22.", { exact: false }).first(),
      ).toBeVisible();
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await lesson.finish();
    }
  },
);
