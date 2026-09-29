import { randomUUID } from "node:crypto";
import { expect, test as base } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";

type Card = components["schemas"]["Card"];

// Отдельный APIRequestContext сохраняет учительскую сессию для finally;
// вход ученика в page не меняет её cookie. История не удаляется.
export const test = base.extend<{ databaseCard: Card | undefined }>({
  databaseCard: async ({ request }, use) => {
    if (process.env.E2E_DATABASE !== "1") {
      await use(undefined);
      return;
    }
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
        (c) => c.name === "csrf",
      )!.value,
    };
    const users: components["schemas"]["User"][] = await (
      await request.get("/api/users")
    ).json();
    const trainee = users.find((user) => user.login === "trainee01")!;
    const scenarios: components["schemas"]["Scenario"][] = await (
      await request.get("/api/scenarios")
    ).json();
    const source = scenarios.find((s) => s.status === "approved")!;
    const scenario = {
      ...source,
      id: randomUUID(),
      card: { ...source.card, incident_class: `Транспорт ${randomUUID()}` },
    };
    expect(
      (
        await request.post("/api/scenarios", { headers, data: scenario })
      ).status(),
    ).toBe(201);
    const created = await request.post("/api/sessions", {
      headers,
      data: {
        title: scenario.card.incident_class,
        participants: [
          {
            user_id: trainee.id,
            workstation_number: 20,
            dds_service_id: "102",
            level: 1,
          },
        ],
        settings_snapshot: await (await request.get("/api/settings")).json(),
      },
    });
    expect(created.status()).toBe(201);
    const lesson: components["schemas"]["Session"] = await created.json();
    try {
      expect(
        (
          await request.post(`/api/sessions/${lesson.id}/assignments`, {
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
          await request.post(`/api/sessions/${lesson.id}/start`, { headers })
        ).ok(),
      ).toBeTruthy();
      let card: Card | undefined;
      await expect
        .poll(
          async () => {
            const cards: Card[] = await (
              await request.get("/api/cards")
            ).json();
            card = cards.find((item) => item.session_id === lesson.id);
            return Boolean(card);
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      await use(card);
    } finally {
      const finished = await request.post(`/api/sessions/${lesson.id}/finish`, {
        headers,
      });
      expect([200, 409]).toContain(finished.status());
      expect(
        (
          await request.post(`/api/scenarios/${scenario.id}/retire`, {
            headers,
          })
        ).ok(),
      ).toBeTruthy();
    }
  },
});
