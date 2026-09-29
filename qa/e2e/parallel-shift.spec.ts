import { randomUUID } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";

type Card = components["schemas"]["Card"];
type Session = components["schemas"]["Session"];
type Scenario = components["schemas"]["Scenario"];
type CardTraining = components["schemas"]["CardTraining"];
type CallTarget = components["schemas"]["CallTarget"];

const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-local";

async function csrf(request: APIRequestContext) {
  return {
    "X-CSRF-Token": (await request.storageState()).cookies.find(
      (cookie) => cookie.name === "csrf",
    )!.value,
  };
}

async function event(
  page: Page,
  cardId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  const response = await page.request.post(`/api/cards/${cardId}/events`, {
    headers: await csrf(page.request),
    data: {
      client_event_id: randomUUID(),
      client_ts: new Date().toISOString(),
      type,
      payload,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

// Параллельная смена (27.09, Q11 / FR-1.5): вторая карточка приходит, пока обучаемый
// работает с первой, и видна во вкладках поверх неё; бригада первой карточки звонит
// сама — вкладка мигает, в полосе телефона «Ответить», доклад выдаётся в этот разговор.
test("Параллельная смена: вкладки, предупреждение и вызов бригады", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker, app.seed.training и явное E2E_DATABASE=1",
  );
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const login =
    testInfo.project.name === "chromium" ? "trainee03" : "trainee02";

  expect(
    (
      await request.post("/api/auth/login", {
        data: { login: "teacher", password: PASSWORD },
      })
    ).ok(),
  ).toBeTruthy();
  const headers = await csrf(request);
  const users: components["schemas"]["User"][] = await (
    await request.get("/api/users")
  ).json();
  const trainee = users.find((user) => user.login === login)!;
  const scenarios: Scenario[] = await (
    await request.get("/api/scenarios")
  ).json();
  // Учебный набор параллельной смены (seed/training.py, PARALLEL_KEY): номер 700042N.
  const parallel = scenarios
    .filter(
      (item) =>
        item.status === "approved" && item.card.number.startsWith("7000424"),
    )
    .sort((a, b) => a.card.number.localeCompare(b.card.number));
  test.skip(parallel.length < 2, "Нет учебных сценариев параллельной смены");
  const [first, second] = parallel;
  const settings = await (await request.get("/api/settings")).json();
  const created = await request.post("/api/sessions", {
    headers,
    data: {
      title: `Параллельная смена ${Date.now()}`,
      participants: [
        {
          user_id: trainee.id,
          workstation_number: 21,
          dds_service_id: first.target_service_id,
          level: 2,
        },
      ],
      settings_snapshot: { ...settings, hints_level: 0, parallel_cards: 2 },
    },
  });
  expect(created.status()).toBe(201);
  const session: Session = await created.json();
  try {
    for (const [order, scenario, delay] of [
      [1, first, 0],
      [2, second, 8_000],
    ] as const) {
      const response = await request.post(
        `/api/sessions/${session.id}/assignments`,
        {
          headers,
          data: {
            participant_id: trainee.id,
            scenario_id: scenario.id,
            order,
            planned_at: new Date(Date.now() + delay).toISOString(),
          },
        },
      );
      expect(response.status()).toBe(201);
    }
    expect(
      (
        await request.post(`/api/sessions/${session.id}/start`, { headers })
      ).ok(),
    ).toBeTruthy();

    await page.goto("/app/login");
    await page.getByLabel("Логин", { exact: true }).fill(login);
    await page.getByLabel("Пароль").fill(PASSWORD);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await page.getByRole("button", { name: "Диспетчер служб" }).click();

    // Предупреждение до работы: медлить нельзя.
    const notice = page.getByRole("dialog", { name: "Параллельная работа" });
    await expect(
      notice.getByText("Карточки будут приходить параллельно"),
    ).toBeVisible();
    await notice.getByRole("button", { name: "Понятно" }).click();
    await expect(
      page.getByText(/Параллельная работа: до 2 карточек/),
    ).toBeVisible();

    // Первая карточка — во вкладках; открываем её.
    const tabs = page.getByRole("navigation", {
      name: "Происшествия в работе",
    });
    const firstTab = tabs.getByRole("button", {
      name: new RegExp(`Происшествие ${first.card.number}`),
    });
    await expect(firstTab).toBeVisible({ timeout: 30_000 });
    await firstTab.click();
    const cardView = page.getByRole("region", {
      name: `Происшествие ${first.card.number}`,
      exact: true,
    });
    await expect(cardView).toBeVisible();

    // Вторая приходит, пока открыта первая: вкладка появляется, реакция по ней идёт.
    const secondTab = tabs.getByRole("button", {
      name: new RegExp(`Происшествие ${second.card.number}`),
    });
    await expect(secondTab).toBeVisible({ timeout: 30_000 });
    await expect(secondTab).toContainText("реакция");
    await expect(cardView).toBeVisible();

    // Первая: «Принята», бригада отправлена и сразу положена трубка — «Выехали» не
    // услышан. Бригада перезвонит сама.
    let card: Card | undefined;
    await expect
      .poll(async () => {
        const cards: Card[] = await (
          await page.request.get("/api/cards")
        ).json();
        card = cards.find(
          (item) =>
            item.session_id === session.id &&
            item.source.number === first.card.number,
        );
        return card?.delivered_at ?? null;
      })
      .not.toBeNull();
    await event(page, card!.id, "status_change", {
      state: "accepted",
      comment: "Принята",
    });
    const targets: CallTarget[] = await (
      await page.request.get(
        `/api/services/${first.target_service_id}/call-targets`,
      )
    ).json();
    const target = targets.find((item) => item.brigade_id !== null)!;
    await event(page, card!.id, "brigades_select", {
      brigade_ids: [target.brigade_id],
    });
    const dispatch = randomUUID();
    await event(page, card!.id, "call_dial_target", {
      call_id: dispatch,
      call_target_id: target.id,
      brigade_id: target.brigade_id,
    });
    await event(page, card!.id, "call_answer", { call_id: dispatch });
    await event(page, card!.id, "call_hangup", { call_id: dispatch });

    // Бригада вызывает: вкладка и кнопка в полосе телефона карточки.
    await expect(firstTab).toContainText("Бригада вызывает", {
      timeout: 30_000,
    });
    const answer = cardView.getByRole("button", {
      name: /Ответить: .* вызывает/,
    });
    await expect(answer).toBeVisible();
    await answer.click();
    await expect(cardView.getByText("Разговор", { exact: true })).toBeVisible();
    await expect
      .poll(
        async () => {
          const training: CardTraining = await (
            await page.request.get(`/api/cards/${card!.id}/training`)
          ).json();
          return training.messages.length;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    await expect(firstTab).not.toContainText("Бригада вызывает");

    // Переход ко второй посреди разговора спрашивает и кладёт трубку.
    await secondTab.click();
    const confirm = page.getByRole("dialog", { name: "Идёт разговор" });
    await confirm
      .getByRole("button", { name: "Завершить разговор и перейти" })
      .click();
    await expect(
      page.getByRole("region", {
        name: `Происшествие ${second.card.number}`,
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await request.post(`/api/sessions/${session.id}/finish`, { headers });
  }
});
