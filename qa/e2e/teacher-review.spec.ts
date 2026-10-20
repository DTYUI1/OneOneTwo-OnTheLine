import { expect, test, type APIRequestContext } from "@playwright/test";
import { login } from "./captain-fixture";

// TC-13, contracts/lesson-review.md: черновик отзыва правится и выдаётся, ученик видит
// отчёт только после «Выдать отчёт».
async function teacherApi(request: APIRequestContext) {
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
  return {
    "X-CSRF-Token": (await request.storageState()).cookies.find(
      (c) => c.name === "csrf",
    )!.value,
  };
}

test("Черновик отзыва правится и выдаётся ученику", async ({
  browser,
  request,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL и явное E2E_DATABASE=1",
  );
  test.skip(testInfo.project.name !== "chromium", "Обучаемый один на прогон");
  test.setTimeout(90_000);
  const headers = await teacherApi(request);
  const users: { id: string; login: string; full_name: string }[] = await (
    await request.get("/api/users")
  ).json();
  const trainee = users.find((u) => u.login === "trainee03")!;
  const scenarios: { id: string; status: string; target_service_id: string }[] =
    await (await request.get("/api/scenarios")).json();
  const scenario = scenarios.find((s) => s.status === "approved")!;
  const title = `Итоги занятия ${Date.now()}`;
  const created = await request.post("/api/sessions", {
    headers,
    data: {
      title,
      participants: [
        {
          user_id: trainee.id,
          workstation_number: 9,
          dds_service_id: scenario.target_service_id,
          level: 1,
        },
      ],
      settings_snapshot: await (await request.get("/api/settings")).json(),
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const sessionId: string = (await created.json()).id;
  try {
    const assigned = await request.post(
      `/api/sessions/${sessionId}/assignments`,
      {
        headers,
        data: {
          participant_id: trainee.id,
          scenario_id: scenario.id,
          order: 1,
          planned_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      },
    );
    expect(assigned.status(), await assigned.text()).toBe(201);
    expect(
      (
        await request.post(`/api/sessions/${sessionId}/start`, { headers })
      ).ok(),
    ).toBeTruthy();

    const teacher = await (await browser.newContext()).newPage();
    await login(teacher, "teacher");
    await teacher.getByRole("button", { name: new RegExp(title) }).click();
    const detail = teacher.locator('section[aria-labelledby="session-title"]');
    await detail.getByRole("tab", { name: "Отчёт" }).click();

    const row = detail.locator("[data-review-row]").first();
    await row.locator("summary").click();
    const field = row.getByLabel("Отзыв ученику");
    const draft = await field.inputValue();
    expect(draft).toContain(trainee.full_name);
    const edited = "Хорошо начали. Повторите порядок статусов.";
    await field.fill(edited);
    await row.getByRole("button", { name: "Сохранить отзыв" }).click();
    await expect(row.locator("[data-review-was]")).toContainText(draft);

    // До выдачи ученик ничего не видит.
    const student = await (await browser.newContext()).request;
    await student.post("/api/auth/login", {
      data: {
        login: "trainee03",
        password: process.env.DEMO_PASSWORD ?? "demo-local",
      },
    });
    const before: { session_id: string }[] = await (
      await student.get("/api/feedback")
    ).json();
    expect(before.filter((x) => x.session_id === sessionId)).toEqual([]);

    await detail.getByRole("button", { name: "Выдать отчёт" }).click();
    await expect(detail.getByText("Отчёт выдан всем.")).toBeVisible();
    await expect(detail.getByLabel("Отзыв ученику")).toHaveJSProperty(
      "readOnly",
      true,
    );
    const own: { session_id: string; text: string }[] = await (
      await student.get("/api/feedback")
    ).json();
    expect(own.find((x) => x.session_id === sessionId)?.text).toBe(edited);
    await teacher.screenshot({
      path: testInfo.outputPath("teacher-review.png"),
      fullPage: true,
    });
  } finally {
    await request.post(`/api/sessions/${sessionId}/finish`, { headers });
  }
});
