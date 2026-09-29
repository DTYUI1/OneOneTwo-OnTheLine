import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { passWelcome } from "./captain-fixture";

test("LISTEN восстанавливает открытый пульт без перезапуска API и reload", async ({
  page,
}) => {
  const project = process.env.E2E_RECOVERY_PROJECT;
  test.skip(
    process.env.E2E_DATABASE !== "1" || !project,
    "Нужен явно выбранный изолированный Compose-проект",
  );
  test.setTimeout(60_000);
  // Разрывать соединения допускается только на стендах этой проверки/CI.
  expect([
    "arm112-c01-stage5",
    "arm112-c01-stage6-final",
    "arm112-c01-publish",
    "arm112-ci-database",
  ]).toContain(project);
  const container = `${project}-db-1`;
  const inspect = (name: string) =>
    JSON.parse(
      execFileSync("docker", ["inspect", name], { encoding: "utf8" }),
    )[0];
  expect(inspect(container).Config.Labels["com.docker.compose.project"]).toBe(
    project,
  );
  expect(inspect(container).Config.Labels["com.docker.compose.service"]).toBe(
    "db",
  );
  const apiBefore = inspect(`${project}-api-1`);
  const sql = (query: string) =>
    execFileSync(
      "docker",
      [
        "exec",
        "-i",
        container,
        "psql",
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "arm112",
        "-d",
        "arm112",
        "-At",
      ],
      { input: query, encoding: "utf8" },
    ).trim();
  expect(
    sql(
      "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='arm112-realtime';",
    ),
  ).toBe("1");

  let snapshots = 0;
  page.on("websocket", (socket) =>
    socket.on("framereceived", (frame) => {
      if (JSON.parse(String(frame.payload)).type === "snapshot") snapshots++;
    }),
  );
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill("teacher");
  await page
    .getByLabel("Пароль")
    .fill(process.env.DEMO_PASSWORD ?? "demo-local");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  // Шапка с WebSocket запускается после приветствия (28.09).
  await passWelcome(page);
  await expect.poll(() => snapshots).toBe(1);
  const headers = {
    "X-CSRF-Token": (await page.context().cookies()).find(
      (cookie) => cookie.name === "csrf",
    )!.value,
  };
  const settings = await (await page.request.get("/api/settings")).json();
  const users: components["schemas"]["User"][] = await (
    await page.request.get("/api/users")
  ).json();
  const trainee = users.find((user) => user.login === "trainee01")!;
  const scenarios: components["schemas"]["Scenario"][] = await (
    await page.request.get("/api/scenarios")
  ).json();
  const scenario = scenarios.find((item) => item.status === "approved")!;
  const created = await page.request.post("/api/sessions", {
    headers,
    data: {
      title: `Восстановление LISTEN ${randomUUID()}`,
      participants: [
        {
          user_id: trainee.id,
          workstation_number: 21,
          dds_service_id: "102",
          level: 1,
        },
      ],
      settings_snapshot: settings,
    },
  });
  expect(created.status()).toBe(201);
  const lesson: components["schemas"]["Session"] = await created.json();
  try {
    const assignment = await page.request.post(
      `/api/sessions/${lesson.id}/assignments`,
      {
        headers,
        data: {
          participant_id: trainee.id,
          scenario_id: scenario.id,
          order: 1,
          planned_at: new Date(Date.now() + 86_400_000).toISOString(),
        },
      },
    );
    expect(assignment.status()).toBe(201);
    expect(
      (
        await page.request.post(`/api/sessions/${lesson.id}/start`, { headers })
      ).ok(),
    ).toBeTruthy();
    const row = page.getByRole("listitem").filter({
      has: page.getByRole("button", { name: new RegExp(lesson.title) }),
    });
    await expect(row.getByText("идёт", { exact: true })).toBeVisible();
    const priorSnapshots = snapshots;
    expect(
      sql(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='arm112-realtime';",
      ),
    ).toBe("t");
    expect(
      (
        await page.request.post(`/api/sessions/${lesson.id}/finish`, {
          headers,
        })
      ).ok(),
    ).toBeTruthy();
    await expect
      .poll(() => snapshots, { timeout: 20_000 })
      .toBeGreaterThan(priorSnapshots);
    await page.getByRole("button", { name: /Показать завершённые/ }).click();
    await expect(row.getByText("завершено", { exact: true })).toBeVisible();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/health")).json()).status,
      )
      .toBe("ok");
    expect(
      sql(
        "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='arm112-realtime';",
      ),
    ).toBe("1");
    const apiAfter = inspect(`${project}-api-1`);
    expect(apiAfter.State.Pid).toBe(apiBefore.State.Pid);
    expect(apiAfter.RestartCount).toBe(apiBefore.RestartCount);
  } finally {
    await page.request.post(`/api/sessions/${lesson.id}/finish`, { headers });
  }
});
