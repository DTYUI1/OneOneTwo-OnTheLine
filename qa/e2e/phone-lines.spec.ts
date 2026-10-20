import { randomUUID } from "node:crypto";
import {
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import {
  HOLD_LIMIT_MS,
  DROPPED_SHOWN_MS,
} from "../../apps/web/src/arm/phone/hold";
import { briefingText } from "./brigade-briefing";
import { test, login } from "./captain-fixture";
import {
  backToContacts,
  callHead,
  expectTalking,
  lineTab,
  openDial,
  openPhone,
} from "./phone";

type Card = components["schemas"]["Card"];
type CardTraining = components["schemas"]["CardTraining"];
type CallTarget = components["schemas"]["CallTarget"];
type Scenario = components["schemas"]["Scenario"];
type Session = components["schemas"]["Session"];
type User = components["schemas"]["User"];

// HQ-034: вкладки линий и удержание (проверка 17.10, docs/decisions.md «Звонки — вкладками на
// плашке звонков») в браузере, а не только в vitest (phone/hold.test.ts, phone/lines.test.ts):
// много линий на удержании — плашка прокручивается, окно и страница того же размера;
// перезагрузка страницы — удержанные линии на месте и снимаются; через HOLD_LIMIT_MS
// удержания собеседник кладёт трубку сам — вкладка «не дождался», на сервере звонок окончен.
// Три минуты не ждём: часы страницы — page.clock, перемотка вперёд.

test.skip(process.env.E2E_DATABASE !== "1", "Нужен стенд с БД");

// Снимки для ручной проверки: E2E_SHOTS_DIR, иначе рядом с результатами прогона.
const SHOTS = process.env.E2E_SHOTS_DIR ?? "qa/results/shots";

/** Абоненты ДДС 102 по умолчанию (401…404) и дежурные служб — все отвечают. */
const NUMBERS = ["401", "402", "403", "404", "101", "103"];

async function frame(win: Locator) {
  const box = await win.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

/** Набрать номер вручную и дождаться разговора. */
async function typed(win: Locator, number: string) {
  await (await openDial(win)).fill(number);
  await win.getByRole("button", { name: "Позвонить", exact: true }).click();
  await expectTalking(win);
}

/** Удержать идущий разговор: он уходит во вкладку «на удержании», окно — к контактам. */
async function hold(win: Locator) {
  const hold = win.getByRole("button", { name: "Удержать", exact: true });
  // Удержать можно разговор, а не приветствие: кнопка доступна, когда собеседник ответил.
  await expect(hold).toBeEnabled({ timeout: 20_000 });
  await hold.click();
}

/** Время удержания по вкладкам: собеседник → секунды («на удержании м:сс»). */
async function heldSeconds(win: Locator): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const tab of await lineTab(win, "held").all()) {
    const who = (await tab.locator("b").innerText()).trim();
    const match = /на удержании (\d+):(\d\d)/.exec(await tab.innerText());
    expect(match, who).not.toBeNull();
    result[who] = Number(match![1]) * 60 + Number(match![2]);
  }
  return result;
}

/** Звонки карточки на сервере: id → состояние. */
async function serverCalls(page: Page, cardId: string) {
  const events: { type: string; payload: { call_id?: string } }[] = await (
    await page.request.get(`/api/cards/${cardId}/events`)
  ).json();
  const ids = [
    ...new Set(
      events
        .filter((item) => item.type.startsWith("call_dial"))
        .map((item) => item.payload.call_id!),
    ),
  ];
  const states: Record<string, string> = {};
  for (const id of ids)
    states[id] = (
      await (await page.request.get(`/api/calls/${id}`)).json()
    ).state;
  return states;
}

test("Много линий на удержании: прокрутка вкладок, перезагрузка, отбой через 3 мин", async ({
  page,
  lesson,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Только Chromium");
  test.setTimeout(240_000);
  page.setDefaultTimeout(15_000);
  // Часы страницы идут сами, но их можно перемотать: три минуты удержания — мгновенно.
  await page.clock.install();
  await login(page, "trainee05");
  await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
  const win = await openPhone(page);
  const box = await frame(win);

  // 1. Шесть разговоров подряд, каждый — на удержание: шесть вкладок «на удержании».
  for (const [index, number] of NUMBERS.entries()) {
    await typed(win, number);
    await hold(win);
    await backToContacts(win);
    await expect(lineTab(win, "held")).toHaveCount(index + 1);
  }
  await expect(lineTab(win, "active")).toHaveCount(0);
  for (const tab of await lineTab(win, "held").all())
    await expect(tab).toContainText(/на удержании \d:\d\d/);

  // Вкладки не помещаются — плашка прокручивается сама, окно и страница того же размера.
  const strip = win.getByRole("tablist", { name: "Линии телефона" });
  const overflow = await strip.evaluate((element) => ({
    scroll: element.scrollWidth,
    client: element.clientWidth,
    overflowX: getComputedStyle(element).overflowX,
  }));
  expect(overflow.scroll).toBeGreaterThan(overflow.client);
  expect(overflow.overflowX).toBe("auto");
  expect(await frame(win)).toEqual(box);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  // Кнопка «Удержать» не уезжает вместе с вкладками.
  await expect(
    win.getByRole("button", { name: "Удержать", exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: `${SHOTS}/hq034-many-tabs.png` });
  // Последняя вкладка достижима: стрелками с первой, фокус прокручивает плашку.
  const tabs = lineTab(win, "held");
  await tabs.first().focus();
  for (let step = 1; step < NUMBERS.length; step++)
    await page.keyboard.press("ArrowRight");
  await expect(tabs.last()).toBeFocused();
  await expect(tabs.last()).toBeInViewport({ ratio: 0.9 });
  expect(await strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(
    0,
  );
  await page.screenshot({ path: `${SHOTS}/hq034-many-tabs-scrolled.png` });

  // 2. Перезагрузка страницы: удержанные линии на месте, время удержания идёт дальше —
  // не с нуля: у каждой линии не меньше, чем до перезагрузки, и растёт.
  await page.clock.fastForward(40_000);
  const before = await heldSeconds(win);
  expect(Math.min(...Object.values(before))).toBeGreaterThanOrEqual(40);
  await page.reload();
  const again = await openPhone(page);
  await expect(lineTab(again, "held")).toHaveCount(NUMBERS.length);
  const reloaded = await heldSeconds(again);
  expect(Object.keys(reloaded).sort()).toEqual(Object.keys(before).sort());
  for (const [who, seconds] of Object.entries(before))
    expect(reloaded[who]).toBeGreaterThanOrEqual(seconds);
  await page.clock.fastForward(10_000);
  const later = await heldSeconds(again);
  for (const [who, seconds] of Object.entries(reloaded))
    expect(later[who]).toBeGreaterThanOrEqual(seconds + 10);
  await page.screenshot({ path: `${SHOTS}/hq034-reload-held.png` });
  // Снять последнюю: разговор снова идёт, остальные ждут.
  const last = lineTab(again, "held").last();
  const who = (await last.locator("b").innerText()).trim();
  await last.click();
  await expectTalking(again);
  await expect(callHead(again)).toContainText(who);
  await expect(
    again.getByText(`Снят с удержания: ${who}`, { exact: true }),
  ).toBeVisible();
  await expect(lineTab(again, "held")).toHaveCount(NUMBERS.length - 1);
  // Снова на удержание — к остальным.
  await hold(again);
  await backToContacts(again);
  await expect(lineTab(again, "held")).toHaveCount(NUMBERS.length);

  // На сервере удержанные звонки идут: отбоя не было.
  const states = await serverCalls(page, lesson.card.id);
  expect(
    Object.values(states).filter((state) => state === "talking"),
  ).toHaveLength(NUMBERS.length);

  // 3. Три минуты на удержании: собеседники кладут трубку сами — вкладки «не дождался»,
  // на сервере звонки окончены.
  await page.clock.fastForward(HOLD_LIMIT_MS);
  await expect(lineTab(again, "held")).toHaveCount(0);
  await expect(lineTab(again, "dropped")).toHaveCount(NUMBERS.length);
  for (const tab of await lineTab(again, "dropped").all())
    await expect(tab).toContainText("не дождался, положил трубку");
  expect(await frame(again)).toEqual(box);
  await page.screenshot({ path: `${SHOTS}/hq034-dropped.png` });
  await expect
    .poll(async () => Object.values(await serverCalls(page, lesson.card.id)))
    .toEqual(Array(NUMBERS.length).fill("ended"));
  // После перезагрузки отбитые линии не воскресают.
  // Вкладки «не дождался» гаснут сами.
  await page.clock.fastForward(DROPPED_SHOWN_MS + 1_000);
  await expect(lineTab(again, "dropped")).toHaveCount(0);
  await page.reload();
  const after = await openPhone(page);
  await expect(after).toBeVisible();
  await expect(lineTab(after, "held")).toHaveCount(0);
});

// ---------------------------------------------------------------------------------------------
// Отдел контроля и тревога — живые занятия по сценарию «Задымление в квартире», 101
// (smoke-apartment-101-1, 70005101): отдел контроля звонит через 60 с без статуса, тревога
// бригады — вводной преподавателя, когда расчёт на месте.

const SMOKE = "70005101";
const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-local";

async function csrfOf(request: APIRequestContext) {
  return {
    "X-CSRF-Token": (await request.storageState()).cookies.find(
      (cookie) => cookie.name === "csrf",
    )!.value,
  };
}

/** Занятие преподавателя на одну карточку «Задымления» для `trainee` (101). */
async function smokeLesson(request: APIRequestContext, trainee: string) {
  expect(
    (
      await request.post("/api/auth/login", {
        data: { login: "teacher", password: PASSWORD },
      })
    ).ok(),
  ).toBeTruthy();
  const headers = await csrfOf(request);
  const scenarios: Scenario[] = await (
    await request.get("/api/scenarios")
  ).json();
  const scenario = scenarios
    .filter((item) => item.card.number === SMOKE && item.status === "approved")
    .sort((a, b) => b.version - a.version)[0];
  expect(scenario, `Нет сценария ${SMOKE}`).toBeTruthy();
  const users: User[] = await (await request.get("/api/users")).json();
  const user = users.find((item) => item.login === trainee)!;
  const settings = await (await request.get("/api/settings")).json();
  const created = await request.post("/api/sessions", {
    headers,
    data: {
      title: `Линии телефона ${Date.now()}`,
      participants: [
        {
          user_id: user.id,
          workstation_number: trainee === "trainee02" ? 19 : 18,
          dds_service_id: "101",
          level: 1,
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
        participant_id: user.id,
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
    session,
    headers,
    finish: async () => {
      await request.post(`/api/sessions/${session.id}/finish`, { headers });
    },
  };
}

async function cardOf(page: Page, sessionId: string): Promise<Card> {
  let card: Card | undefined;
  await expect
    .poll(
      async () => {
        const cards: Card[] = await (
          await page.request.get("/api/cards")
        ).json();
        card = cards.find((item) => item.session_id === sessionId);
        return card?.id ?? null;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();
  return card!;
}

async function training(page: Page, cardId: string): Promise<CardTraining> {
  return (await page.request.get(`/api/cards/${cardId}/training`)).json();
}

async function send(
  page: Page,
  cardId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  const response = await page.request.post(`/api/cards/${cardId}/events`, {
    headers: await csrfOf(page.request),
    data: {
      client_event_id: randomUUID(),
      client_ts: new Date().toISOString(),
      type,
      payload,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

type Message = CardTraining["messages"][number];

/** Дождаться реплики бригады и предъявить её через API (как teacher-injects.spec.ts). */
async function hear(
  page: Page,
  cardId: string,
  match: (message: Message) => boolean = () => true,
): Promise<Message> {
  let found: Message | undefined;
  await expect
    .poll(
      async () => {
        found = (await training(page, cardId)).messages.find(
          (item) => item.state !== "presented" && match(item),
        );
        return Boolean(found);
      },
      { timeout: 45_000 },
    )
    .toBe(true);
  const { delivery } = found!;
  await send(page, cardId, "message_presented", {
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

test("Отдел контроля: удержание и возврат, пояснение после снятия", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Только Chromium");
  test.setTimeout(240_000);
  page.setDefaultTimeout(15_000);
  const lesson = await smokeLesson(request, "trainee02");
  try {
    await login(page, "trainee02");
    const card = await cardOf(page, lesson.session.id);
    await page.locator(`[data-card-id="${card.id}"]`).click();

    // Отдел контроля звонит через 60 с без статуса: вкладка «Отдел контроля», щелчок отвечает.
    const win = await openPhone(page);
    const ring = lineTab(win, "ringing", "Отдел контроля");
    await expect(ring).toContainText(`по карточке ${card.source.number}`, {
      timeout: 100_000,
    });
    await ring.click();
    const talk = page.getByRole("region", {
      name: "Разговор с отделом контроля",
    });
    await expect(talk).toHaveAttribute("data-control-call", "talking");
    await expect(talk).toContainText("Почему карточка так долго без статуса?");
    await expect(lineTab(win, "active", "Отдел контроля")).toBeVisible();

    // «Удержать»: разговор уходит во вкладку; на сервере звонок идёт.
    await hold(win);
    const held = lineTab(win, "held", "Отдел контроля");
    await expect(held).toContainText("на удержании 0:0");
    await expect(talk).toBeHidden();
    await expect(lineTab(win, "active")).toHaveCount(0);

    // Пока отдел контроля ждёт, диспетчер звонит в скорую.
    await typed(win, "103");
    await expect(lineTab(win, "active")).toHaveCount(1);
    await expect(held).toContainText(/на удержании 0:0[1-9]/, {
      timeout: 10_000,
    });
    await page.screenshot({ path: `${SHOTS}/hq034-control-held.png` });
    expect(
      (await training(page, card.id)).control?.ended_at ?? null,
    ).toBeNull();

    // Щелчок по удержанной вкладке: отдел контроля снова на связи, скорая — на удержании.
    await held.click();
    await expect(talk).toBeVisible();
    await expect(talk).toHaveAttribute("data-control-call", "talking");
    await expect(lineTab(win, "held")).toHaveCount(1);
    await expect(lineTab(win, "held", "Отдел контроля")).toHaveCount(0);
    await expect(lineTab(win, "active", "Отдел контроля")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/hq034-control-resumed.png` });

    // Пояснение после снятия доходит до сервера, отдел контроля кладёт трубку сам.
    await talk.getByRole("button", { name: "По частям" }).click();
    await talk
      .getByRole("group", { name: "Варианты пояснения" })
      .getByRole("button", {
        name: "Не успел обработать, статус ставлю сейчас",
      })
      .click();
    await expect(talk).toContainText("Принято. Отбой.");
    await expect(talk).toBeHidden({ timeout: 10_000 });
    await expect
      .poll(
        async () =>
          (await training(page, card.id)).control?.reply?.option_key ?? null,
      )
      .toBe("late");
    // Скорая по-прежнему ждёт на удержании.
    await expect(lineTab(win, "held")).toHaveCount(1);
  } finally {
    await lesson.finish();
  }
});

test("Тревога бригады: вкладка «тревога», ответ ставит разговор на удержание", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Только Chromium");
  test.setTimeout(240_000);
  page.setDefaultTimeout(15_000);
  const lesson = await smokeLesson(request, "trainee03");
  try {
    await login(page, "trainee03");
    const card = await cardOf(page, lesson.session.id);
    // Ход до «Прибытия» — через API (как teacher-injects.spec.ts): тревогу подают только
    // расчёту на месте. Карточка в браузере ещё не открыта — её софтфон не мешает.
    const id = card.id;
    await send(page, id, "deliver", {});
    await send(page, id, "status_change", {
      state: "accepted",
      comment: "Принята",
    });
    const brigadeId = (await training(page, id)).available_brigade_ids[0]!;
    const targets: CallTarget[] = await (
      await page.request.get("/api/services/101/call-targets")
    ).json();
    const target = targets.find((item) => item.brigade_id === brigadeId)!;
    await send(page, id, "brigades_select", { brigade_ids: [brigadeId] });
    const callId = randomUUID();
    await send(page, id, "call_dial_target", {
      call_id: callId,
      call_target_id: target.id,
      brigade_id: brigadeId,
    });
    await send(page, id, "call_answer", { call_id: callId });
    await send(page, id, "brigade_briefing", {
      call_id: callId,
      mode: "parts",
      text: briefingText(card.source),
    });
    // Повтор адреса с ошибкой говорит сам доклад о выезде (проверка 17.10, carried_events).
    const readback = await hear(
      page,
      id,
      (item) => "reply_options" in item.delivery,
    );
    await send(page, id, "status_change", {
      state: "responding",
      comment: "Расчёт выехал",
    });
    await page.waitForTimeout(1_200);
    await send(page, id, "brigade_reply", {
      call_id: callId,
      delivery_id: readback.delivery.delivery_id,
      option_key: "fix",
    });
    await hear(page, id, (item) =>
      item.delivery.message.text.startsWith("Принял поправку"),
    );
    await hear(page, id, (item) => !("reply_options" in item.delivery));
    await send(page, id, "status_change", {
      state: "arrived",
      comment: "Расчёт на месте",
    });
    const floor = await hear(
      page,
      id,
      (item) => "reply_options" in item.delivery,
    );
    await page.waitForTimeout(1_200);
    await send(page, id, "brigade_reply", {
      call_id: callId,
      delivery_id: floor.delivery.delivery_id,
      option_key: "floor_9",
    });
    await hear(page, id, (item) =>
      item.delivery.message.text.startsWith("Понял, поднимаемся"),
    );
    await hear(page, id, (item) =>
      item.delivery.message.text.startsWith("Нашли очаг"),
    );
    await hear(page, id, (item) =>
      item.delivery.message.text.includes("срочно скорую"),
    );
    await send(page, id, "call_hangup", { call_id: callId });
    const hungUpAt = Date.now();

    // Диспетчер в браузере разговаривает со скорой — тут бригада звонит тревогой.
    await page.locator(`[data-card-id="${id}"]`).click();
    const win = await openPhone(page);
    await typed(win, "103");
    await page.waitForTimeout(Math.max(0, hungUpAt + 11_000 - Date.now()));
    const fired = await request.post(
      `/api/sessions/${lesson.session.id}/injects`,
      {
        headers: lesson.headers,
        data: { kind: "alarm", targets: "all" },
      },
    );
    expect(fired.ok(), await fired.text()).toBeTruthy();
    expect((await fired.json()).results[0].status).toBe("fired");

    // Вкладка тревоги: «тревога м:сс», data-alarm; горит ровно, а не мигает, как вызов.
    const alarm = lineTab(
      win,
      "ringing",
      `Старший бригады · ${target.phone_ext}`,
    );
    await expect(alarm).toContainText(/тревога 0:\d\d/, { timeout: 30_000 });
    await expect(alarm).toHaveAttribute("data-alarm", "true");
    await expect(alarm).toContainText(`по карточке ${card.source.number}`);
    await expect(alarm).toHaveCSS("animation-name", "none");
    await expect(alarm).toHaveCSS("color", "rgb(255, 255, 255)");
    // Фон — токен --op-orange макета (docs/dds_training_review/phone: #ec653b).
    await expect(alarm).toHaveCSS("background-color", "rgb(236, 101, 59)");
    await page.screenshot({ path: `${SHOTS}/hq034-alarm-tab.png` });

    // Щелчок отвечает: скорая — на удержании, бригада докладывает тревогу.
    await alarm.click();
    await expectTalking(win);
    await expect(callHead(win)).toContainText("Разговор:");
    await expect(lineTab(win, "held")).toHaveCount(1);
    await expect(lineTab(win, "ringing")).toHaveCount(0);
    await expect(win.getByText(/^Тревога! Тревога!/).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.screenshot({ path: `${SHOTS}/hq034-alarm-answered.png` });
  } finally {
    await lesson.finish();
  }
});
