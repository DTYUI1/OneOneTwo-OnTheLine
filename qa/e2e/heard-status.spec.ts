import { randomUUID } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { briefingText } from "./brigade-briefing";
import {
  answer,
  answerRing,
  closePhone,
  expectTalking,
  openPhone,
} from "./phone";

type Card = components["schemas"]["Card"];
type Session = components["schemas"]["Session"];
type Scenario = components["schemas"]["Scenario"];
type CallTarget = components["schemas"]["CallTarget"];
type CardEvent = { type: string; payload: Record<string, unknown> };

// TC-05: «Услышано по телефону» — подсказка обучения (решение 17.10): во «Вместе» она стоит
// у строки статуса (tutor-pointer.spec.ts), на тестах её нет. Здесь — тест: занятие
// преподавателя. Старший бригады докладывает «Вызов принят, отделение выехало» — строки
// нет, статус карточки прежний, в строке статуса пусто. Сценарий — gas-apartment-101-1
// (70005401), как в brigade-incoming.

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

async function statusChanges(page: Page, cardId: string) {
  const events: CardEvent[] = await (
    await page.request.get(`/api/cards/${cardId}/events`)
  ).json();
  return events
    .filter((item) => item.type === "status_change")
    .map((item) => item.payload.state);
}

test("«Услышано по телефону»: на занятии строки нет, статус не меняется", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker, app.seed.training и явное E2E_DATABASE=1",
  );
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
      title: `Услышано по телефону ${Date.now()}`,
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

    // «Принята», вводная бригаде и отбой — с докладом о выезде бригада перезванивает сама.
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

    // Занятие преподавателя — тест (решение 17.10): строки «Услышано по телефону» нет ни
    // до доклада, ни после; подсказок тренажёра на экране нет вовсе.
    const heard = page.getByRole("group", { name: "Услышано по телефону" });
    const coach = page.getByRole("region", { name: "Подсказка тренажёра" });
    await expect(heard).toHaveCount(0);

    // Входящий: старший докладывает о выезде и спрашивает «Как приняли?».
    await expect(
      page.getByRole("button", { name: "Телефон: входящих 1", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    const win = await openPhone(page);
    await answerRing(win);
    await expectTalking(win);
    // Доклад звучит записью; «Как приняли?» — после предъявления доклада.
    await expect(win.getByText("Как приняли?", { exact: true })).toHaveCount(
      1,
      { timeout: 20_000 },
    );
    await answer(win)
      .getByRole("button", { name: "Принял", exact: true })
      .click();
    await closePhone(page);

    // Доклад прозвучал — строки нет; статус не поставлен, в строке статуса пусто.
    await page.waitForTimeout(3_000);
    await expect(heard).toHaveCount(0);
    await expect(coach).toHaveCount(0);
    const select = page.getByRole("combobox", { name: "Статус", exact: true });
    await expect(select).toHaveValue("");
    expect(await statusChanges(page, card!.id)).toEqual(["accepted"]);
    const current: Card = await (
      await page.request.get(`/api/cards/${card!.id}`)
    ).json();
    expect(current.state).toBe("accepted");
  } finally {
    await request.post(`/api/sessions/${session.id}/finish`, { headers });
  }
});
