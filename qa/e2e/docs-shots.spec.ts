import { appendFileSync, mkdirSync } from "node:fs";
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import {
  answer,
  answerRing,
  backToContacts,
  closePhone,
  currentStep,
  expectEnded,
  expectTalking,
  freeBrigade,
  peerDone,
  phoneButton,
  phoneWindow,
} from "./phone";
import { introSeenForAnyUser } from "./trainer";

// Снимки экранов для документации (GP-22): docs/submission/documentation/img/ — только
// по запросу: E2E_DATABASE=1 DOCS_SHOTS=1. Папка — DOCS_SHOTS_OUT, тексты экранов для
// сверки — DOCS_SHOTS_TEXT (файл). Обучаемый — временная учётная запись «Орлов И. П.»
// (создаёт администратор, в конце уходит в корзину): в реестре нет следов прошлых
// прогонов. Снимки «Вердикты», «Отчёт» и «Мои результаты» берут закрытые занятия стенда:
// сначала пройдите сценарии набора на финал — `qa/smoke/dds_walk.py` (занятия «Обход ГП-12: …»).
// Сборка текстов и PDF — `python3 scripts/docs_pdf.py`.
test.skip(
  process.env.E2E_DATABASE !== "1" || process.env.DOCS_SHOTS !== "1",
  "Снимки — по запросу: E2E_DATABASE=1 DOCS_SHOTS=1",
);

type Card = components["schemas"]["Card"];
type Scenario = components["schemas"]["Scenario"];
type Session = components["schemas"]["Session"];
type User = components["schemas"]["User"];

const OUT = process.env.DOCS_SHOTS_OUT ?? "docs/submission/documentation/img";
const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-local";
const VIEWPORT = { width: 1366, height: 768 };
const RUN = Date.now().toString(36);
const TRAINEE = {
  login: `docs-${RUN}`,
  fullName: "Орлов Игорь Петрович",
  workstation: 7,
  service: "101",
};

test.use({
  viewport: VIEWPORT,
  // Микрофон — поддельное устройство Chromium: окно телефона показывает «Говорить».
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
  permissions: ["microphone"],
});

async function shot(page: Page, name: string) {
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

async function part(target: Locator, name: string) {
  mkdirSync(OUT, { recursive: true });
  await target.page().waitForTimeout(500);
  await target.screenshot({ path: `${OUT}/${name}.png` });
}

/** Страница целиком — длинные экраны кабинета. */
async function tall(page: Page, name: string) {
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

function note(name: string, text: string) {
  const file = process.env.DOCS_SHOTS_TEXT;
  if (file) appendFileSync(file, `\n===== ${name}\n${text}\n`);
}

async function csrfHeaders(request: APIRequestContext, login: string) {
  const response = await request.post("/api/auth/login", {
    data: { login, password: PASSWORD },
  });
  expect(response.ok()).toBeTruthy();
  const csrf = (await request.storageState()).cookies.find(
    (cookie) => cookie.name === "csrf",
  )!.value;
  return { "X-CSRF-Token": csrf };
}

/** Вход через форму; обучаемый проходит приветствие, остальные — «Начать работу». */
async function signIn(page: Page, login: string, welcome = true) {
  await page.addInitScript(introSeenForAnyUser);
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(login);
  await page.getByLabel("Пароль").fill(PASSWORD);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  if (!welcome) return;
  const start = page.getByRole("button", {
    name: /^(Перейти в тренажёр|Начать работу)$/,
  });
  await expect(
    start.or(page.getByRole("button", { name: "Выйти", exact: true })),
  ).toBeVisible();
  if (await start.isVisible()) await start.click();
}

/** Занятие по сценарию набора на финал (по номеру карточки) для одного обучаемого. */
async function lesson(
  request: APIRequestContext,
  options: { title: string; trainee: string; service: string; number: string },
) {
  const headers = await csrfHeaders(request, "teacher");
  const scenarios: Scenario[] = await (
    await request.get("/api/scenarios")
  ).json();
  const scenario = scenarios.find(
    (item) =>
      String(item.card.number) === options.number && item.status === "approved",
  );
  expect(scenario, `Нет сценария ${options.number}`).toBeTruthy();
  const users: User[] = await (await request.get("/api/users")).json();
  const trainee = users.find((user) => user.login === options.trainee)!;
  const settings = await (await request.get("/api/settings")).json();
  const created = await request.post("/api/sessions", {
    headers,
    data: {
      title: options.title,
      participants: [
        {
          user_id: trainee.id,
          workstation_number: trainee.workstation_number ?? 1,
          dds_service_id: options.service,
          level: 2,
        },
      ],
      settings_snapshot: { ...settings, hints_level: 1, parallel_cards: 1 },
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const session: Session = await created.json();
  const assigned = await request.post(
    `/api/sessions/${session.id}/assignments`,
    {
      headers,
      data: {
        participant_id: trainee.id,
        scenario_id: scenario!.id,
        order: 1,
        planned_at: new Date().toISOString(),
      },
    },
  );
  expect(assigned.status(), await assigned.text()).toBe(201);
  expect(
    (await request.post(`/api/sessions/${session.id}/start`, { headers })).ok(),
  ).toBeTruthy();
  return {
    id: session.id,
    finish: async () => {
      await request.post(`/api/sessions/${session.id}/finish`, { headers });
    },
  };
}

async function waitCard(page: Page, sessionId: string): Promise<Card> {
  let card: Card | undefined;
  await expect
    .poll(async () => {
      const cards: Card[] = await (await page.request.get("/api/cards")).json();
      card = cards.find((item) => item.session_id === sessionId);
      return card?.id ?? "";
    })
    .not.toBe("");
  await expect(page.locator(`[data-card-id="${card!.id}"]`)).toBeVisible();
  return card!;
}

/** Открыть закрытое занятие стенда по названию; false — такого нет. */
async function openFinished(page: Page, title: RegExp): Promise<boolean> {
  await page.goto("/app/teacher");
  const start = page.getByRole("button", { name: "Начать работу" });
  if (await start.isVisible().catch(() => false)) await start.click();
  const more = page.getByRole("button", { name: /^Показать завершённые/ });
  await expect(more).toBeVisible();
  await more.click();
  const item = page.getByRole("button", { name: title }).first();
  if (!(await item.isVisible().catch(() => false))) return false;
  await item.click();
  return true;
}

let traineeId = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ playwright, baseURL }) => {
  const api = await playwright.request.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
  });
  const headers = await csrfHeaders(api, "admin");
  const created = await api.post("/api/users", {
    headers,
    data: {
      login: TRAINEE.login,
      full_name: TRAINEE.fullName,
      role: "trainee",
      password: PASSWORD,
      workstation_number: TRAINEE.workstation,
      dds_service_id: TRAINEE.service,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  traineeId = ((await created.json()) as User).id;
  await api.dispose();
});

test.afterAll(async ({ playwright, baseURL }) => {
  const api = await playwright.request.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
  });
  const headers = await csrfHeaders(api, "admin");
  await api.post(`/api/users/${traineeId}/trash`, {
    headers,
    data: { reason: "Снимки для документации" },
  });
  await api.dispose();
});

test("экран входа и приветствие обучаемого", async ({ page }) => {
  await page.goto("/app/login");
  await expect(page.getByRole("button", { name: "Войти" })).toBeVisible();
  await shot(page, "login");
  note("login", await page.locator("body").innerText());
  await page.getByLabel("Логин", { exact: true }).fill(TRAINEE.login);
  await page.getByLabel("Пароль").fill(PASSWORD);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Перейти в тренажёр" }),
  ).toBeVisible();
  await shot(page, "trainee-welcome");
  note("trainee-welcome", await page.locator("body").innerText());
});

test("занятие: преподаватель следит, обучаемый ведёт карточку", async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(420_000);
  page.setDefaultTimeout(20_000);
  const current = await lesson(request, {
    title: "Занятие 101: задымление в квартире",
    trainee: TRAINEE.login,
    service: TRAINEE.service,
    number: "70005101",
  });
  // Преподаватель открывает «Ход занятия» до входа обучаемого — тогда видно, что он в сети.
  const teacher = await browser.newContext({
    viewport: VIEWPORT,
    ignoreHTTPSErrors: true,
  });
  const tp = await teacher.newPage();
  try {
    await signIn(tp, "teacher");
    // Идущее занятие кабинет открывает сам.
    await tp.getByRole("tab", { name: "Ход занятия" }).click();

    await signIn(page, TRAINEE.login);
    const card = await waitCard(page, current.id);
    // Всплывающее «Объяснение экрана» исчезает после первого щелчка.
    await page.locator("body").click({ position: { x: 5, y: 400 } });
    await shot(page, "arm-list");
    note("arm-list", await page.locator("body").innerText());

    await page.getByRole("button", { name: "Объяснение экрана" }).click();
    await shot(page, "arm-help");
    note("arm-help", await page.locator("body").innerText());
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Порядок работы" }).click();
    await shot(page, "workflow");
    note("workflow", await page.locator("body").innerText());
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Закрыть" })
      .first()
      .click();

    await page.locator(`[data-card-id="${card.id}"]`).click();
    const cardView = page.getByRole("region", {
      name: `Происшествие ${card.source.number}`,
      exact: true,
    });
    await expect(cardView).toBeVisible();
    await shot(page, "arm-card");
    note("arm-card", await page.locator("body").innerText());
    await shot(tp, "teacher-live");
    note("teacher-live", await tp.locator("main").innerText());
    await tp
      .getByRole("button", { name: /Вводная/ })
      .first()
      .click();
    await shot(tp, "teacher-inject");
    note("teacher-inject", await tp.locator("main").innerText());
    await tp.keyboard.press("Escape");

    await cardView
      .getByRole("button", { name: "Изменить статус", exact: true })
      .click();
    await cardView
      .getByLabel("Статус", { exact: true })
      .selectOption("accepted");
    await cardView
      .getByLabel("Комментарий", { exact: true })
      .fill(
        "Принята. Задымление в квартире 115, пожилой мужчина, возможны пострадавшие. Направляю пожарный расчёт.",
      );
    await shot(page, "arm-status-row");
    await cardView
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();
    await expect(
      cardView.getByLabel("Комментарий", { exact: true }),
    ).toHaveValue("");
    await shot(page, "arm-accepted");

    const win = phoneWindow(page);
    await phoneButton(page).first().click();
    await expect(win).toBeVisible();
    await shot(page, "phone-contacts");
    note("phone-contacts", await win.innerText());

    // Вводная бригаде по частям.
    await freeBrigade(win).click();
    await expectTalking(win);
    await part(win, "phone-brief-voice");
    await answer(win)
      .getByRole("button", { name: "По частям", exact: true })
      .click();
    await expect(currentStep(win, "Адрес")).toBeVisible();
    await part(win, "phone-brief-parts");
    note("phone-brief-parts", await win.innerText());
    const right = answer(win).locator(
      'button[data-reply="brief"][data-correct="true"]',
    );
    await right.click();
    await expect(currentStep(win, "Что случилось")).toBeVisible();
    await right.click();
    // Ловушка сценария: бригада повторяет адрес с ошибкой вместе с докладом о выезде
    // («Как поняли? … выезжаем!») — ответ «Понял» или поправка адреса, «Принял» нет.
    const heard = answer(win).getByRole("button", {
      name: "Понял",
      exact: true,
    });
    await expect(heard).toBeVisible({ timeout: 60_000 });
    await part(win, "phone-brigade-report");
    note("phone-brigade-report", await win.innerText());
    const partsButton = answer(win).getByRole("button", {
      name: "По частям",
      exact: true,
    });
    await expect(partsButton).toBeVisible({ timeout: 30_000 });
    if ((await partsButton.getAttribute("aria-pressed")) !== "true")
      await partsButton.click();
    const fix = win.getByRole("button", {
      name: "Поправка по адресу: Бескудниковский бульвар, 24",
      exact: true,
    });
    await expect(fix).toBeVisible({ timeout: 30_000 });
    await part(win, "phone-readback-fix");
    note("phone-readback-fix", await win.innerText());
    await fix.click();
    await expect(
      win.getByText("Принял поправку, перестраиваем маршрут."),
    ).toBeVisible({ timeout: 20_000 });
    await win
      .getByRole("button", { name: "Положить трубку", exact: true })
      .click();
    await expectEnded(win, 20_000);
    await part(win, "phone-ended");
    note("phone-ended", await win.innerText());
    await backToContacts(win);

    // Доклад службе: «Скорая помощь» из группы «Службы». Распознавание речи на стенде
    // выключено — окно предлагает ответ по частям.
    await win
      .getByRole("button", { name: "Позвонить: Скорая помощь 103" })
      .click();
    await expectTalking(win);
    await peerDone(win);
    await answer(win)
      .getByRole("button", { name: "Говорить", exact: true })
      .click();
    await page.waitForTimeout(1500);
    await part(win, "phone-recording");
    await answer(win).getByRole("button", { name: "Закончить ответ" }).click();
    await expect(win.getByText(/Доклад по частям, шаг/)).toBeVisible({
      timeout: 15_000,
    });
    await part(win, "phone-report-parts");
    note("phone-report-parts", await win.innerText());
    await win
      .getByRole("button", { name: "Положить трубку", exact: true })
      .click();
    await expectEnded(win, 20_000);
    await backToContacts(win);
    await closePhone(page);

    await cardView
      .getByRole("button", { name: "Изменить статус", exact: true })
      .click();
    const options = await cardView
      .getByLabel("Статус", { exact: true })
      .locator("option")
      .allInnerTexts();
    note("status options after accepted", options.join("\n"));
    await cardView
      .getByLabel("Статус", { exact: true })
      .selectOption("responding");
    await cardView
      .getByLabel("Комментарий", { exact: true })
      .fill("Начало реагирования. Расчёт выехал по адресу.");
    await cardView
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();
    await expect(
      cardView.getByLabel("Комментарий", { exact: true }),
    ).toHaveValue("");

    // Бригада докладывает о прибытии сама: входящий вызов.
    await expect(
      page.getByRole("button", { name: /^Телефон: входящих \d+$/ }),
    ).toBeVisible({ timeout: 120_000 });
    await shot(page, "arm-incoming");
    await phoneButton(page).first().click();
    await part(win, "phone-incoming");
    note("phone-incoming", await win.innerText());
    await answerRing(win);
    await expectTalking(win);
    await page.waitForTimeout(2500);
    await part(win, "phone-incoming-talk");
    note("phone-incoming-talk", await win.innerText());
    await shot(tp, "teacher-live-work");
  } finally {
    await teacher.close();
    await current.finish();
  }
});

test("обучаемый: результаты, «Мой путь», тренажёр", async ({ page }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(20_000);
  await signIn(page, "trainee03");
  await page.goto("/app/arm/results");
  await expect(page.getByText(/^закрыто карточек:/)).toBeVisible();
  await page.getByText("70005101 · задымление: квартира").first().click();
  await expect(
    page.getByRole("heading", { name: /Происшествие 70005101/ }),
  ).toBeVisible();
  await shot(page, "results");
  note("results", await page.locator("body").innerText());
  await page.getByText("Что ожидалось").scrollIntoViewIfNeeded();
  await shot(page, "results-detail");
  await page.goto("/app/arm");
  await page.getByRole("button", { name: "Мой путь", exact: true }).click();
  await expect(page.getByText("Мой путь: ступени обучения")).toBeVisible();
  await shot(page, "my-path");
  note("my-path", await page.locator("body").innerText());
  await page
    .getByRole("button", { name: "Закрыть", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "Справка", exact: true }).click();
  await shot(page, "reference");
  note("reference", await page.locator("body").innerText());
  await page.getByRole("button", { name: /Закрыть справку/ }).click();
  // «Проверьте себя» — в окне «Порядок работы» (19.10).
  await page
    .getByRole("button", { name: "Порядок работы", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Проверьте себя", exact: true })
    .click();
  await shot(page, "quiz");
  await page
    .getByRole("button", { name: "Закрыть", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "Разминка", exact: true }).click();
  await shot(page, "warmup");
  await page
    .getByRole("button", { name: "Закрыть", exact: true })
    .last()
    .click();
});

async function adminShots(browser: Browser) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  await signIn(page, "admin");
  await expect(
    page.getByRole("heading", { name: "Состояние системы" }).first(),
  ).toBeVisible();
  await page.waitForTimeout(1500);
  await shot(page, "admin-health");
  note("admin-health", await page.locator("main").innerText());
  const sections: [string, string][] = [
    ["Нормативы и оценка", "admin-norms"],
    ["Пользователи", "admin-users"],
    ["Копии и корзина", "admin-backups"],
    ["Службы ДДС", "admin-services"],
    ["Журнал аудита", "admin-audit"],
    ["Сообщения об ошибках", "admin-reports"],
  ];
  for (const [name, file] of sections) {
    await page.getByRole("button", { name, exact: true }).click();
    await page.waitForTimeout(1200);
    await shot(page, file);
    note(file, await page.locator("main").innerText());
  }
  await page.getByRole("button", { name: "Пользователи", exact: true }).click();
  await page.getByRole("button", { name: "+ Новый пользователь" }).click();
  await page.waitForTimeout(500);
  await shot(page, "admin-user-new");
  note("admin-user-new", await page.locator("main").innerText());
  await context.close();
}

test("администратор", async ({ browser }) => {
  test.setTimeout(120_000);
  await adminShots(browser);
});

test("преподаватель: кабинет, новое занятие, выдача", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  await signIn(page, "teacher", false);
  const start = page.getByRole("button", { name: "Начать работу" });
  await expect(start).toBeVisible();
  await shot(page, "teacher-welcome");
  await start.click();
  await page.getByRole("button", { name: "На главную" }).click();
  await shot(page, "teacher-home");
  note("teacher-home", await page.locator("main").innerText());

  await page.getByRole("button", { name: "+ Новое занятие" }).click();
  await page.getByLabel("Название").fill("Занятие 102: ДТП на Каширском шоссе");
  await page.getByRole("button", { name: "Добавить рабочее место" }).click();
  const seats = page.getByRole("region", { name: "Состав по рабочим местам" });
  const input = seats.locator("input").first();
  await input.fill("trainee03");
  await input.blur();
  await page.waitForTimeout(500);
  await shot(page, "teacher-new-lesson");
  await page
    .locator("details summary")
    .filter({ hasText: "Телефон ДДС" })
    .click();
  await page.waitForTimeout(500);
  await tall(page, "teacher-phone-contacts");
  note("teacher-new-lesson", await page.locator("main").innerText());
  await page.getByRole("button", { name: "Создать занятие" }).click();
  await expect(
    page.getByRole("tab", { name: "Состав и раздача" }),
  ).toBeVisible();
  await shot(page, "teacher-handout");
  await page
    .getByRole("button", { name: "Подобрать по службе и уровню" })
    .click();
  await page.waitForTimeout(1500);
  await shot(page, "teacher-handout-plan");
  note("teacher-handout", await page.locator("main").innerText());
  await page.getByRole("button", { name: /^Выдать задания/ }).click();
  await expect(page.getByText(/^Выдано заданий:/)).toBeVisible();
  await shot(page, "teacher-handout-issued");
});

test("преподаватель: студия, материалы, вердикты, отчёт", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  await signIn(page, "teacher");
  await page.getByRole("button", { name: /^Студия сценариев/ }).click();
  await expect(
    page.getByRole("heading", { name: "Студия сценариев" }),
  ).toBeVisible();
  await shot(page, "teacher-studio");
  await page.getByRole("tab", { name: /^пакеты/ }).click();
  await page.waitForTimeout(800);
  await shot(page, "teacher-packs");
  note("teacher-packs", await page.locator("main").innerText());
  await page.getByRole("tab", { name: /^рабочие/ }).click();
  await page.getByRole("button", { name: "+ Новый сценарий" }).click();
  await page.waitForTimeout(800);
  await shot(page, "teacher-editor");
  await page.getByRole("button", { name: "Материалы", exact: true }).click();
  await page.waitForTimeout(800);
  await shot(page, "teacher-materials");
  note("teacher-materials", await page.locator("main").innerText());

  // smoke-apartment-101-1, путь errors.
  const found = await openFinished(
    page,
    /Обход ГП-12: Задымление в квартире \(101\), ошибки/,
  );
  test.skip(
    !found,
    "Нет закрытого занятия «Обход ГП-12: …»: пройдите dds_walk.py",
  );
  await page.getByRole("tab", { name: /^Вердикты/ }).click();
  await expect(page.getByText("Решение преподавателя")).toBeVisible();
  await shot(page, "teacher-verdicts");
  await tall(page, "teacher-verdicts-full");
  note("teacher-verdicts", await page.locator("[role=tabpanel]").innerText());
  await page.getByRole("button", { name: "Разобрать действия" }).click();
  await page.waitForTimeout(1500);
  await tall(page, "teacher-replay");
  note("teacher-replay", await page.locator("[role=tabpanel]").innerText());
  await page.getByRole("tab", { name: /^Отчёт/ }).click();
  await expect(page.getByText("Типичные ошибки группы")).toBeVisible();
  await shot(page, "teacher-report");
  await tall(page, "teacher-report-full");
  note("teacher-report", await page.locator("[role=tabpanel]").innerText());
  await page
    .getByRole("button", { name: "Кузнецов Максим Андреевич", exact: true })
    .first()
    .click();
  await page.waitForTimeout(800);
  await tall(page, "teacher-person");
  note("teacher-person", await page.locator("[role=tabpanel]").innerText());
});
