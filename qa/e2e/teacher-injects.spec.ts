import { randomUUID } from "node:crypto";
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { briefingText } from "./brigade-briefing";

type Card = components["schemas"]["Card"];
type CardTraining = components["schemas"]["CardTraining"];
type CallTarget = components["schemas"]["CallTarget"];

// DT-06: преподаватель подаёт вводную «Тревога бригады» с live-доски в идущее занятие;
// бригада обучаемого звонит тревожным вызовом. Ход обучаемого до «Прибытия» — через API
// (как в apps/api/tests/test_injects.py), подача вводной — через интерфейс доски.
const TRAINEE = "trainee03";
const PLACE = 7;
const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-local";
// «Задымление в квартире», 101, полный цикл: uuid5 из app/seed/practice.py (scenario_id).
const SCENARIO_KEY = "smoke-apartment";

async function csrf(request: APIRequestContext): Promise<string> {
  return (await request.storageState()).cookies.find(
    (cookie) => cookie.name === "csrf",
  )!.value;
}

async function signIn(baseURL: string, login: string) {
  const request = await playwrightRequest.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
  });
  const response = await request.post("/api/auth/login", {
    data: { login, password: PASSWORD },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return request;
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

async function training(
  request: APIRequestContext,
  cardId: string,
): Promise<CardTraining> {
  return (await request.get(`/api/cards/${cardId}/training`)).json();
}

type Message = CardTraining["messages"][number];

/** Дождаться реплики бригады, ещё не предъявленной обучаемому, и предъявить её. */
async function hear(
  request: APIRequestContext,
  cardId: string,
  match: (message: Message) => boolean = () => true,
): Promise<Message> {
  let found: Message | undefined;
  await expect
    .poll(
      async () => {
        found = (await training(request, cardId)).messages.find(
          (item) => item.state !== "presented" && match(item),
        );
        return Boolean(found);
      },
      { timeout: 45_000 },
    )
    .toBe(true);
  const { delivery } = found!;
  await send(request, cardId, "message_presented", {
    delivery_id: delivery.delivery_id,
    message_version: delivery.message.version,
    playback_id: randomUUID(),
    channel: delivery.message.audio ? "audio" : "text",
    audio_version: delivery.message.audio
      ? delivery.message.audio.version
      : null,
  });
  return found!;
}

test("Пульт: вводная «Тревога бригады» в идущее занятие", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker и сценарии тренировки (E2E_DATABASE=1)",
  );
  test.skip(
    testInfo.project.name !== "chromium",
    "Одна учётная запись обучаемого: браузеры не делят занятие",
  );
  test.setTimeout(240_000);
  page.setDefaultTimeout(20_000);
  const baseURL = testInfo.project.use.baseURL!;
  const teacher = await signIn(baseURL, "teacher");
  const trainee = await signIn(baseURL, TRAINEE);
  let sessionId = "";
  try {
    const users: { id: string; login: string }[] = await (
      await teacher.get("/api/users")
    ).json();
    const traineeId = users.find((user) => user.login === TRAINEE)!.id;
    const scenarios: {
      id: string;
      version: number;
      card: { number: string };
    }[] = await (await teacher.get("/api/scenarios")).json();
    // Полный цикл «Задымления», 101: номер карточки 70005{1}{0}{1}.
    const scenario = scenarios.find((item) => item.card.number === "70005101")!;
    expect(scenario, SCENARIO_KEY).toBeTruthy();
    const settings = await (await teacher.get("/api/settings")).json();
    const title = `Вводные ${Date.now()}`;
    const created = await teacher.post("/api/sessions", {
      headers: { "X-CSRF-Token": await csrf(teacher) },
      data: {
        title,
        participants: [
          {
            user_id: traineeId,
            workstation_number: PLACE,
            dds_service_id: "101",
            level: 1,
          },
        ],
        settings_snapshot: settings,
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    sessionId = (await created.json()).id;
    const batch = await teacher.post(
      `/api/sessions/${sessionId}/assignments/batch`,
      {
        headers: { "X-CSRF-Token": await csrf(teacher) },
        data: {
          request_id: randomUUID(),
          items: [
            {
              participant_id: traineeId,
              scenario_id: scenario.id,
              scenario_version: scenario.version,
              order: 1,
              delay_from_start_s: 0,
              delivery_mode: "profile",
            },
          ],
        },
      },
    );
    expect(batch.status(), await batch.text()).toBe(201);
    const started = await teacher.post(`/api/sessions/${sessionId}/start`, {
      headers: { "X-CSRF-Token": await csrf(teacher) },
    });
    expect(started.ok(), await started.text()).toBeTruthy();

    // Обучаемый: карточка, «Принята», расчёт направлен и на связи, выезд, повтор адреса
    // поправлен, «Прибытие». Тревогу можно подать только расчёту на месте.
    let card: Card | undefined;
    await expect
      .poll(
        async () => {
          const cards: Card[] = await (await trainee.get("/api/cards")).json();
          card = cards.find((item) => item.session_id === sessionId);
          return card?.id ?? null;
        },
        { timeout: 30_000 },
      )
      .not.toBeNull();
    const cardId = card!.id;
    await send(trainee, cardId, "deliver", {});
    await send(trainee, cardId, "status_change", {
      state: "accepted",
      comment: "Принята",
    });
    const brigadeId = (await training(trainee, cardId))
      .available_brigade_ids[0];
    const targets: CallTarget[] = await (
      await trainee.get("/api/services/101/call-targets")
    ).json();
    const target = targets.find((item) => item.brigade_id === brigadeId)!;
    await send(trainee, cardId, "brigades_select", {
      brigade_ids: [brigadeId],
    });
    const callId = randomUUID();
    await send(trainee, cardId, "call_dial_target", {
      call_id: callId,
      call_target_id: target.id,
      brigade_id: brigadeId,
    });
    await send(trainee, cardId, "call_answer", { call_id: callId });
    // GP-05: вводная — бригада выезжает и докладывает в этом разговоре.
    await send(trainee, cardId, "brigade_briefing", {
      call_id: callId,
      mode: "parts",
      text: briefingText(card!.source),
    });
    // Повтор адреса с ошибкой говорит сам доклад о выезде (проверка 17.10, carried_events).
    const readback = await hear(
      trainee,
      cardId,
      (item) => "reply_options" in item.delivery,
    );
    await send(trainee, cardId, "status_change", {
      state: "responding",
      comment: "Расчёт выехал",
    });
    await page.waitForTimeout(1_200);
    await send(trainee, cardId, "brigade_reply", {
      call_id: callId,
      delivery_id: readback.delivery.delivery_id,
      option_key: "fix",
    });
    // Ответ на поправку — фраза банка из сценария (GP-25): «Принял поправку, …».
    await hear(trainee, cardId, (item) =>
      item.delivery.message.text.startsWith("Принял поправку"),
    );
    await hear(trainee, cardId, (item) => !("reply_options" in item.delivery));
    await send(trainee, cardId, "status_change", {
      state: "arrived",
      comment: "Расчёт на месте",
    });
    // На месте расчёт спрашивает этаж, докладывает о работах и просит скорую жильцу (события
    // и доклады плана). Слушаем всё в этом же разговоре: иначе бригада перезвонит, а пока она
    // на связи, тревога не подаётся (решение 15.10).
    const floor = await hear(
      trainee,
      cardId,
      (item) => "reply_options" in item.delivery,
    );
    await page.waitForTimeout(1_200);
    await send(trainee, cardId, "brigade_reply", {
      call_id: callId,
      delivery_id: floor.delivery.delivery_id,
      option_key: "floor_9",
    });
    await hear(trainee, cardId, (item) =>
      item.delivery.message.text.startsWith("Понял, поднимаемся"),
    );
    await hear(trainee, cardId, (item) =>
      item.delivery.message.text.startsWith("Нашли очаг"),
    );
    await hear(trainee, cardId, (item) =>
      item.delivery.message.text.includes("срочно скорую"),
    );
    await send(trainee, cardId, "call_hangup", { call_id: callId });
    // Тревога не дописывается в только что законченный разговор: бригада звонит не раньше
    // чем через 10 с после отбоя (решение 15.10), иначе вводная «не подана».
    const hungUpAt = Date.now();

    // Преподаватель: доска занятия, «Добавить событие ▾» у плитки места — «Тревога бригады».
    await page.goto("/app/login");
    await page.getByLabel("Логин", { exact: true }).fill("teacher");
    await page.getByLabel("Пароль").fill(PASSWORD);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page).not.toHaveURL(/\/login$/);
    // На свежем стенде преподаватель сначала видит приветствие (28.09).
    const welcome = page.getByRole("button", { name: "Начать работу" });
    if (await welcome.isVisible({ timeout: 5_000 }).catch(() => false))
      await welcome.click();
    await page
      .getByRole("button", { name: new RegExp(title) })
      .first()
      .click();
    await page.getByRole("tab", { name: "Ход занятия" }).click();
    const board = page.getByRole("region", {
      name: "Доска выбранного занятия",
    });
    await expect(board.getByRole("heading", { name: title })).toBeVisible();
    const menu = board.getByRole("button", { name: `Добавить событие: АРМ ${PLACE}` });
    await expect(menu).toBeEnabled({ timeout: 20_000 });
    await page.waitForTimeout(Math.max(0, hungUpAt + 11_000 - Date.now()));
    expect((await training(trainee, cardId)).incoming ?? []).toEqual([]);
    await menu.click();
    await board.getByRole("menuitem", { name: /Тревога бригады/ }).click();
    const injects = board.getByRole("region", { name: "Вводные" });
    await expect(injects.getByRole("status")).toContainText(
      `АРМ ${PLACE} · подана, карточка ${card!.source.number}`,
    );
    await expect(injects.getByRole("list").last()).toContainText(
      `Тревога бригады · АРМ ${PLACE}`,
    );

    // Обучаемому бригада звонит тревожным вызовом.
    await expect
      .poll(async () =>
        (await training(trainee, cardId)).incoming?.map(
          (item) => item.priority,
        ),
      )
      .toEqual(["alarm"]);
  } finally {
    if (sessionId)
      await teacher.post(`/api/sessions/${sessionId}/finish`, {
        headers: { "X-CSRF-Token": await csrf(teacher) },
        data: { contract_version: 2, request_id: randomUUID() },
      });
    await teacher.dispose();
    await trainee.dispose();
  }
});
