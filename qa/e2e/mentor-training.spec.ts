import { expect, test, type Page, type Request } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { dropTrainee, freshTrainee, type Trainee } from "./accounts";
import { closeTutorialCard, unlockStep2 } from "./practice";
import { passWelcome } from "./practice-play";
import { coach } from "./trainer";

// «Тренировка с Николаем Сергеевичем» (капитан, 20.10): портрет в шапке списка открывает выбор
// «Смотрю / Вместе / Сам» на любой ступени — все три на учебной карточке ступени 1. Наставник
// (фигура, голос) и ✓ этапов — свои у каждого пользователя, смена входа без перезагрузки их
// перечитывает. Учётки — отдельные на прогон (accounts.ts): ступень не зависит от других тестов.

type Card = components["schemas"]["Card"];
type Session = components["schemas"]["Session"];

const MENTOR = "Тренировка с Николаем Сергеевичем";

test.skip(
  process.env.E2E_DATABASE !== "1",
  "Нужны PostgreSQL, worker, app.seed.training и явное E2E_DATABASE=1",
);
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Учётки и тренировки — на один браузер",
);

const accounts: Trainee[] = [];
test.afterEach(async ({ baseURL }) => {
  for (const trainee of accounts.splice(0))
    await dropTrainee(baseURL!, trainee);
});

async function account(baseURL: string, prefix: string) {
  const trainee = await freshTrainee(baseURL, prefix);
  accounts.push(trainee);
  return trainee;
}

/** Вход формой — без перезагрузки страницы, если она уже открыта на экране входа. */
async function signIn(page: Page, trainee: Trainee) {
  if (!/\/login$/.test(page.url())) await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(trainee.login);
  await page.getByLabel("Пароль").fill(trainee.password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  await passWelcome(page);
  await expect(
    page.getByRole("heading", { name: /Список происшествий/ }),
  ).toBeVisible();
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Выход из системы" });
  await dialog.getByRole("button", { name: "Да, выйти" }).click();
  // Идёт тренировка — второй вопрос.
  const again = dialog.getByRole("button", { name: "Всё равно выйти" });
  await expect(
    again.or(page.getByLabel("Логин", { exact: true })),
  ).toBeVisible();
  if (await again.isVisible()) await again.click();
  await expect(page).toHaveURL(/\/login$/);
}

const portrait = (page: Page) =>
  page.getByRole("button", { name: MENTOR, exact: true });
const mentorWindow = (page: Page) =>
  page.getByRole("dialog", { name: MENTOR, exact: true });
const mentorSwitch = (page: Page) =>
  mentorWindow(page).getByRole("checkbox", {
    name: /Николай Сергеевич в подсказках/,
  });

async function openMentor(page: Page) {
  await portrait(page).click();
  await expect(mentorWindow(page)).toBeVisible();
  return mentorWindow(page);
}

test("портрет на ступенях 1 и 2: окно, выключение и включение, смена входа без перезагрузки", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(15_000);
  const first = await account(baseURL!, "e2e-mentor-a");
  const second = await account(baseURL!, "e2e-mentor-b");

  // Ступень 1: портрет и группа этапов; в окне — когда ступень 1 зачтётся.
  await signIn(page, first);
  await expect(
    page.getByRole("group", { name: "Этапы обучения" }),
  ).toBeVisible();
  let window = await openMentor(page);
  for (const stage of ["1. Смотрю", "2. Вместе", "3. Сам"])
    await expect(
      window.getByRole("button", { name: new RegExp(stage) }),
    ).toBeVisible();
  await expect(window).toContainText(
    "Ступень 1 «Интерфейс и статусы» зачтётся",
  );
  // Выключить наставника — портрет серый; у этого пользователя это помнится.
  await expect(mentorSwitch(page)).toBeChecked();
  await mentorSwitch(page).uncheck();
  await window.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(portrait(page)).toHaveAttribute("data-off", "");

  // Другой пользователь без перезагрузки страницы: у него наставник включён.
  let loads = 0;
  page.on("load", () => loads++);
  await signOut(page);
  await signIn(page, second);
  expect(loads).toBe(0);
  await expect(portrait(page)).not.toHaveAttribute("data-off");
  window = await openMentor(page);
  await expect(mentorSwitch(page)).toBeChecked();
  await window.getByRole("button", { name: "Закрыть", exact: true }).click();

  // Ступень 2: группы этапов нет, портрет есть — «уже зачтена», наставник включается.
  await unlockStep2(page.request);
  await page.reload();
  await expect(
    page.getByRole("button", { name: /^Тренировка: ступень 2$/ }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "Этапы обучения" })).toHaveCount(
    0,
  );
  window = await openMentor(page);
  await expect(window).toContainText("Ступень 1 у вас уже зачтена");
  await mentorSwitch(page).uncheck();
  await expect(portrait(page)).toHaveAttribute("data-off", "");
  await mentorSwitch(page).check();
  await expect(portrait(page)).not.toHaveAttribute("data-off");
  await window.getByRole("button", { name: "Закрыть", exact: true }).click();

  // Первый пользователь снова: его «выключено» сохранилось; включаем.
  await signOut(page);
  await signIn(page, first);
  await expect(portrait(page)).toHaveAttribute("data-off", "");
  await openMentor(page);
  await mentorSwitch(page).check();
  await expect(portrait(page)).not.toHaveAttribute("data-off");
});

test("три этапа на учебной карточке: «Смотрю» → «Беру управление», «Вместе» и «Сам» ставят ✓", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(15_000);
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: "Параллельная работа" }),
    async (dialog) => {
      await dialog.getByRole("button", { name: "Понятно" }).click();
    },
  );
  const trainee = await account(baseURL!, "e2e-stages");
  await signIn(page, trainee);
  const practiceStarts: string[] = [];
  page.on("request", (request: Request) => {
    if (
      request.method() === "POST" &&
      /\/api\/practice(\?|$)/.test(request.url())
    )
      practiceStarts.push(new URL(request.url()).search);
  });

  /** Карточка новой тренировки (не `previous`) и её занятие. */
  async function openedCard(
    previous?: Card,
  ): Promise<{ card: Card; session: Session }> {
    await expect
      .poll(
        () => {
          const match = /\/arm\/cards\/([^/]+)$/.exec(page.url());
          const id = match ? decodeURIComponent(match[1]) : null;
          return id !== null && id !== previous?.id;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const id = decodeURIComponent(page.url().split("/").at(-1)!);
    const cards: Card[] = await (await page.request.get("/api/cards")).json();
    const card = cards.find((item) => item.id === id)!;
    const sessions: Session[] = await (
      await page.request.get("/api/sessions")
    ).json();
    return {
      card,
      session: sessions.find((item) => item.id === card.session_id)!,
    };
  }
  /** Идёт прежняя тренировка — новый этап спрашивает, прервать ли её. */
  async function restartIfAsked() {
    const ask = page.getByRole("dialog", { name: "Начать тренировку заново?" });
    const asked = await ask
      .waitFor({ timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (asked) await ask.getByRole("button", { name: "Начать заново" }).click();
  }
  async function toList() {
    await page.getByRole("button", { name: "ГБУ Система 112" }).click();
    await expect(
      page.getByRole("heading", { name: /Список происшествий/ }),
    ).toBeVisible();
  }

  // 1. «Смотрю»: показ учебной карточки; «Беру управление» — этап засчитан.
  await (await openMentor(page))
    .getByRole("button", { name: /1\. Смотрю/ })
    .click();
  const watched = await openedCard();
  await expect(coach(page)).toContainText("Это показ.");
  await coach(page).getByRole("button", { name: "Беру управление" }).click();
  await expect(coach(page)).toContainText("Вместе", { timeout: 20_000 });

  // 2. «Вместе»: подсказка у шага; карточка закрылась у вас на глазах — окно и ✓.
  await toList();
  await (await openMentor(page))
    .getByRole("button", { name: /2\. Вместе/ })
    .click();
  await restartIfAsked();
  const together = await openedCard(watched.card);
  expect(together.card.id).not.toBe(watched.card.id);
  await expect(coach(page)).toBeVisible();
  await closeTutorialCard(
    page.request,
    together.card,
    together.session.participants[0].dds_service_id,
  );
  const togetherDone = page.getByRole("dialog", {
    name: "Этап «Вместе» пройден",
  });
  await expect(togetherDone).toBeVisible({ timeout: 30_000 });

  // 3. «Сам» из окна этапа: та же учебная карточка без подсказок; закрылась — ✓ «Сам».
  await togetherDone
    .getByRole("button", { name: "Пройти без подсказок" })
    .click();
  await restartIfAsked();
  const solo = await openedCard(together.card);
  expect(solo.card.id).not.toBe(together.card.id);
  await expect(coach(page)).toHaveCount(0);
  await closeTutorialCard(
    page.request,
    solo.card,
    solo.session.participants[0].dds_service_id,
  );
  await expect
    .poll(
      async () =>
        (
          (await (
            await page.request.get(`/api/cards/${solo.card.id}`)
          ).json()) as Card
        ).state,
      { timeout: 30_000 },
    )
    .toBe("completed");
  // ✓ «Сам» ставит закрытие, увиденное на экране карточки, — ждём его, а не только сервер.
  await expect(
    page.getByText("Карточка закрыта.", { exact: true }),
  ).toBeVisible({
    timeout: 30_000,
  });

  // Все три этапа — учебная карточка: запрос без ступени; «Смотрю» — показ.
  expect(practiceStarts).toHaveLength(3);
  expect(practiceStarts[0]).toContain("demo=watch");
  for (const query of practiceStarts) expect(query).not.toContain("step=");
  for (const { card } of [watched, together, solo])
    expect(card.source.number).toBe(watched.card.source.number);

  await toList();
  const window = await openMentor(page);
  for (const stage of ["1. Смотрю", "2. Вместе", "3. Сам"])
    await expect(
      window.getByRole("button", { name: new RegExp(`✓ ${stage}`) }),
    ).toBeVisible();
});
