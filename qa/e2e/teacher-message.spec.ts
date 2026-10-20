import { expect, test, type APIRequestContext } from "@playwright/test";
import { login } from "./captain-fixture";

// TC-12, contracts/live-lesson.md: преподаватель пишет ученику из «Хода занятия»,
// у ученика сообщение появляется в АРМ, «Прочитано» видно преподавателю.
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

test("Сообщение ученику доходит и отмечается прочитанным", async ({
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
  const users: { id: string; login: string }[] = await (
    await request.get("/api/users")
  ).json();
  const trainee = users.find((u) => u.login === "trainee02")!;
  const scenarios: { id: string; status: string; target_service_id: string }[] =
    await (await request.get("/api/scenarios")).json();
  const scenario = scenarios.find((s) => s.status === "approved")!;
  const title = `Сообщение ученику ${Date.now()}`;
  const created = await request.post("/api/sessions", {
    headers,
    data: {
      title,
      participants: [
        {
          user_id: trainee.id,
          workstation_number: 7,
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
    // Карточка — через час: проверка о сообщении, а не о карточке.
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

    const student = await (await browser.newContext()).newPage();
    await login(student, "trainee02");
    await expect(
      student.getByRole("button", { name: "Проверка гарнитуры" }),
    ).toBeVisible();
    const zone = student.getByRole("region", {
      name: "Сообщения преподавателя",
    });

    const teacher = await (await browser.newContext()).newPage();
    await login(teacher, "teacher");
    await teacher.getByRole("button", { name: new RegExp(title) }).click();
    const detail = teacher.locator('section[aria-labelledby="session-title"]');
    await detail.getByRole("tab", { name: "Ход занятия" }).click();
    // Доска открыта позже ученика — он всё равно «в сети».
    const phase = detail.locator("[data-phase]");
    await expect(phase).toHaveText("Свободен");
    await detail.getByRole("button", { name: /^АРМ 7/ }).click();
    const panel = detail.getByRole("region", { name: "АРМ 7" });
    const text = "Откройте памятку на странице 23.";
    await panel.getByLabel("Написать ученику").fill(text);
    await panel.getByRole("button", { name: "Отправить" }).click();
    await expect(panel.getByText("не прочитано")).toBeVisible();

    const message = zone.locator("[data-teacher-message]");
    await expect(message).toContainText(text, { timeout: 15_000 });
    await student.screenshot({
      path: testInfo.outputPath("student-message.png"),
    });
    await message.getByRole("button", { name: "Прочитано" }).click();
    await expect(message).toHaveCount(0);

    await expect(panel.getByText(/^прочитано в \d\d:\d\d$/)).toBeVisible({
      timeout: 15_000,
    });
    await teacher.screenshot({
      path: testInfo.outputPath("teacher-read.png"),
      fullPage: true,
    });

    // Ученик ушёл — доска видит обрыв не позже 45 с.
    await student.context().close();
    await expect(phase).toHaveText("Не в сети", { timeout: 45_000 });
  } finally {
    await request.post(`/api/sessions/${sessionId}/finish`, { headers });
  }
});
