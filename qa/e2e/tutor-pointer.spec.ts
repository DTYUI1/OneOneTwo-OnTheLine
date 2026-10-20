import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { giveBriefing } from "./brigade-briefing";
import {
  backToContacts,
  closePhone,
  dial,
  expectEnded,
  freeBrigade,
  openPhone,
} from "./phone";

type Card = components["schemas"]["Card"];
type Session = components["schemas"]["Session"];

// DT-07, решение 17.10: во «Вместе» проводник — одна фраза к текущему шагу подсказкой у
// его элемента, со стрелкой; шаг сделан — подсказка уходит к следующему. Подсказка не
// закрывает элемент, на который указывает, и окно телефона. Проходим карточку через
// интерфейс до «Начала реагирования»: что говорит подсказка и где она стоит. Три размера
// экрана: на 1280×720 (ноутбук 1920×1080 с масштабом 150 %) подсказка садилась на окно
// телефона и закрывала «По частям» (проверка капитана 19.10).
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
] as const;

let practiceId: string | null = null;
let practiceOwner = "";

test.afterEach(async ({ request }) => {
  if (!practiceId) return;
  // Тренировку завершает сам обучаемый (администратор в учёбу не вмешивается).
  const loginResponse = await request.post("/api/auth/login", {
    data: {
      login: practiceOwner,
      password: process.env.DEMO_PASSWORD ?? "demo-local",
    },
  });
  expect(loginResponse.ok()).toBeTruthy();
  const csrf = (await request.storageState()).cookies.find(
    (cookie) => cookie.name === "csrf",
  )?.value;
  const finished = await request.post(`/api/sessions/${practiceId}/finish`, {
    headers: { "X-CSRF-Token": csrf! },
  });
  expect(finished.ok()).toBeTruthy();
  practiceId = null;
});

async function login(page: Page, name: string) {
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(name);
  await page
    .getByLabel("Пароль")
    .fill(process.env.DEMO_PASSWORD ?? "demo-local");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

for (const viewport of VIEWPORTS)
  test.describe(`${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });
    test("Тренировка: подсказка проводника указывает на нужный элемент", async ({
      page,
    }, testInfo) => walk(page, testInfo, viewport));
  });

async function walk(
  page: Page,
  testInfo: TestInfo,
  viewport: (typeof VIEWPORTS)[number],
) {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker, app.seed.training и явное E2E_DATABASE=1",
  );
  test.setTimeout(150_000);
  page.setDefaultTimeout(15_000);
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: "Начать тренировку заново?" }),
    async (dialog) => {
      await dialog.getByRole("button", { name: "Начать заново" }).click();
    },
  );
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: "Параллельная работа" }),
    async (dialog) => {
      await dialog.getByRole("button", { name: "Понятно" }).click();
    },
  );
  practiceOwner =
    testInfo.project.name === "chromium" ? "trainee04" : "trainee05";
  await login(page, practiceOwner);
  await page
    .getByRole("button", { name: /^(Диспетчер служб|Перейти в тренажёр)$/ })
    .click();

  // Обучающее упражнение (ступень 1, с подсказками) — как в captain-practice.
  const started = await page.request.post("/api/practice", {
    headers: {
      "X-CSRF-Token": (await page.context().cookies()).find(
        (cookie) => cookie.name === "csrf",
      )!.value,
    },
  });
  expect(started.ok()).toBe(true);
  let practice: Session | undefined;
  await expect
    .poll(async () => {
      const sessions: Session[] = await (
        await page.request.get("/api/sessions")
      ).json();
      practice = sessions.find(
        (item) => item.kind === "practice" && item.status === "running",
      );
      return practice?.id ?? null;
    })
    .not.toBeNull();
  practiceId = practice!.id;
  let card: Card | undefined;
  await expect
    .poll(
      async () => {
        const listed: Card[] = await (
          await page.request.get("/api/cards")
        ).json();
        card = listed.find((item) => item.session_id === practice!.id);
        return card?.id ?? null;
      },
      { timeout: 20_000 },
    )
    .not.toBeNull();
  // Этап «Вместе» — режим занятия тренировки в браузере (как у кнопки этапа).
  await page.evaluate(
    (id) => localStorage.setItem(`trainer:mode:${id}`, "together"),
    practiceId,
  );
  // Карточку открываем щелчком в списке, как обучаемый: при таком переходе
  // подсказка запускается раньше, чем карточка привязана к странице (ошибка 06.10).
  await page.goto("/app/arm");
  await page
    .locator('[data-help="arm-list"] tbody tr')
    .filter({ hasText: card!.source.number })
    .first()
    .click();
  await expect(page).toHaveURL(/\/arm\/cards\//);
  const cardView = page.getByRole("region", {
    name: `Происшествие ${card!.source.number}`,
    exact: true,
  });
  const coach = page.getByRole("region", { name: "Подсказка тренажёра" });
  const box = async (locator: ReturnType<typeof page.locator>) =>
    (await locator.boundingBox())!;
  const apart = (
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number },
  ) =>
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y;

  // 1. Шаг «Принять решение»: подсказка сразу, без «Подсказать», рядом со строкой
  //    статуса и не на ней; в ней же — время «Принята» ждёт.
  const statusSelect = cardView.getByLabel("Статус", { exact: true });
  await expect(coach).toContainText("«Принята»");
  await expect(coach).toContainText("«Принята» ждёт");
  await expect(
    page.getByRole("button", { name: "Подсказать", exact: true }),
  ).toHaveCount(0);
  expect(
    apart(
      await box(coach),
      await box(cardView.getByRole("group", { name: "Действие по карточке" })),
    ),
  ).toBe(true);
  await statusSelect.selectOption("accepted");
  await cardView.getByLabel("Комментарий", { exact: true }).fill("Принята");
  await cardView
    .getByRole("button", { name: "Подтвердить", exact: true })
    .click();

  // 2. Шаг сделан — подсказка о следующем: позвонить свободной бригаде (GP-09: значок на
  //    панели и окно телефона с силами службы). Окно телефона она не закрывает.
  await expect(coach).toContainText("Позвоните свободной бригаде");
  await expect(coach).not.toContainText("«Принята» ждёт");
  // GP-05: бригаду направляет вводная в разговоре — звоним и даём её по частям.
  const phone = page.locator('[data-help="card-phone"]');
  const line = await dial(page, freeBrigade(await openPhone(page)));
  // Разговор идёт, список сил скрыт — подсказка у вводной, сбоку от окна телефона: «По
  // частям» не закрыта (проверка 19.10).
  await expect(coach).toContainText("Дайте вводную голосом");
  await expect(coach).toHaveAttribute("data-placed", "true");
  expect(apart(await box(coach), await box(phone))).toBe(true);
  await expect(
    line.getByRole("button", { name: "По частям", exact: true }),
  ).toBeVisible();
  // Снимки для ручной проверки: суффикс — размер экрана, у 1280×720 — без суффикса.
  const size =
    viewport.width === 1280 ? "" : `-${viewport.width}x${viewport.height}`;
  const shots = process.env.E2E_SHOTS_DIR ?? "qa/results/shots";
  await page.screenshot({ path: `${shots}/tutor-brief${size}.png` });
  await giveBriefing(line);
  if (await coach.isVisible())
    expect(apart(await box(coach), await box(phone))).toBe(true);

  // TC-05: старший назвал статус («…выехала», «…выехало») — у строки статуса «Услышано по
  // телефону · Подставить». «Подставить» выбирает статус в строке, но не сохраняет его.
  const heard = coach.getByRole("group", { name: "Услышано по телефону" });
  await expect(heard).toContainText("Начало реагирования", { timeout: 45_000 });
  // Тот же снимок, что в qa/manual/2026-10-18.
  await page.screenshot({ path: `${shots}/hq035-heard${size}.png` });
  await heard.getByRole("button", { name: "Подставить", exact: true }).click();
  await expect(statusSelect).toHaveValue("responding");
  await expect(heard).toHaveCount(0);
  expect(
    (
      (await (
        await page.request.get(`/api/cards/${card!.id}/events`)
      ).json()) as { type: string; payload: { state?: string } }[]
    ).filter(
      (event) =>
        event.type === "status_change" && event.payload.state === "responding",
    ),
  ).toEqual([]);

  // 3. Выезд: доклад звучит в том же разговоре — проводнику вести некуда (GP-05).
  await line
    .getByRole("button", { name: "Положить трубку" })
    .click({ timeout: 3_000 })
    .catch(() => undefined);
  await expectEnded(line);
  await backToContacts(line);
  // Бригада выехала: в контактах телефона она «направлена сюда».
  await expect(line.locator('button[data-state="here"]')).toHaveCount(1);
  await closePhone(page);

  // Фраза шага во «Вместе» видна всё время — это не помощь: в журнал она не пишется.
  const events: { type: string; payload: { hint_id?: string } }[] = await (
    await page.request.get(`/api/cards/${card!.id}/events`)
  ).json();
  expect(
    events.filter(
      (event) =>
        event.type === "hint_open" &&
        String(event.payload.hint_id).startsWith("tutor:"),
    ),
  ).toEqual([]);
}
