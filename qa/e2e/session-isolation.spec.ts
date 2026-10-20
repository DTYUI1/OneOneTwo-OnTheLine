import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import type { PendingEvent } from "../../apps/web/src/shared/ws/outbox";
import { passWelcome } from "./captain-fixture";
import {
  backToContacts,
  callHead,
  closePhone,
  contact,
  expectTalking,
  openDial,
  openPhone,
  phoneWindow,
} from "./phone";
import { confirmAgain } from "./trainer";

type Card = components["schemas"]["Card"];
type Scenario = components["schemas"]["Scenario"];
type Session = components["schemas"]["Session"];

test.use({
  launchOptions: {
    firefoxUserPrefs: {
      "media.navigator.streams.fake": true,
      "media.navigator.permission.disabled": true,
    },
  },
});

async function login(page: Page, name: string) {
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(name);
  await page
    .getByLabel("Пароль")
    .fill(process.env.DEMO_PASSWORD ?? "demo-local");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  if (!name.startsWith("trainee")) await passWelcome(page);
}

async function pending(page: Page): Promise<PendingEvent[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("arm112-outbox-v1", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<PendingEvent[]>((resolve, reject) => {
        const request = db.transaction("events").objectStore("events").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });
}

test("Завершённые занятия: просмотр без действий, отказ старой карточки не блокирует новую", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный database-стенд");
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  await login(page, "teacher");
  const headers = {
    "X-CSRF-Token": (await page.context().cookies()).find(
      (c) => c.name === "csrf",
    )!.value,
  };
  const users = await (await page.request.get("/api/users")).json();
  const trainee = users.find(
    (u: { login: string }) =>
      u.login ===
      (testInfo.project.name === "chromium" ? "trainee02" : "trainee03"),
  );
  const templates: Scenario[] = await (
    await page.request.get("/api/scenarios")
  ).json();
  const source = templates.find(
    (s) => s.id === "00000000-0000-4000-8000-000000000100",
  )!;
  const settings = await (await page.request.get("/api/settings")).json();
  const lessons: Session[] = [];
  const scenarios: string[] = [];
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    ignoreHTTPSErrors: true,
  });
  const arm = await context.newPage();
  arm.setDefaultTimeout(15_000);
  await arm.addLocatorHandler(
    arm.getByRole("dialog", { name: "Параллельная работа" }),
    async (dialog) => {
      await dialog.getByRole("button", { name: "Понятно" }).click();
    },
  );
  const releases: (() => void)[] = [];
  const mutations: { cardId: string; body: unknown }[] = [];
  arm.on("request", (request) => {
    const match = /\/cards\/([^/]+)\/events$/.exec(request.url());
    if (match && request.method() === "POST")
      mutations.push({ cardId: match[1], body: request.postDataJSON() });
  });
  async function createLesson() {
    const scenario: Scenario = {
      ...source,
      id: randomUUID(),
      card: {
        ...source.card,
        number: `8${Date.now().toString().slice(-7)}`,
        incident_class: `Изоляция ${randomUUID()}`,
      },
    };
    expect(
      (
        await page.request.post("/api/scenarios", { headers, data: scenario })
      ).status(),
    ).toBe(201);
    scenarios.push(scenario.id);
    const response = await page.request.post("/api/sessions", {
      headers,
      data: {
        title: scenario.card.incident_class,
        participants: [
          {
            user_id: trainee.id,
            workstation_number: 22,
            dds_service_id: "102",
            level: 1,
          },
        ],
        settings_snapshot: settings,
      },
    });
    expect(response.status()).toBe(201);
    const lesson: Session = await response.json();
    lessons.push(lesson);
    expect(
      (
        await page.request.post(`/api/sessions/${lesson.id}/assignments`, {
          headers,
          data: {
            participant_id: trainee.id,
            scenario_id: scenario.id,
            order: 1,
            planned_at: new Date().toISOString(),
          },
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await page.request.post(`/api/sessions/${lesson.id}/start`, { headers })
      ).ok(),
    ).toBeTruthy();
    let card: Card | undefined;
    await expect
      .poll(async () => {
        const cards: Card[] = await (
          await page.request.get("/api/cards")
        ).json();
        card = cards.find((c) => c.session_id === lesson.id);
        return Boolean(card);
      })
      .toBe(true);
    return { lesson, card: card! };
  }
  const finish = async (id: string) =>
    expect(
      (await page.request.post(`/api/sessions/${id}/finish`, { headers })).ok(),
    ).toBeTruthy();
  const readCard = async (id: string): Promise<Card> =>
    (await page.request.get(`/api/cards/${id}`)).json();
  const events = async (id: string) =>
    (await page.request.get(`/api/cards/${id}/events`)).json();
  async function openCard(card: Card) {
    await arm
      .getByRole("row")
      .filter({ hasText: card.source.incident_class })
      .click();
    return arm.getByRole("region", {
      name: `Происшествие ${card.source.number}`,
      exact: true,
    });
  }
  try {
    const old = await createLesson();
    await finish(old.lesson.id);
    const current = await createLesson();
    let releaseContext!: () => void;
    const contextHeld = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    releases.push(releaseContext);
    await arm.route(`**/api/sessions/${old.lesson.id}`, async (route) => {
      await contextHeld;
      await route.continue();
    });
    await login(arm, trainee.login);
    await arm
      .getByRole("button", { name: /^(Диспетчер служб|Перейти в тренажёр)$/ })
      .click();
    // Стрелка знакомства с «?» бывает поверх строки реестра в новом контексте.
    await arm.keyboard.press("Escape");
    const oldView = await openCard(old.card);
    try {
      await expect(
        oldView.getByText("Загружаем данные занятия…"),
      ).toBeVisible();
      expect(mutations.filter((m) => m.cardId === old.card.id)).toEqual([]);
    } finally {
      releaseContext();
    }
    await expect(
      oldView.getByText(
        "Занятие завершено. Карточка доступна только для просмотра.",
      ),
    ).toBeVisible();
    // История статусов — синее окно над плиткой (DT-17, arm_dds/10–20): в нём только
    // «Добавлена» от 112 — карточку не получили и не открыли. Служебные записи
    // журнала окно скрывает; действий обучаемого нет — проверка mutations ниже.
    await oldView.getByRole("button", { name: "История статусов" }).click();
    const oldHistory = oldView.locator('[data-help="card-history"] li:visible');
    await expect(oldHistory).toHaveCount(1);
    await expect(oldHistory).toContainText("Добавлена");
    expect(mutations.filter((m) => m.cardId === old.card.id)).toEqual([]);
    expect(await readCard(old.card.id)).toMatchObject({
      state: "added",
      delivered_at: null,
      opened_at: null,
    });
    await oldView.getByRole("button", { name: "Закрыть карточку" }).click();
    const currentView = await openCard(current.card);
    await expect
      .poll(async () => (await readCard(current.card.id)).opened_at)
      .not.toBeNull();
    // Связь службы — окно телефона ДДС (GP-09), не внутри карточки: своя служба
    // набирается вручную.
    const talk = phoneWindow(arm);
    const ownService = async () => {
      const win = await openPhone(arm);
      await (await openDial(win)).fill("102");
      await win.getByRole("button", { name: "Позвонить", exact: true }).click();
    };
    // После завершения занятия набирать нечем: поле «Номер» и контакты недоступны.
    const dialOff = async () => {
      // Контакты — на вкладке «Справочник», поле «Номер» — на «Наборе» (правка 19.10).
      await openPhone(arm);
      await expect(contact(talk, "Скорая помощь 103")).toBeDisabled();
      await expect(await openDial(talk)).toBeDisabled();
    };
    await ownService();
    await expectTalking(talk);
    // Микрофона нет (29.09): звонок кладётся без доклада, записи и её загрузки нет.
    await talk
      .getByRole("button", { name: "Положить трубку", exact: true })
      .click();
    await backToContacts(talk);
    await closePhone(arm);
    await currentView
      .getByRole("button", { name: "Изменить статус", exact: true })
      .click();
    await currentView.getByLabel(/^Номер (службы|наряда)$/).fill("102");

    // Событие уже создано и записано в IndexedDB, но сервер получит его после finish.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    releases.push(release);
    let captured!: () => void;
    const started = new Promise<void>((resolve) => {
      captured = resolve;
    });
    await arm.route(`**/api/cards/${current.card.id}/events`, async (route) => {
      if (
        route.request().method() === "POST" &&
        route.request().postDataJSON().type === "field_change"
      ) {
        captured();
        await held;
      }
      await route.continue();
    });
    await currentView.getByLabel("Комментарий", { exact: true }).click();
    await started;
    const queued = (await pending(arm)).find(
      (item) => item.cardId === current.card.id,
    )!;
    const before = await events(current.card.id);
    const rejected = arm.waitForResponse(
      (r) =>
        r.url().endsWith(`/cards/${current.card.id}/events`) &&
        r.status() === 409,
    );
    await finish(current.lesson.id);
    release();
    await rejected;
    await expect(
      currentView.getByText(
        "Занятие завершено. Карточка доступна только для просмотра.",
      ),
    ).toBeVisible();
    await expect(
      currentView.getByRole("group", { name: "Действие по карточке" }),
    ).toHaveCount(0);
    await expect(
      currentView.getByRole("button", { name: "Изменить статус", exact: true }),
    ).toBeDisabled();
    await dialOff();
    await expect
      .poll(
        async () =>
          (await pending(arm)).find((item) => item.id === queued.id)?.failure,
      )
      .toBeTruthy();
    const failed = (await pending(arm)).find((item) => item.id === queued.id)!;
    // C-03: действие после finish получает 409 session_finished с этим текстом.
    expect(failed).toEqual({
      ...queued,
      failure: "Занятие завершено. Действие не принято.",
    });
    expect(await events(current.card.id)).toEqual(before);
    const accepted = mutations.find(
      (m) =>
        m.cardId === current.card.id &&
        (m.body as { type: string }).type === "open",
    )!;
    const traineeHeaders = {
      "X-CSRF-Token": (await context.cookies()).find(
        (cookie) => cookie.name === "csrf",
      )!.value,
    };
    const repeated = await arm.request.post(
      `/api/cards/${current.card.id}/events`,
      { headers: traineeHeaders, data: accepted.body },
    );
    expect(repeated.status()).toBe(200);
    expect((await repeated.json()).duplicate).toBe(true);
    await dialOff();

    const next = await createLesson();
    await arm.reload();
    // UI-10: перезагрузка сохраняет страницу текущей карточки.
    await expect(arm).toHaveURL(new RegExp(`/cards/${current.card.id}$`));
    await arm
      .getByRole("button", { name: "Закрыть карточку", exact: true })
      .click();
    const nextView = await openCard(next.card);
    await expect
      .poll(async () => (await readCard(next.card.id)).opened_at)
      .not.toBeNull();
    for (const state of ["accepted", "responding", "completed"]) {
      await nextView
        .getByRole("button", { name: "Изменить статус", exact: true })
        .click();
      await nextView.getByLabel("Статус", { exact: true }).selectOption(state);
      await nextView
        .getByLabel("Комментарий", { exact: true })
        .fill("Новое занятие работает");
      await nextView
        .getByRole("button", { name: "Подтвердить", exact: true })
        .click();
      if (state === "completed") {
        // Необратимый статус — вторым ✓: у ✓ подпись «Нажмите ✓ или Enter ещё раз» (17.10).
        await expect(confirmAgain(arm)).toBeVisible();
        await nextView
          .getByRole("button", { name: "Подтвердить", exact: true })
          .click();
      }
      // HTTP-состояние меняется раньше завершения refetch формы в UI.
      // Строка статуса всегда на виду (DT-19): после сохранения она очищена, а после
      // завершающего статуса её нет — карточка закрыта.
      if (state === "completed")
        await expect(
          nextView.getByRole("group", { name: "Действие по карточке" }),
        ).toHaveCount(0);
      else
        await expect(
          nextView.getByLabel("Комментарий", { exact: true }),
        ).toHaveValue("");
      await expect
        .poll(async () => (await readCard(next.card.id)).state)
        .toBe(state);
    }
    expect((await pending(arm)).find((item) => item.id === failed.id)).toEqual(
      failed,
    );
    expect(await events(old.card.id)).toEqual([]);
    expect(await events(current.card.id)).toEqual(before);
    expect(mutations.filter((m) => m.cardId === old.card.id)).toEqual([]);
    expect(
      mutations.filter(
        (m) =>
          m.cardId === current.card.id &&
          JSON.stringify(m.body) === JSON.stringify(queued.event),
      ),
    ).toHaveLength(1);
    await expect(
      arm.getByText(
        "Отклонённые действия сохранены. Остановлены только затронутые карточки.",
      ),
    ).toBeVisible();
    await arm
      .getByRole("button", { name: /Очистить очередь этой карточки/ })
      .click();
    await expect
      .poll(async () =>
        (await pending(arm)).find((item) => item.id === failed.id),
      )
      .toBeUndefined();
    expect(await events(current.card.id)).toEqual(before);

    // Finish во время гудков не должен породить отложенные answer/hangup.
    await nextView.getByRole("button", { name: "Закрыть карточку" }).click();
    const ringing = await createLesson();
    const ringingView = await openCard(ringing.card);
    await expect
      .poll(async () => (await readCard(ringing.card.id)).opened_at)
      .not.toBeNull();
    const dialed = arm.waitForResponse(
      (r) =>
        r.url().endsWith(`/cards/${ringing.card.id}/events`) &&
        r.request().postDataJSON()?.type === "call_dial" &&
        r.status() === 200,
    );
    await ownService();
    await dialed;
    await finish(ringing.lesson.id);
    await expect(
      ringingView.getByText(
        "Занятие завершено. Карточка доступна только для просмотра.",
      ),
    ).toBeVisible();
    await expect(callHead(talk)).toContainText("вызов сброшен");
    const stoppedEvents = await events(ringing.card.id);
    const stoppedRequests = mutations.filter(
      (m) => m.cardId === ringing.card.id,
    );
    // Дольше RING_AFTER_MS + ANSWER_AFTER_MS, чтобы отложенный ответ успел бы сработать.
    await arm.waitForTimeout(4200);
    expect(await events(ringing.card.id)).toEqual(stoppedEvents);
    expect(mutations.filter((m) => m.cardId === ringing.card.id)).toEqual(
      stoppedRequests,
    );
  } finally {
    for (const release of releases) release();
    await context.close();
    for (const lesson of lessons)
      await page.request.post(`/api/sessions/${lesson.id}/finish`, { headers });
    for (const id of scenarios)
      await page.request.post(`/api/scenarios/${id}/retire`, { headers });
  }
});
