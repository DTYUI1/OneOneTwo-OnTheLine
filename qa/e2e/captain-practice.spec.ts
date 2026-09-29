import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { QUESTIONS } from "../../apps/web/src/arm/quiz/quizModel";

type Card = components["schemas"]["Card"];
type Session = components["schemas"]["Session"];
type Service = components["schemas"]["Service"];
type CardTraining = components["schemas"]["CardTraining"];

let practiceId: string | null = null;
let practiceOwner = "";

test.afterEach(async ({ request }) => {
  if (!practiceId) return;
  // Личная тренировка включает подсказки уровня 1. Если оставить её идущей,
  // следующий help-mode для того же trainee05 увидит «Объяснение экрана».
  // Завершает её сам обучаемый: администратор в учебный процесс не вмешивается
  // (ТЗ, test_c07_admin_limits) и получал 403 — тренировки копились идущими.
  const loginResponse = await request.post("/api/auth/login", {
    data: {
      login: practiceOwner,
      password: process.env.DEMO_PASSWORD ?? "demo-local",
    },
  });
  expect(loginResponse.ok()).toBeTruthy();
  const csrf = (await request.storageState()).cookies.find(
    (cookie) => cookie.name === "csrf",
  )?.value;
  expect(csrf).toBeDefined();
  const finished = await request.post(`/api/sessions/${practiceId}/finish`, {
    headers: { "X-CSRF-Token": csrf! },
  });
  expect(finished.ok()).toBeTruthy();
  practiceId = null;
});

async function login(page: Page, name: string) {
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(name);
  await page
    .getByLabel("Пароль")
    .fill(process.env.DEMO_PASSWORD ?? "demo-local");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

// Тренировка обучаемого: памятка «Порядок работы» → запуск упражнения без
// преподавателя → проводник в карточке → бригада докладывает только после
// статуса диспетчера (requires_state), а не по часам от ответа на звонок.
test("Тренировка: памятка, проводник и бригада, ждущая решения диспетчера", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker, app.seed.training и явное E2E_DATABASE=1",
  );
  test.setTimeout(150_000);
  page.setDefaultTimeout(15_000);
  // Прежняя тренировка ещё идёт — подтверждаем окном «Начать заново».
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: "Начать тренировку заново?" }),
    async (dialog) => {
      await dialog.getByRole("button", { name: "Начать заново" }).click();
    },
  );
  // В общих тестовых учётках может оставаться параллельное занятие: его
  // предупреждение не относится к проверке личной тренировки.
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: "Параллельная работа" }),
    async (dialog) => {
      await dialog.getByRole("button", { name: "Понятно" }).click();
    },
  );
  practiceOwner =
    testInfo.project.name === "chromium" ? "trainee04" : "trainee05";
  await login(page, practiceOwner);

  // Порядок работы всегда доступен из шапки АРМ.
  await page.getByRole("button", { name: "Диспетчер служб" }).click();
  await page
    .getByRole("button", { name: "Порядок работы", exact: true })
    .click();
  const guide = page.getByRole("dialog", {
    name: "Порядок работы с карточкой",
  });
  await expect(guide.getByText("Выезд бригады")).toBeVisible();
  await guide.getByRole("button", { name: "Закрыть" }).click();

  // Проводник — только в обучающем упражнении: запускаем его явно (без ступени),
  // подпись кнопки реестра зависит от пройденного пути учётной записи.
  const started = await page.request.post("/api/practice", {
    headers: {
      "X-CSRF-Token": (await page.context().cookies()).find(
        (cookie) => cookie.name === "csrf",
      )!.value,
    },
  });
  expect(started.ok()).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: /^Тренировка/ }).first(),
  ).toBeVisible();
  let practice: Session | undefined;
  await expect
    .poll(async () => {
      const sessions: Session[] = await (
        await page.request.get("/api/sessions")
      ).json();
      practice = sessions.find(
        (item) => item.kind === "practice" && item.status === "running",
      );
      return practice?.id ?? null;
    })
    .not.toBeNull();
  practiceId = practice!.id;
  let card: Card | undefined;
  await expect
    .poll(
      async () => {
        const listed: Card[] = await (
          await page.request.get("/api/cards")
        ).json();
        card = listed.find((item) => item.session_id === practice!.id);
        return card?.id ?? null;
      },
      { timeout: 20_000 },
    )
    .not.toBeNull();
  // Запуск через API — кнопку не нажимали, карточку открываем по адресу.
  await page.goto(`/app/arm/cards/${encodeURIComponent(card!.id)}`);
  const cardView = page.getByRole("region", {
    name: `Происшествие ${card!.source.number}`,
    exact: true,
  });
  const tutor = page.getByRole("region", { name: "Проводник тренировки" });
  await expect(tutor.getByText("Шаг 2 из 8")).toBeVisible();

  const serviceId = practice!.participants[0].dds_service_id;
  const services: Service[] = await (
    await page.request.get("/api/services")
  ).json();
  const service = services.find((item) => item.id === serviceId)!;
  await cardView
    .getByRole("button", { name: `Развернуть ${service.name}`, exact: true })
    .click();
  async function status(state: string, comment: string) {
    await cardView
      .getByRole("button", { name: "Изменить статус", exact: true })
      .click();
    await cardView.getByLabel("Статус", { exact: true }).selectOption(state);
    await cardView.getByLabel("Комментарий", { exact: true }).fill(comment);
    await cardView
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();
    // Форма остаётся открытой: успешная отправка сбрасывает выбор статуса.
    await expect(cardView.getByLabel("Статус", { exact: true })).toHaveValue(
      "",
    );
  }
  async function training(): Promise<CardTraining> {
    return (await page.request.get(`/api/cards/${card!.id}/training`)).json();
  }

  await status("accepted", "Принята, направляю бригаду");
  await expect(tutor.getByText("Шаг 3 из 8")).toBeVisible();

  // После отбоя полоса телефона подписана «Звонок завершён» — это та же кнопка.
  const phone = page.getByRole("button", {
    name: /^(Телефон|Звонок завершён)$/,
  });
  await phone.click();
  const panel = page.getByRole("region", { name: "Бригады службы" });
  await panel
    .getByRole("checkbox", { name: `Учебная бригада 1 службы ${serviceId}` })
    .check();
  await panel.getByRole("button", { name: "Направить выбранные" }).click();
  await expect(tutor.getByText("Шаг 4 из 8")).toBeVisible();

  const links = panel.getByRole("list", { name: "Связь с бригадами" });
  async function callBrigade() {
    await links.getByRole("button", { name: "Позвонить" }).first().click();
    await expect(
      page.getByRole("button", { name: "Разговор", exact: true }),
    ).toBeVisible();
  }
  async function hangUp() {
    await page.getByRole("button", { name: "Положить трубку" }).click();
    await page
      .getByRole("button", { name: "Звонок завершён", exact: true })
      .click();
  }

  await callBrigade();
  await expect
    .poll(async () => (await training()).messages.length, { timeout: 20_000 })
    .toBe(1);
  await expect
    .poll(async () => (await training()).awaiting_state)
    .toBe("responding");
  if (testInfo.project.name === "chromium")
    await expect(
      panel.getByText("Бригада ждёт вашего решения", { exact: false }),
    ).toBeVisible({ timeout: 20_000 });
  // Бригада на связи, но без статуса «Начало реагирования» дальше не докладывает.
  await page.waitForTimeout(8_000);
  expect((await training()).messages).toHaveLength(1);
  await hangUp();

  await status("responding", "Бригада выехала");
  // Доклад службе пропущен: проводник идёт за статусом и напоминает о пропуске.
  await expect(tutor.getByText("Шаг 6 из 8")).toBeVisible();
  await expect(
    tutor.getByText(/Не забудьте: доложите диспетчеру службы/),
  ).toBeVisible();
  await phone.click();
  await callBrigade();
  await expect
    .poll(async () => (await training()).messages.length, { timeout: 20_000 })
    .toBe(2);
  await expect
    .poll(async () => (await training()).awaiting_state)
    .toBe("arrived");
  await hangUp();
});

const skipWithoutDatabase = () =>
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker, app.seed.training и явное E2E_DATABASE=1",
  );

/** Учётка обучаемого на проект: браузеры не делят одну тренировку. Открытая карточка
 * тренировки, оставшаяся от прошлых прогонов, закрывается заранее: иначе запуск
 * законно спросит «будет прервана». */
async function enterArm(page: Page, projectName: string) {
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: "Параллельная работа" }),
    async (dialog) => {
      await dialog.getByRole("button", { name: "Понятно" }).click();
    },
  );
  await login(page, projectName === "chromium" ? "trainee04" : "trainee05");
  const sessions: Session[] = await (
    await page.request.get("/api/sessions")
  ).json();
  const practice = new Set(
    sessions.filter((item) => item.kind === "practice").map((item) => item.id),
  );
  const cards: Card[] = await (await page.request.get("/api/cards")).json();
  for (const card of cards)
    if (
      practice.has(card.session_id) &&
      !card.closed_at &&
      !card.interrupted_at
    )
      await closeByApi(page, card);
  await page.getByRole("button", { name: "Диспетчер служб" }).click();
}

/** Карточка, которую АРМ открыл сам после запуска тренировки. */
async function openedPracticeCard(page: Page): Promise<Card> {
  await expect(page).toHaveURL(/\/arm\/cards\/[^/]+$/, { timeout: 20_000 });
  const id = decodeURIComponent(page.url().split("/").at(-1)!);
  const cards: Card[] = await (await page.request.get("/api/cards")).json();
  const card = cards.find((item) => item.id === id)!;
  expect(card).toBeDefined();
  practiceId = card.session_id;
  return card;
}

async function csrfOf(page: Page): Promise<string> {
  return (await page.context().storageState()).cookies.find(
    (cookie) => cookie.name === "csrf",
  )!.value;
}

async function cardEvent(
  page: Page,
  cardId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  const response = await page.request.post(`/api/cards/${cardId}/events`, {
    headers: { "X-CSRF-Token": await csrfOf(page) },
    data: {
      client_event_id: randomUUID(),
      client_ts: new Date().toISOString(),
      type,
      payload,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

/** Закрыть карточку тренировки мимо интерфейса: «Не принята» и перенаправление. */
async function closeByApi(page: Page, card: Card) {
  if (!card.delivered_at)
    // АРМ ещё не открыт и сам доставку не подтвердит; при гонке с ним — 409, это не ошибка.
    await page.request.post(`/api/cards/${card.id}/events`, {
      headers: { "X-CSRF-Token": await csrfOf(page) },
      data: {
        client_event_id: randomUUID(),
        client_ts: new Date().toISOString(),
        type: "deliver",
        payload: {},
      },
    });
  await expect
    .poll(async () => {
      const cards: Card[] = await (await page.request.get("/api/cards")).json();
      return cards.find((item) => item.id === card.id)?.delivered_at ?? null;
    })
    .not.toBeNull();
  const sessions: Session[] = await (
    await page.request.get("/api/sessions")
  ).json();
  const own = sessions.find((item) => item.id === card.session_id)!
    .participants[0].dds_service_id;
  const services: Service[] = await (
    await page.request.get("/api/services")
  ).json();
  const other = services.find((item) => item.id !== own)!;
  await cardEvent(page, card.id, "status_change", {
    state: "rejected",
    comment: "Не наша зона, передано в другую службу",
  });
  await cardEvent(page, card.id, "redirect", {
    service_id: other.id,
    comment: "Не наша зона, передано в другую службу",
  });
  await expect
    .poll(async () => {
      const cards: Card[] = await (await page.request.get("/api/cards")).json();
      return cards.find((item) => item.id === card.id)?.closed_at ?? null;
    })
    .not.toBeNull();
}

// Учебный цикл (practice-loop, 29.09): «Мой путь» → текущая ступень выделена →
// запуск → карточка открылась сама, окно закрылось → карточку закрыли → повтор
// без «тренировка будет прервана»: закрытая карточка тренировку не держит.
test("Учебный цикл: путь, карточка сама, повтор без подтверждения", async ({
  page,
}, testInfo) => {
  skipWithoutDatabase();
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await enterArm(page, testInfo.project.name);

  await page.getByRole("button", { name: "Мой путь", exact: true }).click();
  const path = page.getByRole("dialog", { name: "Мой путь" });
  const current = path
    .getByRole("listitem")
    .filter({ has: page.getByText("текущая", { exact: true }) });
  const done = path.getByText(/Все ступени пройдены/);
  await expect(current.or(done).first()).toBeVisible();
  const step =
    (await current.count()) > 0 ? current : path.getByRole("listitem").last();
  await step
    .getByRole("button", { name: /^Тренироваться: ступень \d$/ })
    .click();

  const first = await openedPracticeCard(page);
  await expect(path).toHaveCount(0);
  await expect(page.getByText(/появится в списке/)).toHaveCount(0);
  await expect(page.getByText(/карточка откроется сама/)).toHaveCount(0);

  await closeByApi(page, first);
  await page.goto("/app/arm");
  await page.getByRole("button", { name: "Тренировка", exact: true }).click();
  const second = await openedPracticeCard(page);
  expect(second.id).not.toBe(first.id);
  expect(dialogs).toEqual([]);
  // Первая карточка закрыта — окна «Начать заново» быть не должно.
  await expect(
    page.getByRole("dialog", { name: "Начать тренировку заново?" }),
  ).toHaveCount(0);
});

// Тест по памятке: неактивная «Проверить» объясняет, сколько осталось; после 5 из 5
// отсюда же запускается тренировка, и окно закрывается само.
test("Проверьте себя: осталось N и тренировка после 5 из 5", async ({
  page,
}, testInfo) => {
  skipWithoutDatabase();
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await enterArm(page, testInfo.project.name);
  await page
    .getByRole("button", { name: "Проверьте себя", exact: true })
    .click();
  const quiz = page.getByRole("dialog", { name: "Проверьте себя" });
  const groups = quiz.getByRole("group");
  await expect(groups).toHaveCount(5);

  async function answer(index: number) {
    const group = groups.nth(index);
    const legend = (await group.locator("legend").innerText()).trim();
    const question = QUESTIONS.find((item) => legend.endsWith(item.text))!;
    expect(question, legend).toBeDefined();
    await group
      .getByRole("radio", {
        name: question.options[question.answer],
        exact: true,
      })
      .check();
  }

  for (const index of [0, 1, 2]) await answer(index);
  await expect(
    quiz.getByRole("button", { name: "Проверить", exact: true }),
  ).toBeDisabled();
  await expect(
    quiz.getByText("Ответьте на все вопросы: осталось 2"),
  ).toBeVisible();
  await answer(3);
  await answer(4);
  await quiz.getByRole("button", { name: "Проверить", exact: true }).click();
  await expect(quiz.getByText("Верно 5 из 5.", { exact: false })).toBeVisible();
  await quiz
    .getByRole("button", { name: "Начать тренировку", exact: true })
    .click();
  await openedPracticeCard(page);
  await expect(quiz).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

// Повторный запуск при открытой карточке тренировки спрашивает окном АРМ, а не
// системным confirm: «Отмена» оставляет карточку, «Начать заново» выдаёт новую.
test("Начать тренировку заново: окно подтверждения вместо confirm", async ({
  page,
}, testInfo) => {
  skipWithoutDatabase();
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await enterArm(page, testInfo.project.name);
  const training = page.getByRole("button", { name: /^Тренировка/ }).first();
  await training.click();
  const first = await openedPracticeCard(page);

  await page.goto("/app/arm");
  await training.click();
  const ask = page.getByRole("dialog", { name: "Начать тренировку заново?" });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText(
    "Текущая тренировочная карточка будет прервана.",
  );
  await ask.getByRole("button", { name: "Отмена" }).click();
  await expect(ask).toHaveCount(0);
  await expect(training).toBeFocused();

  await training.click();
  await ask.getByRole("button", { name: "Начать заново" }).click();
  const second = await openedPracticeCard(page);
  expect(second.id).not.toBe(first.id);
  expect(dialogs).toEqual([]);
});
