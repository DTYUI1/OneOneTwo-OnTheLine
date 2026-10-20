import { expect, type APIRequestContext, type Page } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";

// Занятие для сверки рабочего поля с памяткой ДДС (GP-16): dds-memo.spec.ts и
// dds-memo-shots.spec.ts.

type Card = components["schemas"]["Card"];
type Scenario = components["schemas"]["Scenario"];
type Session = components["schemas"]["Session"];
type User = components["schemas"]["User"];

/**
 * Занятие обучаемого `login` (по умолчанию trainee05) за службу `serviceId` со сценарием
 * из каталога этой службы; `hints` — уровень подсказок занятия (по умолчанию 1).
 */
export async function lesson(
  request: APIRequestContext,
  serviceId: string,
  login = "trainee05",
  hints = 1,
) {
  expect(
    (
      await request.post("/api/auth/login", {
        data: {
          login: "teacher",
          password: process.env.DEMO_PASSWORD ?? "demo-local",
        },
      })
    ).ok(),
  ).toBeTruthy();
  const headers = {
    "X-CSRF-Token": (await request.storageState()).cookies.find(
      (cookie) => cookie.name === "csrf",
    )!.value,
  };
  const scenarios: Scenario[] = await (
    await request.get("/api/scenarios")
  ).json();
  const scenario = scenarios.find(
    (item) =>
      item.target_service_id === serviceId &&
      item.status === "approved" &&
      item.card.service_ids.includes(serviceId),
  );
  expect(scenario, `Нет сценария службы ${serviceId}`).toBeTruthy();
  const users: User[] = await (await request.get("/api/users")).json();
  const trainee = users.find((user) => user.login === login)!;
  const settings = await (await request.get("/api/settings")).json();
  const created = await request.post("/api/sessions", {
    headers,
    data: {
      title: `Сверка с памяткой ${serviceId} ${Date.now()}`,
      participants: [
        {
          user_id: trainee.id,
          workstation_number: 23,
          dds_service_id: serviceId,
          level: 4,
        },
      ],
      settings_snapshot: { ...settings, hints_level: hints, parallel_cards: 1 },
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const session: Session = await created.json();
  const assigned = await request.post(
    `/api/sessions/${session.id}/assignments`,
    {
      headers,
      data: {
        participant_id: trainee.id,
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
    id: session.id,
    finish: async () => {
      await request.post(`/api/sessions/${session.id}/finish`, { headers });
    },
  };
}

export async function waitCard(page: Page, sessionId: string): Promise<Card> {
  let card: Card | undefined;
  await expect
    .poll(async () => {
      const cards: Card[] = await (await page.request.get("/api/cards")).json();
      card = cards.find((item) => item.session_id === sessionId);
      return card?.id ?? "";
    })
    .not.toBe("");
  await expect(page.locator(`[data-card-id="${card!.id}"]`)).toBeVisible();
  return card!;
}
