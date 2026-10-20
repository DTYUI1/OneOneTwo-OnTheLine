import { expect, test, type Page } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { dropTrainee, freshTrainee, type Trainee } from "./accounts";
import { coach, confirmAgain, introSeenForAnyUser, stages } from "./trainer";

type Card = components["schemas"]["Card"];

// DT-18, решение 17.10: панели «Тренажёр» нет. Перед первой тренировкой — «Как устроено
// обучение»; этапы «Смотрю → Вместе → Сам» — это тренировки. В обучении тренажёр говорит
// подсказкой у элемента шага: «Смотрю» — за курсором, с «Беру управление» и «Пауза»;
// «Вместе» — фраза шага, «Покажи», «Принята» ждёт, понятность комментария и памятка перед
// необратимым статусом у строки статуса. «Сам» и другие тесты — чистый АРМ.

let practiceId: string | null = null;
// Отдельный обучаемый на тест (accounts.ts): проверки — на ступени 1, а общие trainee копят
// чужие попытки (ревью 20.10: trainee02 оказался на ступени 2).
let practiceOwner: Trainee | null = null;

test.afterEach(async ({ request, baseURL }) => {
  if (!practiceOwner) return;
  if (practiceId) {
    // Тренировку завершает сам обучаемый (администратор в учёбу не вмешивается).
    await request.post("/api/auth/login", {
      data: { login: practiceOwner.login, password: practiceOwner.password },
    });
    const csrf = (await request.storageState()).cookies.find(
      (cookie) => cookie.name === "csrf",
    )?.value;
    await request.post(`/api/sessions/${practiceId}/finish`, {
      headers: { "X-CSRF-Token": csrf ?? "" },
    });
  }
  await dropTrainee(baseURL!, practiceOwner);
  practiceId = null;
  practiceOwner = null;
});

async function enter(page: Page, projectName: string) {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker, app.seed.training и явное E2E_DATABASE=1",
  );
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
  // Запуск тренировки подтверждается (PracticeButton, 20.10): здесь проверяется не он.
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: "Запустить тренировку?" }),
    async (dialog) => {
      await dialog.getByRole("button", { name: "Запустить" }).click();
    },
  );
  // Не служба 103: она «Не принята» не ставит (памятка ДДС, с. 23; GP-16), а проверка ниже —
  // перед «Не принята». Chromium — служба 101, Firefox — 104.
  practiceOwner = await freshTrainee(
    test.info().project.use.baseURL!,
    "e2e-zone",
    projectName === "chromium" ? "101" : "104",
  );
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(practiceOwner.login);
  await page.getByLabel("Пароль").fill(practiceOwner.password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  await page
    .getByRole("button", { name: /^(Диспетчер служб|Перейти в тренажёр)$/ })
    .click();
  await expect(page).toHaveURL(/\/arm/);
}

/** Открытая карточка тренировки: её занятие — для завершения после проверки. */
async function openedCard(page: Page): Promise<Card> {
  await expect(page).toHaveURL(/\/arm\/cards\/[^/]+$/, { timeout: 20_000 });
  const id = decodeURIComponent(page.url().split("/").at(-1)!);
  const cards: Card[] = await (await page.request.get("/api/cards")).json();
  const card = cards.find((item) => item.id === id)!;
  practiceId = card.session_id;
  return card;
}

test("Как устроено обучение, «Вместе»: подсказка у шага, «Покажи», срочность и проверка", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  await enter(page, testInfo.project.name);
  // Панели тренажёра нет ни на списке, ни ярлыка у края.
  await expect(page.getByRole("region", { name: "Тренажёр" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Тренажёр/ })).toHaveCount(0);

  // Перед первым звонком тренировки — условности и три этапа (макет B).
  await page
    .getByRole("button", { name: /^Тренировка/ })
    .first()
    .click();
  const intro = page.getByRole("dialog", { name: "Как устроено обучение" });
  await expect(intro).toBeVisible();
  for (const head of [
    "Связь службы упрощена.",
    "Время сжато.",
    "Служба 101 — допущение.",
    "Скрытых вопросов с подвохом нет.",
  ])
    await expect(intro.getByText(head, { exact: true })).toBeVisible();
  await expect(intro).toContainText("примерно в 100 раз быстрее");
  await intro.getByRole("button", { name: "2. Вместе" }).click();
  const card = await openedCard(page);
  const cardView = page.getByRole("region", {
    name: `Происшествие ${card.source.number}`,
    exact: true,
  });

  // Шаг «Принять решение»: подсказка у строки статуса — фраза шага и «Принята» ждёт (TC-06,
  // первая стадия); о сжатии времени — только в окне «Как устроено обучение».
  const mark = coach(page);
  await expect(mark).toContainText("Выберите «Принята»");
  await expect(mark.locator('[data-urgency="calm"]')).toContainText(
    /«Принята» ждёт \d\d:\d\d из 00:30/,
  );
  await expect(mark).not.toContainText("примерно в 100 раз быстрее");
  await mark.getByRole("button", { name: "Покажи", exact: true }).click();
  // Курсор тренажёра показывает, куда нажать.
  await expect(page.locator("#trainer-ghost")).toBeVisible();
  await expect
    .poll(async () => {
      const events: { type: string; payload: { hint_id?: string } }[] = await (
        await page.request.get(`/api/cards/${card.id}/events`)
      ).json();
      return events.some(
        (event) =>
          event.type === "hint_open" &&
          event.payload.hint_id?.startsWith("show:"),
      );
    })
    .toBe(true);

  // Понятность комментария (TC-08) — во «Вместе» подсказкой у строки статуса.
  await cardView
    .getByRole("button", { name: "Изменить статус", exact: true })
    .click();
  await cardView.getByLabel("Статус", { exact: true }).selectOption("rejected");
  const comment = cardView.getByLabel("Комментарий", { exact: true });
  await comment.fill("ок");
  await expect(
    mark.getByRole("status", { name: "Понятность комментария" }),
  ).toContainText("«ок» ничего ему не скажет");

  // Необратимый статус: первое ✓ взводит — подпись у ✓ и памятка ДДС в подсказке.
  await comment.fill("Не наша служба: сведения переданы в 112.");
  await cardView
    .getByRole("button", { name: "Подтвердить", exact: true })
    .click();
  await expect(confirmAgain(page)).toContainText(
    "Нажмите ✓ или Enter ещё раз — статус «Не принята» сохранится",
  );
  await expect(mark).toContainText("Перед «Не принята» — памятка ДДС, с. 21");
  await expect(mark).toContainText(
    "В вашем комментарии: «Не наша служба: сведения переданы в 112.»",
  );
  await mark.getByRole("button", { name: "Вернуться к комментарию" }).click();
  await expect(confirmAgain(page)).toHaveCount(0);
  await expect(mark.getByText(/^Перед «Не принята»/)).toHaveCount(0);
  await expect(comment).toBeFocused();
  expect(
    (await (await page.request.get(`/api/cards/${card.id}`)).json()).state,
  ).not.toBe("rejected");

  // Спрятать подсказку нельзя (капитан, 19.10): ✕ прятал её до следующего шага, и показ на
  // паузе оставался без «Продолжить».
  await expect(
    mark.getByRole("button", { name: /^Скрыть подсказку/ }),
  ).toHaveCount(0);
  await expect(mark).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/arm/cards/${card.id}$`));
});

test("«Смотрю»: подсказка у курсора, «Беру управление» — дальше «Вместе»", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  page.setDefaultTimeout(15_000);
  await enter(page, testInfo.project.name);
  await page
    .getByRole("button", { name: /^Тренировка/ })
    .first()
    .click();
  await page
    .getByRole("dialog", { name: "Как устроено обучение" })
    .getByRole("button", { name: /1\. Смотрю$/ })
    .click();
  const card = await openedCard(page);
  const mark = coach(page);
  await expect(mark).toContainText("Это показ.");
  await expect(
    mark.getByRole("button", { name: "Беру управление" }),
  ).toBeVisible();
  // PR3-02: Esc не оставляет показ без доступного управления и подтверждения статуса.
  await mark.getByRole("button", { name: "Пауза", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(mark).toBeVisible();
  await expect(
    mark.getByRole("button", { name: "Беру управление" }),
  ).toBeVisible();
  await expect(
    mark.getByRole("button", { name: "Пауза", exact: true }),
  ).toBeVisible();
  await expect(
    mark.getByRole("button", { name: /^Скрыть подсказку/ }),
  ).toHaveCount(0);
  // Свои щелчки в АРМ во время показа не проходят — подсказка объясняет почему.
  await page
    .getByRole("region", { name: `Происшествие ${card.source.number}` })
    .click({ position: { x: 40, y: 40 } });
  await expect(mark).toContainText("Сейчас показывает тренажёр.");
  // Курсор сам ставит «Принята» через строку статуса.
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/cards/${card.id}`)).json()).state,
      { timeout: 90_000 },
    )
    .toBe("accepted");
  await mark.getByRole("button", { name: "Беру управление" }).click();
  await expect(mark.getByRole("button", { name: "Покажи" })).toBeVisible();
  await expect(mark.getByRole("button", { name: "Пауза" })).toHaveCount(0);
  await expect(page.locator("#trainer-ghost")).toBeHidden();
});

test("«Сам» — тест: чистый АРМ, этапы — в шапке списка", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.addInitScript(introSeenForAnyUser);
  await enter(page, testInfo.project.name);
  // Этапы — группа в шапке списка, пока обучаемый на ступени 1 «Моего пути».
  if (await stages(page).count())
    await expect(stages(page).getByRole("button")).toHaveCount(3);
  await page
    .getByRole("button", { name: /^Тренировка/ })
    .first()
    .click();
  const card = await openedCard(page);
  await expect(
    page.getByRole("region", { name: `Происшествие ${card.source.number}` }),
  ).toBeVisible();
  // Ни подсказки, ни панели, ни строки «Принята» ждёт — и после прежнего порога «застрял».
  await page.waitForTimeout(17_000);
  await expect(coach(page)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Тренажёр" })).toHaveCount(0);
  await expect(page.getByText(/«Принята» ждёт/)).toHaveCount(0);
  await expect(page.locator("#trainer-ghost")).toBeHidden();
});
