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
type Service = components["schemas"]["Service"];
type Brigade = components["schemas"]["Brigade"];
type CallTarget = components["schemas"]["CallTarget"];
type CardTraining = components["schemas"]["CardTraining"];

// Сценарии самостоятельной тренировки (29.09): на ступени 2 выдаётся готовое происшествие
// (номер карточки 70005…), и бригада своей службы докладывает о выезде после статуса
// «Принята» и звонка — раньше на golden-сценарии бригада молчала.
const OWNER = "trainee02";
const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-local";

async function csrf(request: APIRequestContext): Promise<string> {
  return (await request.storageState()).cookies.find(
    (cookie) => cookie.name === "csrf",
  )!.value;
}

async function send(
  request: APIRequestContext,
  cardId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  const response = await request.post(`/api/cards/${cardId}/events`, {
    headers: { "X-CSRF-Token": await csrf(request) },
    data: {
      client_event_id: randomUUID(),
      client_ts: new Date().toISOString(),
      type,
      payload,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function startStep(request: APIRequestContext, step: number) {
  const started = await request.post(`/api/practice?step=${step}`, {
    headers: { "X-CSRF-Token": await csrf(request) },
  });
  expect(started.ok(), await started.text()).toBeTruthy();
  const session: Session = await started.json();
  let card: Card | undefined;
  await expect
    .poll(
      async () => {
        const cards: Card[] = await (await request.get("/api/cards")).json();
        card = cards.find((item) => item.session_id === session.id);
        return card?.id ?? null;
      },
      { timeout: 20_000 },
    )
    .not.toBeNull();
  return { session, card: card! };
}

async function training(
  request: APIRequestContext,
  cardId: string,
): Promise<CardTraining> {
  return (await request.get(`/api/cards/${cardId}/training`)).json();
}

/** Ступень 1 через API: полный цикл упражнения с докладами — открывает ступень 2. */
async function passTutorial(request: APIRequestContext) {
  const { session, card } = await startStep(request, 1);
  const serviceId = session.participants[0].dds_service_id;
  const address = card.source.address;
  await send(request, card.id, "deliver", {});
  await send(request, card.id, "open", {});
  await send(request, card.id, "status_change", {
    state: "accepted",
    comment: "Принята, направляю бригаду",
  });
  await send(request, card.id, "field_change", {
    field: "service_number",
    value: "15",
  });
  await send(request, card.id, "field_change", {
    field: "address",
    value: {
      city: address.city,
      street: address.street,
      house: address.house,
      building: address.building,
      apartment: address.apartment,
    },
  });
  const comment = [card.source.description, "Направлена бригада."];
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
    const callId = randomUUID();
    await send(request, card.id, "call_dial_target", {
      call_id: callId,
      call_target_id: target.id,
      brigade_id: brigade.id,
    });
    await send(request, card.id, "call_answer", { call_id: callId });
    await expect
      .poll(async () => (await training(request, card.id)).messages.length, {
        timeout: 30_000,
      })
      .toBe(index + 1);
    await send(request, card.id, "call_hangup", { call_id: callId });
    for (const { delivery } of (await training(request, card.id)).messages) {
      if (presented.has(delivery.delivery_id)) continue;
      presented.add(delivery.delivery_id);
      comment.push(delivery.message.text);
      const audio = delivery.message.audio;
      await send(request, card.id, "message_presented", {
        delivery_id: delivery.delivery_id,
        playback_id: randomUUID(),
        message_version: delivery.message.version,
        audio_version: audio ? audio.version : null,
        channel: audio ? "audio" : "text",
      });
    }
    await send(request, card.id, "field_change", {
      field: "comment",
      value: comment.join(" "),
    });
    await send(request, card.id, "status_change", {
      state,
      comment: comment.join(" "),
    });
  }
  await request.post(`/api/sessions/${session.id}/finish`, {
    headers: { "X-CSRF-Token": await csrf(request) },
  });
}

async function login(page: Page) {
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(OWNER);
  await page.getByLabel("Пароль").fill(PASSWORD);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  await page.getByRole("button", { name: "Диспетчер служб" }).click();
}

test("Ступень 2: готовое происшествие, бригада своей службы докладывает о выезде", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker, app.seed.training и явное E2E_DATABASE=1",
  );
  test.skip(
    testInfo.project.name !== "chromium",
    "Одна учётка обучаемого: браузеры не делят тренировку",
  );
  test.setTimeout(240_000);
  page.setDefaultTimeout(15_000);
  page.on("dialog", (dialog) => void dialog.accept());
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: "Параллельная работа" }),
    async (dialog) => {
      await dialog.getByRole("button", { name: "Понятно" }).click();
    },
  );
  await login(page);
  const request = page.request;
  const [progress] = await (await request.get("/api/progress")).json();
  if (!progress.steps[1].unlocked) await passTutorial(request);

  const { session, card } = await startStep(request, 2);
  // Ступень 2 — готовое происшествие тренировки, а не golden без докладов.
  expect(card.source.number).toMatch(/^70005\d{3}$/);
  const serviceId = session.participants[0].dds_service_id;

  await page.goto(`/app/arm/cards/${encodeURIComponent(card.id)}`);
  const cardView = page.getByRole("region", {
    name: `Происшествие ${card.source.number}`,
    exact: true,
  });
  await expect(cardView.getByText(card.source.description)).toBeVisible();
  const services: Service[] = await (await request.get("/api/services")).json();
  const service = services.find((item) => item.id === serviceId)!;
  await cardView
    .getByRole("button", { name: `Развернуть ${service.name}`, exact: true })
    .click();
  await cardView
    .getByRole("button", { name: "Изменить статус", exact: true })
    .click();
  await cardView.getByLabel("Статус", { exact: true }).selectOption("accepted");
  await cardView
    .getByLabel("Комментарий", { exact: true })
    .fill("Принята, направляю бригаду");
  await cardView
    .getByRole("button", { name: "Подтвердить", exact: true })
    .click();
  await expect
    .poll(async () => (await training(request, card.id)).card_id)
    .toBe(card.id);

  const phone = page.getByRole("button", {
    name: /^(Телефон|Звонок завершён)$/,
  });
  await phone.click();
  const panel = page.getByRole("region", { name: "Бригады службы" });
  await panel
    .getByRole("checkbox", { name: `Учебная бригада 1 службы ${serviceId}` })
    .check();
  await panel.getByRole("button", { name: "Направить выбранные" }).click();
  await panel
    .getByRole("list", { name: "Связь с бригадами" })
    .getByRole("button", { name: "Позвонить" })
    .first()
    .click();

  // Бригада на связи и докладывает о выезде: первый доклад плана — после «Принята».
  await expect
    .poll(async () => (await training(request, card.id)).messages.length, {
      timeout: 30_000,
    })
    .toBe(1);
  const [report] = (await training(request, card.id)).messages;
  expect(report.delivery.message.text).toMatch(/выех|направлен/);
  expect(report.delivery.message.audio).not.toBeNull();
  // Дальше бригада ждёт «Начало реагирования» — без статуса второго доклада нет.
  await page.waitForTimeout(8_000);
  expect((await training(request, card.id)).messages).toHaveLength(1);

  await request.post(`/api/sessions/${session.id}/finish`, {
    headers: { "X-CSRF-Token": await csrf(request) },
  });
});
