import { randomUUID } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { briefingText } from "./brigade-briefing";
import { answer, expectTalking, lineTab, openPhone } from "./phone";

type Card = components["schemas"]["Card"];
type Session = components["schemas"]["Session"];
type Scenario = components["schemas"]["Scenario"];
type CallTarget = components["schemas"]["CallTarget"];
type CardEvent = { type: string; payload: Record<string, unknown> };

// TC-01: входящий доклад бригады как настоящий. Бригада перезванивает с непрослушанным
// докладом о выезде: строка входящего «Старший бригады · 201», фокус на «Ответить» (Enter
// отвечает); старший называет себя, докладывает и спрашивает «Как приняли?»; диспетчер
// молчит — бригада ждёт молча (проверка 17.10); «Принял» — подтверждение
// приёма в журнале карточки (report_confirmed). Сценарий — gas-apartment-101-1 (70005401).

const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-local";
const NUMBER = "70005401";

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

test("Входящий доклад: представление, «Как приняли?», переспрос в тишине и «Принял»", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker, app.seed.training и явное E2E_DATABASE=1",
  );
  // Один обучаемый ДДС 101 на оба браузера — занятия не должны пересекаться.
  test.skip(testInfo.project.name !== "chromium", "Только Chromium");
  test.setTimeout(150_000);
  page.setDefaultTimeout(15_000);
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
  const scenario = scenarios
    .filter((item) => item.status === "approved" && item.card.number === NUMBER)
    .sort((a, b) => b.version - a.version)[0];
  test.skip(!scenario, "Нет сценария gas-apartment-101-1: выполните app.seed");
  const created = await request.post("/api/sessions", {
    headers,
    data: {
      title: `Входящий доклад ${Date.now()}`,
      participants: [
        {
          user_id: trainee.id,
          workstation_number: 22,
          dds_service_id: "101",
          level: 1,
        },
      ],
      settings_snapshot: await (await request.get("/api/settings")).json(),
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const session: Session = await created.json();
  try {
    const assigned = await request.post(
      `/api/sessions/${session.id}/assignments`,
      {
        headers,
        data: {
          participant_id: trainee.id,
          scenario_id: scenario.id,
          order: 1,
          planned_at: new Date().toISOString(),
        },
      },
    );
    expect(assigned.status(), await assigned.text()).toBe(201);
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

    // Карточка — во вкладках; открытая карточка слушает вызовы своих бригад.
    const tab = page
      .getByRole("navigation", { name: "Происшествия в работе" })
      .getByRole("button", { name: new RegExp(`Происшествие ${NUMBER}`) });
    await expect(tab).toBeVisible({ timeout: 30_000 });
    await tab.click();
    let card: Card | undefined;
    await expect
      .poll(async () => {
        const cards: Card[] = await (
          await page.request.get("/api/cards")
        ).json();
        card = cards.find((item) => item.session_id === session.id);
        return card?.opened_at ?? null;
      })
      .not.toBeNull();

    // «Принята», вводная бригаде и сразу отбой — доклад о выезде не услышан, бригада
    // перезванивает сама (DT-20).
    await event(page, card!.id, "status_change", {
      state: "accepted",
      comment: "Принята",
    });
    const targets: CallTarget[] = await (
      await page.request.get("/api/services/101/call-targets")
    ).json();
    const training = await (
      await page.request.get(`/api/cards/${card!.id}/training`)
    ).json();
    const target = targets.find(
      (item) => item.brigade_id === training.available_brigade_ids[0],
    )!;
    const dispatch = randomUUID();
    await event(page, card!.id, "call_dial_target", {
      call_id: dispatch,
      call_target_id: target.id,
      brigade_id: target.brigade_id,
    });
    await event(page, card!.id, "call_answer", { call_id: dispatch });
    await event(page, card!.id, "brigade_briefing", {
      call_id: dispatch,
      mode: "parts",
      text: briefingText(card!.source),
    });
    await event(page, card!.id, "call_hangup", { call_id: dispatch });

    // Вкладка входящего — «Старший бригады · <номер>» (вкладки линий 17.10), фокус на ней,
    // Enter отвечает.
    await expect(
      page.getByRole("button", { name: "Телефон: входящих 1", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    const win = await openPhone(page);
    const pick = lineTab(win, "ringing");
    await expect(pick).toContainText(`Старший бригады · ${target.phone_ext}`);
    await expect(pick).toBeFocused();
    await page.keyboard.press("Enter");
    await expectTalking(win);

    // Старший называет себя, докладывает и спрашивает «Как приняли?».
    await expect(win.getByText("Старший расчёта, на связи.")).toBeVisible();
    const asks = win.getByText("Как приняли?", { exact: true });
    await expect(asks).toHaveCount(1, { timeout: 20_000 });

    // Тишина — бригада ждёт молча: «Диспетчер, слышите меня?» не звучит (проверка 17.10).
    await page.waitForTimeout(9_000);
    await expect(
      win.getByText("Диспетчер, слышите меня?", { exact: true }),
    ).toHaveCount(0);

    // «Принял» — подтверждение приёма доклада в журнале карточки.
    await answer(win)
      .getByRole("button", { name: "Принял", exact: true })
      .click();
    await expect
      .poll(
        async () => {
          const events: CardEvent[] = await (
            await page.request.get(`/api/cards/${card!.id}/events`)
          ).json();
          return events
            .filter((item) => item.type === "report_confirmed")
            .map((item) => item.payload.text);
        },
        { timeout: 15_000 },
      )
      .toEqual(["Принял."]);
  } finally {
    await request.post(`/api/sessions/${session.id}/finish`, { headers });
  }
});
