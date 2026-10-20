import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { coach, introSeenForAnyUser } from "./trainer";
import { csrf, deliver, send, startStep, training } from "./practice";
import { briefingText } from "./brigade-briefing";

type Card = components["schemas"]["Card"];
type Session = components["schemas"]["Session"];
type Brigade = components["schemas"]["Brigade"];
type CallTarget = components["schemas"]["CallTarget"];

// HQ-035: обучение (DT-18, решение 17.10) в браузере до конца, а не только vitest:
// показ «Смотрю» доходит до закрытия карточки — окно «Этап «Смотрю» пройден»; после карточки
// «Сам» ступени 1 «Как сделал бы опытный» в разборе — курсор опытного проходит ту же
// карточку, потом таблица «Опытный / Вы». «Услышано по телефону · Подставить» во «Вместе» —
// tutor-pointer.spec.ts.

const SHOTS = process.env.E2E_SHOTS_DIR ?? "qa/results/shots";
const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-local";

let owner = "";

// Показ идёт 4–7 минут: спеки ночного прогона (qa/playwright.config.ts, E2E_NIGHT=1).
const NIGHT = { tag: "@night" };

/** Попытки по ступеням обучаемого (`/api/progress`). */
async function stepAttempts(request: APIRequestContext): Promise<number[]> {
  const [own] = await (await request.get("/api/progress")).json();
  return own.steps.map((step: { attempts: number }) => step.attempts);
}

/** Карточка оценена: оценка приходит после закрытия, асинхронно. */
async function evaluated(request: APIRequestContext, cardId: string) {
  await expect
    .poll(
      async () =>
        (
          (await (await request.get("/api/evaluations")).json()) as {
            card_id: string;
          }[]
        ).some((item) => item.card_id === cardId),
      { timeout: 60_000 },
    )
    .toBe(true);
}

/** Тренировки обучаемого завершает он сам: показ, «Сам», показ опытного. */
async function finishPractice(request: APIRequestContext) {
  if (!owner) return;
  await request.post("/api/auth/login", {
    data: { login: owner, password: PASSWORD },
  });
  const sessions: Session[] = await (await request.get("/api/sessions")).json();
  for (const session of sessions)
    if (session.kind === "practice" && session.status === "running")
      await request.post(`/api/sessions/${session.id}/finish`, {
        headers: { "X-CSRF-Token": await csrf(request) },
      });
  owner = "";
}

test.afterEach(async ({ request }) => finishPractice(request));

async function enter(page: Page, login: string, introSeen: boolean) {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker, app.seed.training и явное E2E_DATABASE=1",
  );
  if (introSeen) await page.addInitScript(introSeenForAnyUser);
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: "Начать тренировку заново?" }),
    async (dialog) => {
      await dialog.getByRole("button", { name: "Начать заново" }).click();
    },
  );
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: "Параллельная работа" }),
    async (dialog) => {
      await dialog.getByRole("button", { name: "Понятно" }).click();
    },
  );
  owner = login;
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(login);
  await page.getByLabel("Пароль").fill(PASSWORD);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  await page
    .getByRole("button", { name: /^(Диспетчер служб|Перейти в тренажёр)$/ })
    .click();
  await expect(page).toHaveURL(/\/arm/);
}

async function openedCard(page: Page): Promise<Card> {
  await expect(page).toHaveURL(/\/arm\/cards\/[^/]+$/, { timeout: 20_000 });
  const id = decodeURIComponent(page.url().split("/").at(-1)!);
  const cards: Card[] = await (await page.request.get("/api/cards")).json();
  return cards.find((item) => item.id === id)!;
}

test(
  "«Смотрю» до конца: карточка закрыта, окно «Этап «Смотрю» пройден»",
  NIGHT,
  async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "Только Chromium");
    test.setTimeout(420_000);
    page.setDefaultTimeout(15_000);
    await enter(page, "trainee01", false);
    const before = await stepAttempts(page.request);
    await page
      .getByRole("button", { name: /^Тренировка/ })
      .first()
      .click();
    await page
      .getByRole("dialog", { name: "Как устроено обучение" })
      .getByRole("button", { name: /1\. Смотрю$/ })
      .click();
    const card = await openedCard(page);
    await expect(coach(page)).toContainText("Это показ.");

    // Курсор проводит карточку сам — от «Принята» до закрытия, со звонками бригаде.
    const done = page.getByRole("dialog", { name: "Этап «Смотрю» пройден" });
    await expect(done).toBeVisible({ timeout: 360_000 });
    await expect(done).toContainText(
      "Вы увидели карточку от сигнала до закрытия.",
    );
    await expect(done).toContainText("Дальше та же карточка, но нажимаете вы.");
    await expect(
      done.getByRole("button", { name: "Посмотреть ещё раз" }),
    ).toBeVisible();
    // Кнопка этапа сказана словами (капитан, 20.10), рядом — выход в главное меню.
    await expect(
      done.getByRole("button", { name: "Пройти карточку с подсказками" }),
    ).toBeVisible();
    await expect(
      done.getByRole("button", { name: "В главное меню" }),
    ).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/hq035-watch-done.png` });
    // «В главное меню» — к списку происшествий: «Мой путь», «Тренировка», этапы.
    await done.getByRole("button", { name: "В главное меню" }).click();
    await expect(done).toHaveCount(0);
    await expect(page).toHaveURL(/\/app\/arm$/);
    await expect(
      page.getByRole("button", { name: "Мой путь", exact: true }),
    ).toBeVisible();
    const closed: Card = await (
      await page.request.get(`/api/cards/${card.id}`)
    ).json();
    expect(closed.state).toBe("completed");
    // Карточку вёл курсор — это показ, а не попытка (HQ-034): ни одна ступень не растёт,
    // в «Моих результатах» её нет.
    await evaluated(page.request, card.id);
    expect(await stepAttempts(page.request)).toEqual(before);
    await page.goto("/app/arm/results");
    await expect(
      page.getByRole("heading", { name: "Мои результаты" }),
    ).toBeVisible();
    await expect(page.locator('[data-help="results-summary"]')).toContainText(
      "закрыто карточек: 0",
    );
  },
);

/** Карточка «Сам» ступени 1 через API до «Работы завершены» (как passTutorial в practice.ts). */
async function soloCardClosed(request: APIRequestContext): Promise<Card> {
  const { session, card } = await startStep(request, 1);
  const serviceId = session.participants[0].dds_service_id;
  await deliver(request, card.id);
  await send(request, card.id, "open", {});
  await send(request, card.id, "status_change", {
    state: "accepted",
    comment: "Принята, направляю бригаду",
  });
  const brigades: Brigade[] = await (
    await request.get(`/api/services/${serviceId}/brigades`)
  ).json();
  const brigade = [...brigades].sort((a, b) => a.name.localeCompare(b.name))[0];
  const targets: CallTarget[] = await (
    await request.get(`/api/services/${serviceId}/call-targets`)
  ).json();
  const target = targets.find((item) => item.brigade_id === brigade.id)!;
  await send(request, card.id, "brigades_select", {
    brigade_ids: [brigade.id],
  });
  const presented = new Set<string>();
  for (const [index, state] of [
    "responding",
    "arrived",
    "working",
    "completed",
  ].entries()) {
    const callId = crypto.randomUUID();
    await send(request, card.id, "call_dial_target", {
      call_id: callId,
      call_target_id: target.id,
      brigade_id: brigade.id,
    });
    await send(request, card.id, "call_answer", { call_id: callId });
    if (index === 0)
      await send(request, card.id, "brigade_briefing", {
        call_id: callId,
        mode: "parts",
        text: briefingText(card.source),
      });
    await expect
      .poll(async () => (await training(request, card.id)).messages.length, {
        timeout: 30_000,
      })
      .toBe(index + 1);
    await send(request, card.id, "call_hangup", { call_id: callId });
    for (const { delivery } of (await training(request, card.id)).messages) {
      if (presented.has(delivery.delivery_id)) continue;
      presented.add(delivery.delivery_id);
      const audio = delivery.message.audio;
      await send(request, card.id, "message_presented", {
        delivery_id: delivery.delivery_id,
        playback_id: crypto.randomUUID(),
        message_version: delivery.message.version,
        audio_version: audio ? audio.version : null,
        channel: audio ? "audio" : "text",
      });
    }
    await send(request, card.id, "status_change", {
      state,
      comment: delivery(state),
    });
  }
  return card;
}

function delivery(state: string): string {
  return {
    responding: "Бригада выехала",
    arrived: "Бригада на месте",
    working: "Работы начаты",
    completed: "Работы завершены",
  }[state]!;
}

test(
  "«Как сделал бы опытный»: показ той же карточки и таблица сравнения",
  NIGHT,
  async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "Только Chromium");
    test.setTimeout(420_000);
    page.setDefaultTimeout(15_000);
    await enter(page, "trainee03", true);
    const mine = await soloCardClosed(page.request);
    await evaluated(page.request, mine.id);
    const before = await stepAttempts(page.request);

    // Разбор карточки «Сам» ступени 1: кнопка «Как сделал бы опытный» — таблицы ещё нет.
    await page.goto("/app/arm/results");
    const review = page.locator('[data-help="results-review"]');
    await expect(review).toContainText(mine.source.number);
    const summary = page.locator('[data-help="results-summary"]');
    const closedBefore = /закрыто карточек: \d+/.exec(
      await summary.innerText(),
    )![0];
    const button = review.getByRole("button", {
      name: "Как сделал бы опытный",
    });
    await expect(button).toBeEnabled();
    await expect(
      review.getByRole("region", { name: "Как сделал бы опытный" }),
    ).toHaveCount(0);
    await button.click();

    // Курсор опытного проходит ту же карточку (новая тренировка), в подсказке — «Как сделал
    // бы опытный»; потом разбор моей карточки уже с таблицей.
    const expert = await openedCard(page);
    await expect(coach(page)).toContainText("Как сделал бы опытный");
    await page.screenshot({ path: `${SHOTS}/hq035-expert-show.png` });
    const table = page.getByRole("region", { name: "Как сделал бы опытный" });
    await expect(table).toBeVisible({ timeout: 360_000 });
    await expect(page).toHaveURL(/\/arm\/results/);
    await expect(review).toContainText(mine.source.number);
    await expect(table.locator("thead")).toHaveText(/Опытный\s*Вы/);
    await expect(table.locator("tbody tr").first()).toContainText("«Принята»");
    expect(await table.locator("tbody tr").count()).toBeGreaterThan(1);
    await expect(table).toContainText("время от показа карточки");
    await table.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/hq035-expert-table.png` });
    // Карточка опытного — показ (HQ-034): в ступени не идёт, в «Моих результатах» её нет.
    await evaluated(page.request, expert.id);
    expect(await stepAttempts(page.request)).toEqual(before);
    await expect(summary).toContainText(closedBefore);
  },
);
