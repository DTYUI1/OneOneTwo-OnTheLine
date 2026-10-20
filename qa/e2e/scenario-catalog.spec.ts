import { expect, test } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { introSeenForAnyUser } from "./trainer";

type PracticeScenario = components["schemas"]["PracticeScenario"];
type Session = components["schemas"]["Session"];
type Card = components["schemas"]["Card"];
type User = components["schemas"]["User"];

// Каталог сценариев (17.10): обучаемый видит все проработанные сценарии по службам, своя
// служба первой, и «Пройти» сразу запускает тренировку с выбранным сценарием — за
// диспетчера службы сценария, без подсказчика.
const OWNER = "trainee04";
const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-local";

test("Каталог сценариев: группы по службам и тренировка выбранного сценария", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker, app.seed.training и явное E2E_DATABASE=1",
  );
  test.skip(
    testInfo.project.name !== "chromium",
    "Одна учётка обучаемого: браузеры не делят тренировку",
  );
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: "Параллельная работа" }),
    async (dialog) => {
      await dialog.getByRole("button", { name: "Понятно" }).click();
    },
  );
  // Прежняя тренировка обучаемого ещё идёт — прерываем её.
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: "Начать тренировку заново?" }),
    async (dialog) => {
      await dialog.getByRole("button", { name: "Начать заново" }).click();
    },
  );
  // Окно «Как устроено обучение» (DT-18) — перед первой тренировкой; здесь о другом.
  await page.addInitScript(introSeenForAnyUser);
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(OWNER);
  await page.getByLabel("Пароль").fill(PASSWORD);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  await page
    .getByRole("button", { name: /^(Диспетчер служб|Перейти в тренажёр)$/ })
    .click();

  const request = page.request;
  const me: User = await (await request.get("/api/auth/me")).json();
  const catalog: PracticeScenario[] = await (
    await request.get("/api/practice/catalog")
  ).json();
  expect(catalog.length).toBeGreaterThan(0);

  await page
    .getByRole("button", { name: "Каталог сценариев", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Каталог сценариев" });
  await expect(dialog).toBeVisible();
  // Своя служба — первой группой и подписана.
  if (catalog.some((item) => item.service_id === me.dds_service_id)) {
    await expect(dialog.getByRole("heading", { level: 3 }).first()).toHaveText(
      /— ваша служба$/,
    );
  }
  // Каждый сценарий каталога — строкой окна; чему учит — словами, а не кодами.
  await expect(dialog.getByRole("listitem")).toHaveCount(catalog.length);
  await expect(dialog.getByText(/Тренирует: /).first()).toBeVisible();
  await expect(dialog).not.toContainText("readback_error");

  // Сценарий чужой службы: в тренировке обучаемый — диспетчер службы сценария.
  const chosen =
    catalog.find((item) => item.service_id !== me.dds_service_id) ?? catalog[0];
  const row = dialog
    .getByRole("region", { name: chosen.service_name, exact: true })
    .getByRole("listitem")
    .filter({ hasText: chosen.title })
    .filter({ hasText: `уровень ${chosen.level}` })
    .first();
  await row.getByRole("button", { name: "Пройти", exact: true }).click();
  // Каждый запуск тренировки подтверждается (PracticeButton, 20.10).
  await page
    .getByRole("dialog", {
      name: /^(Запустить тренировку|Начать тренировку заново)\?$/,
    })
    .getByRole("button", { name: /^(Запустить|Начать заново)$/ })
    .click();

  // Карточка тренировки открывается сама, окно каталога закрывается.
  await expect(page).toHaveURL(/\/arm\/cards\//, { timeout: 30_000 });
  await expect(dialog).toBeHidden();
  const cardId = decodeURIComponent(page.url().split("/arm/cards/")[1]);
  const card: Card = await (await request.get(`/api/cards/${cardId}`)).json();
  const session: Session = await (
    await request.get(`/api/sessions/${card.session_id}`)
  ).json();
  try {
    expect(session.kind).toBe("practice");
    expect(session.title).toBe(`Тренировка по каталогу: ${chosen.title}`);
    expect(session.settings_snapshot.hints_level).toBe(0);
    expect(session.participants[0].dds_service_id).toBe(chosen.service_id);
    expect(session.participants[0].level).toBe(chosen.level);
  } finally {
    const csrf = (await request.storageState()).cookies.find(
      (cookie) => cookie.name === "csrf",
    )!.value;
    expect(
      (
        await request.post(`/api/sessions/${session.id}/finish`, {
          headers: { "X-CSRF-Token": csrf },
        })
      ).ok(),
    ).toBeTruthy();
  }
});
