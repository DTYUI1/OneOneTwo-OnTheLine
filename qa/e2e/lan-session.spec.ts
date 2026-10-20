import { randomUUID } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { passWelcome } from "./captain-fixture";
import { introSeenForAnyUser } from "./trainer";

type Scenario = components["schemas"]["Scenario"];
type Session = components["schemas"]["Session"];
type Card = components["schemas"]["Card"];

// GP-21, рекомендации организаторов 16.10 (пп. 1 и 9): преподаватель и два обучаемых
// работают одновременно с разных адресов одного стенда. Стенд поднят с `--lan`:
//   E2E_BASE_URL=https://localhost:<порт>, E2E_LAN_URL=https://<IP машины>:<порт>.
// Три адреса: localhost (преподаватель), 127.0.0.1 и IP в сети (обучаемые) — у каждого
// своя область cookie, как у трёх разных компьютеров.
test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

const password = process.env.DEMO_PASSWORD ?? "demo-local";

async function loginUi(page: Page, name: string) {
  await page.addInitScript(introSeenForAnyUser);
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(name);
  await page.getByLabel("Пароль").fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  if (name.startsWith("trainee")) {
    const next = page
      .getByRole("button", { name: "Диспетчер служб" })
      .or(page.getByRole("button", { name: "Перейти в тренажёр" }));
    await next.click({ timeout: 5000 }).catch(() => undefined);
    await page
      .getByRole("button", { name: "Начать работу" })
      .click({ timeout: 3000 })
      .catch(() => undefined);
  } else await passWelcome(page);
}

async function csrf(request: APIRequestContext) {
  const cookies = (await request.storageState()).cookies;
  return { "X-CSRF-Token": cookies.find((c) => c.name === "csrf")!.value };
}

async function trainee(browser: Browser, baseURL: string) {
  const context = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
    permissions: ["microphone"],
  });
  return { context, page: await context.newPage() };
}

test("Учебная сеть: преподаватель и два обучаемых с трёх адресов, разные задания", async ({
  browser,
  request,
  baseURL,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL и E2E_DATABASE=1",
  );
  test.skip(
    testInfo.project.name !== "chromium",
    "Микрофон-заглушка — Chromium",
  );
  const lan = process.env.E2E_LAN_URL;
  test.skip(!lan, "Нужен E2E_LAN_URL — адрес стенда в сети (up.sh --lan)");
  test.setTimeout(150_000);

  const stamp = Date.now();
  const classes = [`Сеть-А ${stamp}`, `Сеть-Б ${stamp}`];
  expect(
    (
      await request.post("/api/auth/login", {
        data: { login: "teacher", password },
      })
    ).ok(),
  ).toBeTruthy();
  const headers = await csrf(request);
  const users: components["schemas"]["User"][] = await (
    await request.get("/api/users")
  ).json();
  const who = ["trainee02", "trainee03"].map(
    (l) => users.find((u) => u.login === l)!,
  );
  const scenarios: Scenario[] = await (
    await request.get("/api/scenarios")
  ).json();
  const source =
    scenarios.find((s) => s.id === "00000000-0000-4000-8000-000000000100") ??
    scenarios.find((s) => s.status === "approved")!;
  const made = classes.map((incident_class, i) => ({
    ...source,
    id: randomUUID(),
    card: {
      ...source.card,
      number: `8${(stamp + i).toString().slice(-7)}`,
      incident_class,
    },
  }));
  for (const s of made)
    expect(
      (await request.post("/api/scenarios", { headers, data: s })).status(),
    ).toBe(201);

  let session: Session | undefined;
  const opened: { close: () => Promise<void> }[] = [];
  try {
    const settings = await (await request.get("/api/settings")).json();
    const created = await request.post("/api/sessions", {
      headers,
      data: {
        title: `Учебная сеть ${stamp}`,
        participants: who.map((u, i) => ({
          user_id: u.id,
          workstation_number: 21 + i,
          dds_service_id: i === 0 ? "101" : "102",
          level: 4,
        })),
        settings_snapshot: { ...settings, parallel_cards: 3 },
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    session = await created.json();
    for (const [i, u] of who.entries())
      expect(
        (
          await request.post(`/api/sessions/${session!.id}/assignments`, {
            headers,
            data: {
              participant_id: u.id,
              scenario_id: made[i].id,
              order: 1,
              planned_at: new Date().toISOString(),
            },
          })
        ).status(),
      ).toBe(201);
    expect(
      (
        await request.post(`/api/sessions/${session.id}/start`, { headers })
      ).ok(),
    ).toBeTruthy();

    // Два обучаемых — с адресов 127.0.0.1 и IP в сети, каждый видит только своё задание.
    const local = baseURL!.replace("localhost", "127.0.0.1");
    const seats = [
      { name: "trainee02", url: local, mine: classes[0], other: classes[1] },
      { name: "trainee03", url: lan!, mine: classes[1], other: classes[0] },
    ];
    for (const seat of seats) {
      const { context, page } = await trainee(browser, seat.url);
      opened.push(context);
      await loginUi(page, seat.name);
      await page.addInitScript((id) => {
        try {
          localStorage.setItem(`arm:parallel-ack:${id}`, "1");
        } catch {
          // Окно «Параллельная работа» не мешает проверке.
        }
      }, session.id);
      await page.reload();
      await expect(page.getByText(seat.mine).first()).toBeVisible({
        timeout: 45_000,
      });
      await expect(page.getByText(seat.other)).toHaveCount(0);
      // Голос: страница по HTTPS — защищённый контекст, микрофон открывается.
      const mic = await page.evaluate(async () => {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        const tracks = stream.getAudioTracks().length;
        stream.getTracks().forEach((t) => t.stop());
        return { secure: window.isSecureContext, tracks, host: location.host };
      });
      expect(mic.secure).toBe(true);
      expect(mic.tracks).toBeGreaterThan(0);
      testInfo.annotations.push({
        type: "mic",
        description: JSON.stringify(mic),
      });
    }

    // Преподаватель с localhost: ход занятия показывает оба задания.
    const teacher = await trainee(browser, baseURL!);
    opened.push(teacher.context);
    await loginUi(teacher.page, "teacher");
    await teacher.page.goto("/app/teacher");
    await teacher.page.getByText(`Учебная сеть ${stamp}`).first().click();
    const detail = teacher.page.locator(
      'section[aria-labelledby="session-title"]',
    );
    await detail.getByRole("tab", { name: "Ход занятия" }).click();
    for (const c of classes)
      await expect(detail.getByText(c).first()).toBeVisible({
        timeout: 30_000,
      });
    await teacher.page.screenshot({
      path: testInfo.outputPath("teacher-progress.png"),
      fullPage: true,
    });

    const cards: Card[] = await (await request.get("/api/cards")).json();
    expect(cards.filter((c) => c.session_id === session!.id)).toHaveLength(2);
  } finally {
    for (const c of opened) await c.close();
    if (session)
      await request.post(`/api/sessions/${session.id}/finish`, { headers });
    for (const s of made)
      await request.post(`/api/scenarios/${s.id}/retire`, { headers });
  }
});
