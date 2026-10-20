import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { briefingText } from "./brigade-briefing";
import { passWelcome } from "./captain-fixture";

type Session = components["schemas"]["Session"];
type Scenario = components["schemas"]["Scenario"];
type Card = components["schemas"]["Card"];
type Training = components["schemas"]["CardTraining"];
type Target = components["schemas"]["CallTarget"];
const password = process.env.DEMO_PASSWORD ?? "demo-local";

async function headers(request: APIRequestContext) {
  return {
    "X-CSRF-Token": (await request.storageState()).cookies.find(
      (c) => c.name === "csrf",
    )!.value,
  };
}

async function send(
  request: APIRequestContext,
  id: string,
  type: string,
  payload: Record<string, unknown>,
) {
  const response = await request.post(`/api/cards/${id}/events`, {
    headers: await headers(request),
    data: {
      client_event_id: randomUUID(),
      client_ts: new Date().toISOString(),
      type,
      payload,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function play(
  request: APIRequestContext,
  sessionId: string,
  scenario: Scenario,
) {
  let card: Card | undefined;
  await expect
    .poll(
      async () => {
        const cards: Card[] = await (await request.get("/api/cards")).json();
        card = cards.find((c) => c.session_id === sessionId);
        return card?.id;
      },
      { timeout: 20_000 },
    )
    .toBeTruthy();
  const id = card!.id;
  await send(request, id, "deliver", {});
  await send(request, id, "open", {});
  await send(request, id, "status_change", {
    state: "accepted",
    comment: "Карточка принята, направлена бригада.",
  });
  await send(request, id, "field_change", {
    field: "service_number",
    value: "15",
  });
  const targets: Target[] = await (
    await request.get(
      `/api/services/${scenario.target_service_id}/call-targets`,
    )
  ).json();
  const target = targets.find((t) => t.brigade_id && t.is_active)!;
  await send(request, id, "brigades_select", {
    brigade_ids: [target.brigade_id!],
  });
  const presented = new Set<string>();
  for (const [index, state] of scenario.reference.expected_flow
    .filter((s) => !["received", "accepted"].includes(s))
    .entries()) {
    const callId = randomUUID();
    await send(request, id, "call_dial_target", {
      call_id: callId,
      call_target_id: target.id,
      brigade_id: target.brigade_id,
    });
    await send(request, id, "call_answer", { call_id: callId });
    // GP-05: бригада выезжает только после вводной — адрес и что случилось.
    if (index === 0)
      await send(request, id, "brigade_briefing", {
        call_id: callId,
        mode: "parts",
        text: briefingText({
          address: scenario.card.address,
          incident_class: scenario.card.incident_class ?? "",
          description: scenario.card.description,
        }),
      });
    await expect
      .poll(
        async () => {
          const training: Training = await (
            await request.get(`/api/cards/${id}/training`)
          ).json();
          for (const message of training.messages) {
            const { delivery } = message;
            if (!presented.has(delivery.delivery_id)) {
              // Реплики сценариев на каркасе — записи банка: предъявляем голосом.
              const audio = delivery.message.audio;
              await send(request, id, "message_presented", {
                delivery_id: delivery.delivery_id,
                playback_id: randomUUID(),
                message_version: delivery.message.version,
                audio_version: audio ? audio.version : null,
                channel: audio ? "audio" : "text",
              });
              presented.add(delivery.delivery_id);
            }
            // Вопрос бригады в этом разговоре — отвечаем первым вариантом: тест о пути до
            // оценки; пропущенное событие лишь задержало бы доклад (не дольше 40 с).
            const option = delivery.reply_options?.[0];
            if (delivery.call_id === callId && !message.reply_key && option) {
              await send(request, id, "brigade_reply", {
                call_id: callId,
                delivery_id: delivery.delivery_id,
                option_key: option.key,
              });
            }
          }
          const fresh: Training = await (
            await request.get(`/api/cards/${id}/training`)
          ).json();
          // Уточняющая реплика — отдельное событие. Число сообщений не означает,
          // что доклад о следующем статусе уже предъявлен.
          return (
            fresh.missing_report_states?.some(
              (missing) => missing === state,
            ) === false
          );
        },
        { timeout: 120_000 },
      )
      .toBeTruthy();
    await send(request, id, "call_hangup", { call_id: callId });
    await send(request, id, "field_change", {
      field: "comment",
      value: scenario.reference.expected_comment,
    });
    await send(request, id, "status_change", {
      state,
      comment: scenario.reference.expected_comment,
    });
  }
  let analysis: components["schemas"]["AttemptAnalysis"] | undefined;
  await expect
    .poll(
      async () => {
        analysis = await (
          await request.get(`/api/cards/${id}/analysis`)
        ).json();
        return analysis?.evaluation?.layers.find((l) => l.layer === "llm")
          ?.status;
      },
      { timeout: 150_000 },
    )
    .toBe("done");
  expect(analysis!.attempt_status).toBe("completed");
  expect(
    analysis!.evaluation?.layers.find((l) => l.layer === "rules")?.status,
  ).toBe("done");
  expect(JSON.stringify(analysis)).not.toContain('"expected_comment"');
  return { cardId: id, analysis };
}

test("ИИ-занятие: два новых задания, автоматические назначения, доклады и оценка", async ({
  page,
  playwright,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1" || process.env.E2E_REAL_AI !== "1",
    "Нужны собственный PostgreSQL-стенд и реальная локальная модель",
  );
  test.setTimeout(600_000);
  page.setDefaultTimeout(20_000);
  const results: Record<string, unknown> = { browser: testInfo.project.name };
  let session: Session | undefined;
  const teacher = await playwright.request.newContext({
    baseURL: process.env.E2E_BASE_URL,
    ignoreHTTPSErrors: true,
  });
  const students: APIRequestContext[] = [];
  try {
    expect(
      (
        await teacher.post("/api/auth/login", {
          data: { login: "teacher", password },
        })
      ).ok(),
    ).toBeTruthy();
    await page.goto("/app/login");
    await page.getByLabel("Логин", { exact: true }).fill("teacher");
    await page.getByLabel("Пароль").fill(password);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await passWelcome(page);
    await page
      .getByRole("button", { name: "+ Новое занятие", exact: true })
      .click();
    await expect(page.getByLabel("ИИ подбирает задания")).toBeEnabled();
    await page.getByLabel("ИИ подбирает задания").check();
    for (const [index, login] of ["trainee01", "trainee02"].entries()) {
      await page
        .getByRole("button", { name: "Добавить рабочее место", exact: true })
        .click();
      await page
        .getByLabel("Обучаемый", { exact: true })
        .nth(index)
        .fill(login);
      await page
        .getByLabel("Служба ДДС", { exact: true })
        .nth(index)
        .selectOption(index ? "101" : "GKH");
      await page
        .getByLabel("Уровень сложности", { exact: true })
        .nth(index)
        .fill(String(index + 1));
    }
    const started = Date.now();
    const [created] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/sessions") && r.request().method() === "POST",
      ),
      page
        .getByRole("button", { name: "Создать занятие", exact: true })
        .click(),
    ]);
    expect(created.status()).toBe(201);
    session = await created.json();
    results.sessionId = session!.id;
    results.jobId = session!.ai_preparation!.job_id;
    await expect(
      page.getByRole("button", { name: "Начать занятие", exact: true }),
    ).toBeDisabled();
    await page.reload();
    await expect
      .poll(
        async () =>
          (await (await teacher.get(`/api/sessions/${session!.id}`)).json())
            .ai_preparation.state,
        { timeout: 420_000 },
      )
      .toBe("ready");
    results.preparationSeconds = (Date.now() - started) / 1000;
    const batches: components["schemas"]["AssignmentBatch"][] = await (
      await teacher.get(`/api/sessions/${session!.id}/assignment-batches`)
    ).json();
    const assignments = batches.flatMap((b) => b.assignments);
    expect(assignments).toHaveLength(2);
    const scenarios: Scenario[] = [];
    for (const a of assignments) {
      const scenario: Scenario = await (
        await teacher.get(`/api/scenarios/${a.scenario_id}`)
      ).json();
      expect(scenario.status).toBe("approved");
      expect(scenario.origin).toBe("llm");
      scenarios.push(scenario);
    }
    expect(scenarios[0].card.description).not.toBe(
      scenarios[1].card.description,
    );
    results.scenarios = scenarios.map((s) => ({
      id: s.id,
      service: s.target_service_id,
      level: s.level,
      origin: s.origin,
    }));
    await expect(
      page.getByRole("button", { name: "Начать занятие", exact: true }),
    ).toBeEnabled({ timeout: 15_000 });
    await page
      .getByRole("button", { name: "Начать занятие", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Завершить", exact: true }),
    ).toBeVisible();
    const users: components["schemas"]["User"][] = await (
      await teacher.get("/api/users")
    ).json();
    const attempts = [];
    for (const login of ["trainee01", "trainee02"]) {
      const student = await playwright.request.newContext({
        baseURL: process.env.E2E_BASE_URL,
        ignoreHTTPSErrors: true,
      });
      students.push(student);
      expect(
        (
          await student.post("/api/auth/login", { data: { login, password } })
        ).ok(),
      ).toBeTruthy();
      const participantId = users.find((u) => u.login === login)!.id;
      const a = assignments.find((a) => a.participant_id === participantId)!;
      attempts.push(
        await play(
          student,
          session!.id,
          scenarios.find((s) => s.id === a.scenario_id)!,
        ),
      );
    }
    results.attempts = attempts;
    const analytics: components["schemas"]["SessionAnalytics"] = await (
      await teacher.get(`/api/reports/session/${session!.id}/analytics`)
    ).json();
    expect(
      analytics.trainees.every(
        (t) => t.recommendation && t.completed_count === 1,
      ),
    ).toBeTruthy();
    results.recommendations = analytics.trainees;
  } finally {
    if (session)
      await teacher.post(`/api/sessions/${session.id}/finish`, {
        headers: await headers(teacher),
      });
    for (const student of students) await student.dispose();
    await teacher.dispose();
    mkdirSync("tmp/ai-scenario-generation/stage-c", { recursive: true });
    writeFileSync(
      `tmp/ai-scenario-generation/stage-c/${testInfo.project.name}-${Date.now()}.json`,
      JSON.stringify(results, null, 2),
    );
  }
});
