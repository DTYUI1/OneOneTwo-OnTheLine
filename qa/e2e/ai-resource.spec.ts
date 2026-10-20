import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { login } from "./captain-fixture";

type Session = components["schemas"]["Session"];

test("локальный ИИ: оба предупреждения, отсрочка и запуск без вкладки", async ({
  page,
  context,
}, info) => {
  test.skip(
    process.env.E2E_DATABASE !== "1" || process.env.E2E_REAL_AI !== "1",
    "Нужны PostgreSQL и реальный локальный ИИ",
  );
  test.setTimeout(600_000);
  page.setDefaultTimeout(20_000);
  await login(page, "teacher");
  const request = page.request;
  const headers = {
    "X-CSRF-Token": (await context.cookies()).find((c) => c.name === "csrf")!
      .value,
  };
  const users: components["schemas"]["User"][] = await (
    await request.get("/api/users")
  ).json();
  const trainee = users.find((u) => u.login === "trainee04")!;
  const scenarios: components["schemas"]["Scenario"][] = await (
    await request.get("/api/scenarios")
  ).json();
  const source = scenarios.find(
    (s) => s.id === "00000000-0000-4000-8000-000000000100",
  )!;
  const settings = await (await request.get("/api/settings")).json();
  const sessions: Session[] = [];
  const evidence: Record<string, unknown> = {
    browser: info.project.name,
    startedAt: new Date().toISOString(),
  };
  async function lesson(title: string) {
    const created = await request.post("/api/sessions", {
      headers,
      data: {
        title: `${title} ${Date.now()}`,
        settings_snapshot: settings,
        participants: [
          {
            user_id: trainee.id,
            workstation_number: 22,
            dds_service_id: source.target_service_id,
            level: 1,
          },
        ],
      },
    });
    expect(created.status()).toBe(201);
    const value: Session = await created.json();
    sessions.push(value);
    expect(
      (
        await request.post(`/api/sessions/${value.id}/assignments`, {
          headers,
          data: {
            participant_id: trainee.id,
            scenario_id: source.id,
            order: 1,
            planned_at: new Date(Date.now() + 3600_000).toISOString(),
          },
        })
      ).status(),
    ).toBe(201);
    return value;
  }
  try {
    const running = await lesson("Занятие перед генерацией");
    const waiting = await lesson("Занятие после генерации");
    evidence.lessonIds = sessions.map((s) => s.id);
    expect(
      (
        await request.post(`/api/sessions/${running.id}/start`, { headers })
      ).ok(),
    ).toBeTruthy();
    await page.reload();
    await page
      .getByRole("button", { name: "+ Новое занятие", exact: true })
      .click();
    await page.getByLabel("ИИ подбирает задания").check();
    await page
      .getByRole("button", { name: "Добавить рабочее место", exact: true })
      .click();
    await page.getByLabel("Обучаемый", { exact: true }).fill(trainee.login);
    let creations = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/api/sessions"))
        creations++;
    });
    await page
      .getByRole("button", { name: "Создать занятие", exact: true })
      .click();
    const autoWarning = page.getByRole("dialog", {
      name: "Общий локальный ИИ занят",
    });
    await expect(autoWarning).toContainText(
      "Генерация может задержать ИИ-проверку",
    );
    await autoWarning
      .getByRole("button", { name: "Отмена", exact: true })
      .click();
    expect(creations).toBe(0);
    await page.getByRole("button", { name: /^Студия сценариев/ }).click();
    await page.getByRole("tab", { name: /^пакеты/ }).click();
    await page
      .getByRole("combobox", { name: "Служба", exact: true })
      .selectOption("GKH");
    await page.getByLabel("Сценариев, 1…100", { exact: true }).fill("1");
    await page.getByLabel("Исходное число", { exact: true }).fill("0");
    let posts = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/packs/generate")) posts++;
    });
    await page
      .getByRole("button", { name: "Сгенерировать", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Общий локальный ИИ занят",
    });
    await expect(dialog).toContainText(
      "Идёт занятие. Генерация может задержать ИИ-проверку работ обучаемых",
    );
    await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
    expect(posts).toBe(0);
    await page
      .getByRole("button", { name: "Сгенерировать", exact: true })
      .click();
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          r.url().endsWith("/packs/generate"),
      ),
      dialog
        .getByRole("button", {
          name: "После занятия (рекомендуется)",
          exact: true,
        })
        .click(),
    ]);
    expect(response.status()).toBe(202);
    const job = await response.json();
    evidence.jobId = job.id;
    const body = response.request().postDataJSON();
    expect(body.generation_policy).toBe("after_lessons");
    expect(
      (
        await (
          await request.post("/api/packs/generate", { headers, data: body })
        ).json()
      ).id,
    ).toBe(job.id);
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: /Ожидает окончания занятия · \d+ из \d+/ }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole("tab", { name: /^пакеты/ }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: /Ожидает окончания занятия · \d+ из \d+/ }),
    ).toBeVisible();
    evidence.waitingProgress = await (
      await request.get(`/api/jobs/${job.id}/progress`)
    ).json();
    expect(
      (
        await request.post(`/api/sessions/${running.id}/finish`, { headers })
      ).ok(),
    ).toBeTruthy();
    await expect
      .poll(
        async () =>
          (await (await request.get(`/api/jobs/${job.id}`)).json()).status,
        { timeout: 20_000 },
      )
      .toBe("running");
    await page.getByRole("button", { name: new RegExp(waiting.title) }).click();
    const start = page.getByRole("button", {
      name: "Начать занятие",
      exact: true,
    });
    await start.click();
    await expect(dialog).toContainText(
      "Идёт генерация. Она может задержать ИИ-проверку работ обучаемых.",
    );
    await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
    expect(
      (await (await request.get(`/api/sessions/${waiting.id}`)).json()).status,
    ).toBe("draft");
    await start.click();
    await dialog
      .getByRole("button", { name: "Дождаться готовности", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Отменить ожидание", exact: true }),
    ).toBeVisible();
    evidence.pendingStart = await (
      await request.get(`/api/sessions/${waiting.id}`)
    ).json();
    expect((evidence.pendingStart as Session).started_at).toBeNull();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Отменить ожидание", exact: true }),
    ).toBeVisible();
    // Оба отложенных действия продолжаются после настоящего закрытия вкладки.
    await page.close();
    await expect
      .poll(
        async () =>
          (await (await request.get(`/api/sessions/${waiting.id}`)).json())
            .status,
        { timeout: 180_000, intervals: [1000] },
      )
      .toBe("running");
    const progress = await (
      await request.get(`/api/jobs/${job.id}/progress`)
    ).json();
    expect(progress.generation_state).toBe("ready");
    expect(progress.completed).toBe(1);
    evidence.finalProgress = progress;
    evidence.finalSession = await (
      await request.get(`/api/sessions/${waiting.id}`)
    ).json();
    const reopened = await context.newPage();
    await reopened.goto("/app/teacher");
    await expect(reopened.locator("#session-title")).toHaveText(waiting.title);
    await reopened.close();
  } finally {
    for (const session of sessions) {
      await request.post(`/api/sessions/${session.id}/finish`, {
        headers,
        data: { contract_version: 2, request_id: randomUUID() },
      });
    }
    evidence.finishedAt = new Date().toISOString();
    mkdirSync("tmp/ai-scenario-generation/stage-d", { recursive: true });
    writeFileSync(
      `tmp/ai-scenario-generation/stage-d/${info.project.name}-${Date.now()}.json`,
      JSON.stringify(evidence, null, 2),
    );
  }
});
