import { randomUUID } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { briefingText } from "./brigade-briefing";
import { callHead, expectTalking, lineTab, openPhone } from "./phone";

type Card = components["schemas"]["Card"];
type Session = components["schemas"]["Session"];
type Scenario = components["schemas"]["Scenario"];
type CallTarget = components["schemas"]["CallTarget"];
type CardTraining = components["schemas"]["CardTraining"];

// TC-02 и вкладки линий (проверка 17.10): пропущенный доклад и удержание линий. Бригада
// перезванивает с неуслышанным докладом о выезде; диспетчер не отвечает 25 с — «пропущенный
// вызов» с «Перезвонить»; перезвон отдаёт тот же доклад. Во время этого разговора звонит
// бригада второго происшествия — мигающая вкладка; щелчок по ней отвечает, а первый разговор
// встаёт на удержание («на удержании м:сс»). Щелчок по удержанной вкладке возвращает первого
// старшего («на связи», лента разговора на месте), второй теперь ждёт на удержании. Окно
// телефона всё это время одного размера. Автоотбой после 3 мин удержания — vitest
// (apps/web/src/arm/phone/hold.test.ts), вкладки — phone/lines.test.ts.
// Сценарии 101: gas-apartment-101-1 (70005401) и lift-stuck-101-1 (70005201).

const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-local";
const FIRST = "70005401";
const SECOND = "70005201";

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

async function training(page: Page, cardId: string): Promise<CardTraining> {
  return (await page.request.get(`/api/cards/${cardId}/training`)).json();
}

/**
 * «Принята», вводная свободной бригаде и сразу отбой: доклад о выезде выдан, но не услышан —
 * бригада перезванивает сама. Возвращает её адресата и текст доклада.
 */
async function briefAndHangUp(page: Page, card: Card) {
  await event(page, card.id, "status_change", {
    state: "accepted",
    comment: "Принята",
  });
  const targets: CallTarget[] = await (
    await page.request.get("/api/services/101/call-targets")
  ).json();
  const before = await training(page, card.id);
  const busy = new Set(
    (before.busy_brigades ?? []).map((item) => item.brigade_id),
  );
  const brigadeId = (before.available_brigade_ids ?? []).find(
    (id) => !busy.has(id),
  )!;
  const target = targets.find((item) => item.brigade_id === brigadeId)!;
  const dispatch = randomUUID();
  await event(page, card.id, "call_dial_target", {
    call_id: dispatch,
    call_target_id: target.id,
    brigade_id: target.brigade_id,
  });
  await event(page, card.id, "call_answer", { call_id: dispatch });
  await event(page, card.id, "brigade_briefing", {
    call_id: dispatch,
    mode: "parts",
    text: briefingText(card.source),
  });
  await event(page, card.id, "call_hangup", { call_id: dispatch });
  let report = "";
  await expect
    .poll(async () => {
      report =
        (await training(page, card.id)).messages[0]?.delivery.message.text ??
        "";
      return report;
    })
    .not.toBe("");
  return { target, report };
}

async function box(win: Locator) {
  const rect = await win.boundingBox();
  expect(rect).not.toBeNull();
  return rect!;
}

test("Пропущенный доклад, перезвон и удержание линии", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker, app.seed.training и явное E2E_DATABASE=1",
  );
  test.skip(testInfo.project.name !== "chromium", "Только Chromium");
  test.setTimeout(240_000);
  page.setDefaultTimeout(15_000);
  // Две карточки — АРМ один раз предупреждает о параллельной работе; проверка не о нём.
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: "Параллельная работа" }),
    async (dialog) => {
      await dialog.getByRole("button", { name: "Понятно" }).click();
    },
  );
  const login = "trainee02";

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
  const latest = (number: string) =>
    scenarios
      .filter(
        (item) => item.status === "approved" && item.card.number === number,
      )
      .sort((a, b) => b.version - a.version)[0];
  const first = latest(FIRST);
  const second = latest(SECOND);
  test.skip(!first || !second, "Нет сценариев 101: выполните app.seed");
  const settings = await (await request.get("/api/settings")).json();
  const created = await request.post("/api/sessions", {
    headers,
    data: {
      title: `Пропущенный и удержание ${Date.now()}`,
      participants: [
        {
          user_id: trainee.id,
          workstation_number: 22,
          dds_service_id: "101",
          // Две карточки сразу: параллельных — не больше уровня обучаемого.
          level: 2,
        },
      ],
      settings_snapshot: { ...settings, parallel_cards: 2 },
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const session: Session = await created.json();
  try {
    for (const [order, scenario] of [first, second].entries()) {
      const assigned = await request.post(
        `/api/sessions/${session.id}/assignments`,
        {
          headers,
          data: {
            participant_id: trainee.id,
            scenario_id: scenario.id,
            order: order + 1,
            planned_at: new Date().toISOString(),
          },
        },
      );
      expect(assigned.status(), await assigned.text()).toBe(201);
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
    await page
      .getByRole("button", { name: /^(Диспетчер служб|Перейти в тренажёр)$/ })
      .click();

    // Обе карточки — во вкладках; открываем каждую, чтобы окно слушало вызовы их бригад.
    const tabs = page.getByRole("navigation", {
      name: "Происшествия в работе",
    });
    const cards: Record<string, Card> = {};
    for (const number of [SECOND, FIRST]) {
      const tab = tabs.getByRole("button", {
        name: new RegExp(`Происшествие ${number}`),
      });
      await expect(tab).toBeVisible({ timeout: 30_000 });
      await tab.click();
      await expect
        .poll(async () => {
          const list: Card[] = await (
            await page.request.get("/api/cards")
          ).json();
          const card = list.find(
            (item) =>
              item.session_id === session.id && item.source.number === number,
          );
          if (card) cards[number] = card;
          return card?.opened_at ?? null;
        })
        .not.toBeNull();
    }

    // Окно телефона открыто заранее: его размер не меняется ни от вызова, ни от строк линий.
    const win = await openPhone(page);
    const size = await box(win);
    const sameSize = async () => expect(await box(win)).toEqual(size);

    // 1. Бригада звонит с докладом о выезде, ответа нет 25 с — «пропущенный вызов».
    const a = await briefAndHangUp(page, cards[FIRST]!);
    const ring = lineTab(win, "ringing");
    await expect(ring).toContainText(
      `Старший бригады · ${a.target.phone_ext}`,
      {
        timeout: 30_000,
      },
    );
    await sameSize();
    const missed = win.getByRole("group", { name: "Пропущенный вызов" });
    await expect(missed).toContainText(
      `Старший бригады · ${a.target.phone_ext}`,
      { timeout: 45_000 },
    );
    await expect(missed).toContainText("пропущенный вызов");
    await expect(ring).toHaveCount(0);
    await sameSize();
    const history = (await training(page, cards[FIRST]!.id)).callbacks ?? [];
    expect(history.map((call) => call.end_reason)).toEqual(["missed"]);

    // 2. «Перезвонить» — тот же доклад в разговоре, пропущенный закрыт. Пока старший
    // докладывает, бригада второго происшествия уже звонит (3): после доклада старший
    // ждёт 6 с и кладёт трубку сам, второй вызов должен прийти раньше.
    await missed.getByRole("button", { name: "Перезвонить" }).click();
    await expectTalking(win);
    const b = await briefAndHangUp(page, cards[SECOND]!);
    await expect(win.getByText(a.report, { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    // Пропущенный закрыт, когда доклад предъявлен — по концу его звука, а не по тексту в ленте.
    await expect(missed).toHaveCount(0, { timeout: 20_000 });

    // 3. Во время разговора звонит бригада второго происшествия: щелчок по её вкладке
    // отвечает, первый разговор — на удержании.
    await expect(ring).toContainText(`Старший бригады · ${b.target.phone_ext}`);
    await ring.click();
    const held = lineTab(
      win,
      "held",
      `Старший бригады · ${a.target.phone_ext}`,
    );
    await expect(held).toContainText("на удержании 0:0");
    await expectTalking(win);
    await expect(callHead(win)).toContainText("Разговор:");
    await expect(page).toHaveURL(new RegExp(cards[SECOND]!.id));
    await expect(held).toContainText(/на удержании 0:0[2-9]/, {
      timeout: 10_000,
    });
    await sameSize();
    // Удержанный разговор (перезвон) на сервере идёт: отбоя не было.
    const dialed: { type: string; payload: { call_id?: string } }[] = await (
      await page.request.get(`/api/cards/${cards[FIRST]!.id}/events`)
    ).json();
    const callback = dialed
      .filter((item) => item.type === "call_dial_target")
      .at(-1)!.payload.call_id;
    const line = await (
      await page.request.get(`/api/calls/${callback}`)
    ).json();
    expect(line.state).toBe("talking");

    // 4. Щелчок по удержанной вкладке: старший первого снова на связи, второй разговор
    // встаёт на удержание, а не кончается.
    await held.click();
    await expect(held).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(cards[FIRST]!.id));
    await expectTalking(win);
    await expect(
      win.getByText(`Снят с удержания:`, { exact: false }),
    ).toBeVisible();
    // «Расчёт на связи.» может звучать и в начале перезвона — новая реплика последняя.
    await expect(
      win.getByText("Расчёт на связи.", { exact: true }).last(),
    ).toBeVisible();
    // Лента первого разговора на месте: доклад, услышанный до удержания.
    await expect(
      win.getByText(a.report, { exact: true }).first(),
    ).toBeVisible();
    await expect(
      lineTab(win, "held", `Старший бригады · ${b.target.phone_ext}`),
    ).toContainText("на удержании");
    await sameSize();
    // Второй разговор на удержании: его вызов отвечен и на сервере идёт дальше.
    await expect
      .poll(async () =>
        ((await training(page, cards[SECOND]!.id)).callbacks ?? []).map(
          (call) => [call.answered_at !== null, call.ended_at !== null],
        ),
      )
      .toEqual([[true, false]]);
  } finally {
    await request.post(`/api/sessions/${session.id}/finish`, { headers });
  }
});
