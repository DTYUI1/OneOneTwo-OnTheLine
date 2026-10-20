import { expect, test } from "@playwright/test";
import { passWelcome, playTutorial, send, signIn } from "./practice-play";

// TC-11 (docs/dds_touches.md): на разборе — лента действий с отметками «+12,3 с» с прошлого
// действия и сводка «✓ совпало N · ! расхождения N» с флажком «только расхождения»; в
// «Моём пути» — прошлые рекомендации с отметкой новой попытки и повтор незачтённой карточки
// с «было → стало».
const OWNER = "trainee04";

function skipWithoutDatabase(project: string) {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker, app.seed.training и явное E2E_DATABASE=1",
  );
  test.skip(
    project !== "chromium",
    "Одна учётка обучаемого: браузеры не делят тренировку",
  );
}

test("Лента действий настоящей попытки: время и «+N с» у каждого действия", async ({
  page,
}, testInfo) => {
  skipWithoutDatabase(testInfo.project.name);
  test.setTimeout(240_000);
  page.setDefaultTimeout(15_000);
  await signIn(page, OWNER);
  await page.goto("about:blank");
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
  const review = page.locator('[data-help="results-review"]');
  await expect(review.getByRole("heading", { name: "Итоги" })).toBeVisible({
    timeout: 30_000,
  });

  await review.getByText("Лента действий", { exact: true }).click();
  const rows = review
    .getByRole("list", { name: "Лента действий" })
    .getByRole("listitem");
  // Упражнение: открытие, подсказка, пять статусов и четыре звонка бригаде с отбоем.
  expect(await rows.count()).toBeGreaterThanOrEqual(12);
  for (const text of await rows.allTextContents())
    expect(text).toMatch(/^\d{2}:\d{2} \+(\d+,\d с|\d+ мин \d{2} с) \S/);
  await expect(rows.first()).toContainText("Карточка открыта");
  for (const label of [
    "Подсказка",
    "Принята",
    "Звонок бригаде — ответили",
    "Звонок бригаде — отбой",
    "Доклад бригады",
    "Работы завершены",
  ])
    await expect(rows.filter({ hasText: label }).first()).toBeVisible();

  const summary = review.locator("details > summary", {
    hasText: "Все критерии",
  });
  await expect(summary).toContainText(/✓ совпало \d+ · ! расхождения \d+/);
  const differ = Number(
    /расхождения (\d+)/.exec((await summary.textContent()) ?? "")?.[1],
  );
  await summary.click();
  await review.getByLabel("только расхождения").check();
  const criteria = summary.locator("xpath=..").locator("ul").first();
  if (differ === 0)
    await expect(review.getByText("Расхождений нет.")).toBeVisible();
  else await expect(criteria.locator(":scope > li")).toHaveCount(differ);
});

test("«Мой путь»: прошлые рекомендации отмечены, незачтённая карточка ждёт повтора", async ({
  page,
}, testInfo) => {
  skipWithoutDatabase(testInfo.project.name);
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  // Ответ сервера настоящий, а повтор и отметки подставлены: незачтённую карточку
  // на стенде не получить без ручного прохождения с ошибками.
  await page.route("**/api/progress", async (route) => {
    const response = await route.fetch();
    const [own, ...rest] = (await response.json()) as Record<string, unknown>[];
    const advice = {
      based_on: 2,
      focus: [],
      next_step: 2,
      next: "Следующий шаг — ступень 2: Своя карточка.",
      summary: "Ошибок в последних карточках нет — переходите дальше.",
      previous: {
        card_id: "00000000-0000-4000-8000-0000000000aa",
        focus: [
          { criterion: "address", label: "Адрес", text: "…", status: "done" },
          {
            criterion: "status_flow",
            label: "Ход статусов",
            text: "…",
            status: "not_done",
          },
        ],
      },
    };
    const repeat = {
      scenario_id: "00000000-0000-4000-8000-0000000000bb",
      number: "70005001",
      incident_class: "Пожар",
      step: 2,
      was: 0.45,
      now: null,
      passed: false,
      last_card_id: "00000000-0000-4000-8000-0000000000cc",
    };
    await route
      .fulfill({
        response,
        json: [
          {
            ...own,
            advice,
            repeats: [
              repeat,
              {
                ...repeat,
                scenario_id: "00000000-0000-4000-8000-0000000000dd",
                number: "70005002",
                now: 0.82,
                passed: true,
              },
            ],
          },
          ...rest,
        ],
      })
      .catch(() => undefined);
  });
  try {
    await signIn(page, OWNER);
    await page.goto("/app/arm");
    await passWelcome(page);
    await page.getByRole("button", { name: "Мой путь", exact: true }).click();
    const path = page.getByRole("dialog", { name: "Мой путь" });
    const advice = path.getByLabel("Рекомендации");
    await expect(advice).toContainText("Как выполнены прошлые рекомендации");
    await expect(advice).toContainText("Адрес — выполнена");
    await expect(advice).toContainText("Ход статусов — не выполнена");
    const repeats = path.getByRole("region", {
      name: "Повтор незачтённых карточек",
    });
    const pending = repeats.getByRole("listitem").filter({
      hasText: "70005001",
    });
    await expect(pending).toContainText("ступень 2: было 45 %");
    await expect(
      pending.getByRole("button", { name: "Пройти повтор" }),
    ).toBeVisible();
    const fixed = repeats.getByRole("listitem").filter({ hasText: "70005002" });
    await expect(fixed).toContainText("было 45 % → стало 82 % · исправлено");
    await expect(fixed.getByRole("button")).toHaveCount(0);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});
