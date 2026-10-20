import { mkdirSync } from "node:fs";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { introSeenForAnyUser } from "./trainer";

// HQ-017: преподаватель смотрит экран ученика (решение Dani 18.10 — 5 кадров/с, без звука).
// Два браузерных контекста: преподаватель на «Ходе занятия», ученик в АРМ. Окно выбора
// экрана Chromium подтверждает флагом — в классе это делает сам ученик.

type Scenario = components["schemas"]["Scenario"];
type Session = components["schemas"]["Session"];
type User = components["schemas"]["User"];

const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-local";
const TRAINEE = "trainee01";
const SEAT = 7;
const SHOTS = process.env.HQ017_SHOTS;

// Проверено 18.10 на Chromium 140: headless shell и `--use-fake-ui-for-media-stream` дают
// NotReadableError (рабочего стола нет); полный Chromium (channel "chromium", новый headless)
// с `--auto-accept-this-tab-capture` и `preferCurrentTab` снимает вкладку АРМ.
test.use({
  channel: "chromium",
  launchOptions: { args: ["--auto-accept-this-tab-capture"] },
});

async function csrf(request: APIRequestContext) {
  return {
    "X-CSRF-Token": (await request.storageState()).cookies.find(
      (cookie) => cookie.name === "csrf",
    )!.value,
  };
}

async function signIn(page: Page, login: string) {
  await page.addInitScript(introSeenForAnyUser);
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(login);
  await page.getByLabel("Пароль").fill(PASSWORD);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  const start = page.getByRole("button", {
    name: /^(Перейти в тренажёр|Начать работу|Диспетчер служб)$/,
  });
  await expect(
    start.or(page.getByRole("button", { name: "Выйти", exact: true })),
  ).toBeVisible();
  if (await start.isVisible()) await start.click();
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/hq017-${name}.png` });
}

test("Преподаватель смотрит экран ученика: запрос, согласие, кадры, остановка", async ({
  browser,
  request,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, app.seed и явное E2E_DATABASE=1",
  );
  test.skip(
    testInfo.project.name !== "chromium",
    "Захват экрана без окна выбора — флаги Chromium",
  );
  test.setTimeout(120_000);

  expect(
    (
      await request.post("/api/auth/login", {
        data: { login: "teacher", password: PASSWORD },
      })
    ).ok(),
  ).toBeTruthy();
  const headers = await csrf(request);
  const users: User[] = await (await request.get("/api/users")).json();
  const trainee = users.find((user) => user.login === TRAINEE)!;
  const scenarios: Scenario[] = await (
    await request.get("/api/scenarios")
  ).json();
  const scenario = scenarios.find((item) => item.status === "approved")!;
  const created = await request.post("/api/sessions", {
    headers,
    data: {
      title: `Показ экрана ${Date.now()}`,
      participants: [
        {
          user_id: trainee.id,
          workstation_number: SEAT,
          dds_service_id: "102",
          level: 1,
        },
      ],
      settings_snapshot: await (await request.get("/api/settings")).json(),
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const session: Session = await created.json();
  const teacherContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const traineeContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  try {
    // Карточка — завтра: экрану не мешают звонки и таймеры.
    const assigned = await request.post(
      `/api/sessions/${session.id}/assignments`,
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
    expect(assigned.status(), await assigned.text()).toBe(201);
    expect(
      (
        await request.post(`/api/sessions/${session.id}/start`, { headers })
      ).ok(),
    ).toBeTruthy();

    const teacher = await teacherContext.newPage();
    await signIn(teacher, "teacher");
    await teacher.getByRole("tab", { name: "Ход занятия" }).click();
    const tile = teacher.locator("article").filter({ hasText: `АРМ ${SEAT}` });
    await tile.getByRole("button", { name: "Смотреть экран" }).click();
    await expect(tile.getByText("Ждём согласия ученика…")).toBeVisible();

    const student = await traineeContext.newPage();
    await signIn(student, TRAINEE);
    const bar = student.getByRole("alertdialog", { name: "Показ экрана" });
    await expect(bar).toContainText("Преподаватель просит показать ваш экран");
    await bar.getByRole("button", { name: "Показать экран" }).click();
    await expect(
      student.getByRole("status", { name: "Идёт показ экрана" }),
    ).toContainText("Преподаватель смотрит ваш экран");

    // Живая картинка: за 2 с кадр меняется около 10 раз (5 кадров/с), берём с запасом.
    const image = tile.getByRole("img", { name: `Экран АРМ ${SEAT}` });
    await expect(image).toBeVisible({ timeout: 15_000 });
    const seen = new Set<string>();
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      seen.add((await image.getAttribute("src")) ?? "");
      await teacher.waitForTimeout(50);
    }
    expect(seen.size).toBeGreaterThanOrEqual(5);
    expect(seen.size).toBeLessThanOrEqual(13);
    await shot(teacher, "teacher-tiles");
    await shot(student, "trainee-bar");

    await tile
      .getByRole("button", { name: `Экран АРМ ${SEAT} крупно` })
      .click();
    const zoom = teacher.getByRole("dialog", { name: `Экран АРМ ${SEAT}` });
    await expect(zoom.getByRole("img")).toBeVisible();
    await shot(teacher, "teacher-zoom");
    await teacher.keyboard.press("Escape");

    // Ученик останавливает — у преподавателя снова кнопка, картинки нет.
    await student
      .getByRole("status")
      .getByRole("button", { name: "Остановить показ" })
      .click();
    await expect(
      tile.getByRole("button", { name: "Смотреть экран" }),
    ).toBeVisible();
    await expect(image).toHaveCount(0);
    await expect(
      student.getByText("Преподаватель смотрит ваш экран"),
    ).toHaveCount(0);
  } finally {
    await teacherContext.close();
    await traineeContext.close();
    await request.post(`/api/sessions/${session.id}/finish`, {
      headers,
      data: { contract_version: 2, request_id: crypto.randomUUID() },
    });
  }
});
