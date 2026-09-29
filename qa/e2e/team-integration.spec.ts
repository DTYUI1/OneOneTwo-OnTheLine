import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { passWelcome } from "./captain-fixture";

type Scenario = components["schemas"]["Scenario"];
type Card = components["schemas"]["Card"];
type Evaluation = components["schemas"]["Evaluation"];

async function login(page: Page, name: string) {
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(name);
  await page
    .getByLabel("Пароль")
    .fill(process.env.DEMO_PASSWORD ?? "demo-local");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  if (!name.startsWith("trainee")) await passWelcome(page);
}

// Создаёт только собственные синтетические данные на явно выбранном database-стенде.
test("Связка команды: занятие → АРМ/телефон → T-006/evidence → override/CSV/replay", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker и явное E2E_DATABASE=1",
  );
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const health = await (await page.request.get("/api/health")).json();
  expect(health).toMatchObject({
    mode: "database",
    database: "ok",
    worker: "ok",
  });
  await login(page, "teacher");
  // Когда обучаемый всё закроет, кабинет предложит завершить занятие (FinishPrompt,
  // авто через 2 мин). Здесь проверяется ручной путь: разбор вердиктов, затем
  // «Завершить» — поэтому отвечаем «Не завершать».
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: "Завершение занятия" }),
    async (dialog) => {
      await dialog.getByRole("button", { name: "Не завершать" }).click();
    },
  );
  const headers = {
    "X-CSRF-Token": (await page.context().cookies()).find(
      (cookie) => cookie.name === "csrf",
    )!.value,
  };
  // Название — кириллицей и цифрами: russian-ui проверяет, что в кабинете нет латиницы,
  // а занятия этого теста остаются в списке преподавателя.
  const title = `Интеграция ${testInfo.project.name === "chromium" ? "Хромиум" : "Файрфокс"} ${Date.now()}`;
  const users = await (await page.request.get("/api/users")).json();
  const trainee = users.find(
    (user: { login: string }) =>
      user.login ===
      (testInfo.project.name === "chromium" ? "trainee04" : "trainee05"),
  );
  const templates: Scenario[] = await (
    await page.request.get("/api/scenarios")
  ).json();
  const services = await (await page.request.get("/api/services")).json();
  const service = services.find((item: { id: string }) => item.id === "102");
  const source = templates.find(
    (item) => item.id === "00000000-0000-4000-8000-000000000100",
  )!;
  expect(source).toBeTruthy();
  const scenario: Scenario = {
    ...source,
    id: randomUUID(),
    card: {
      ...source.card,
      number: `9${Date.now().toString().slice(-7)}`,
      incident_class: title,
    },
  };
  const createdScenario = await page.request.post("/api/scenarios", {
    headers,
    data: scenario,
  });
  expect(createdScenario.status(), await createdScenario.text()).toBe(201);
  const sessions: string[] = [];
  const traineeContext = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    ignoreHTTPSErrors: true,
  });
  try {
    // Новый сценарий добавлен после первой загрузки: перечитываем каталог перед созданием.
    const loadedSessions = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/sessions") && response.status() === 200,
    );
    await page.reload();
    await loadedSessions;
    await expect(
      page.getByRole("heading", { name: "Занятия", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Загружаем занятия…", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "+ Новое занятие", exact: true })
      .click();
    await page.getByLabel("Название", { exact: true }).fill(title);
    await page.getByRole("button", { name: "Добавить рабочее место" }).click();
    // Обучаемый — поле с подсказками (28.09): точный логин выбирает учётку.
    await page.getByLabel("Обучаемый", { exact: true }).fill(trainee.login);
    await page.getByLabel("Номер АРМ", { exact: true }).fill("23");
    await page.getByLabel("Служба ДДС", { exact: true }).selectOption("102");
    const creation = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/sessions") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Создать занятие", exact: true })
      .click();
    const created = await creation;
    expect(created.status()).toBe(201);
    const lesson = await created.json();
    sessions.push(lesson.id);
    const detail = page.locator('section[aria-labelledby="session-title"]');
    // С C-03 пульт выдаёт задания одной пачкой (D-01); прежняя раздача — только при 501.
    await detail.getByLabel("Первое через, с").fill("0");
    await detail
      .getByLabel("Добавить задание")
      // С ae86e44 в подписи сценария впереди номер карточки: «№ … · класс · ур. N».
      .selectOption({
        label: `№ ${scenario.card.number} · ${title} · ур. ${scenario.level}`,
      });
    await detail.getByRole("button", { name: "Выдать пачкой (1)" }).click();
    await expect(detail.getByText(/^Выдано заданий: 1\./)).toBeVisible();
    await detail.getByRole("button", { name: "Начать занятие" }).click();
    await expect(detail.getByText("Занятие запущено.")).toBeVisible();
    const board = page.getByRole("region", {
      name: "Доска выбранного занятия",
    });
    await expect(
      board.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(board.getByText("АРМ 23", { exact: true })).toBeVisible();

    // Второе running-занятие не должно перехватывать выбранную доску.
    const decoyResponse = await page.request.post("/api/sessions", {
      headers,
      data: {
        title: `${title} второе`,
        participants: lesson.participants,
        settings_snapshot: lesson.settings_snapshot,
      },
    });
    expect(decoyResponse.status()).toBe(201);
    const decoy = await decoyResponse.json();
    sessions.push(decoy.id);
    const assigned = await page.request.post(
      `/api/sessions/${decoy.id}/assignments`,
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
    expect(assigned.status()).toBe(201);
    expect(
      (
        await page.request.post(`/api/sessions/${decoy.id}/start`, { headers })
      ).ok(),
    ).toBeTruthy();
    await page
      .getByRole("button", { name: new RegExp(`^${decoy.title} идёт`) })
      .click();
    await expect(
      board.getByRole("heading", { name: decoy.title, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: new RegExp(`^${title} идёт`) })
      .click();
    await expect(
      board.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();

    const arm = await traineeContext.newPage();
    arm.setDefaultTimeout(15_000);
    await login(arm, trainee.login);
    await arm.getByRole("button", { name: "Диспетчер служб" }).click();
    await arm.getByRole("row").filter({ hasText: title }).click();
    const cardView = arm.getByRole("region", {
      name: `Происшествие ${scenario.card.number}`,
      exact: true,
    });
    await expect(cardView).toBeVisible();
    await cardView
      .getByRole("button", { name: `Развернуть ${service.name}`, exact: true })
      .click();
    await expect(cardView.getByText("АРМ 23", { exact: true })).toBeVisible();
    async function status(state: string) {
      await cardView
        .getByRole("button", { name: "Изменить статус", exact: true })
        .click();
      await cardView.getByLabel("Статус", { exact: true }).selectOption(state);
      await cardView.getByLabel(/^Номер (службы|наряда)$/).fill("102");
      // PR #57: «Ключевые сведения» ищут в комментарии суть происшествия — половину слов
      // его названия. Здесь это «Интеграция <браузер> <время>»: хватает словарного
      // «Интеграция», имя браузера проверка орфографии сочла бы ошибкой.
      await cardView
        .getByLabel("Комментарий", { exact: true })
        .fill(`Интеграция. ${source.reference.expected_comment}`);
      await cardView
        .getByRole("button", { name: "Подтвердить", exact: true })
        .click();
      if (state === "completed") {
        await expect(cardView.getByText(/Нажмите ✓ ещё раз/)).toBeVisible();
        await cardView
          .getByRole("button", { name: "Подтвердить", exact: true })
          .click();
      }
      // Форма видна, пока карточка открыта: после завершающего статуса она
      // исчезает, после остальных — остаётся с пустым выбором статуса.
      if (state === "completed")
        await expect(
          cardView.getByRole("group", { name: "Действие по карточке" }),
        ).toHaveCount(0);
      else
        await expect(
          cardView.getByLabel("Статус", { exact: true }),
        ).toHaveValue("");
    }
    await status("accepted");
    await status("responding");
    await arm.getByRole("button", { name: "Телефон", exact: true }).click();
    await arm.getByRole("button", { name: /^102.*ваша служба/ }).click();
    await expect(
      arm.getByRole("button", { name: "Разговор", exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await arm.getByRole("button", { name: "Положить трубку" }).click();
    await expect(
      arm.getByRole("button", { name: "Звонок завершён", exact: true }),
    ).toBeVisible();
    await arm
      .getByRole("button", { name: "Звонок завершён", exact: true })
      .click();
    await status("completed");

    const cards: Card[] = await (await page.request.get("/api/cards")).json();
    const card = cards.find((item) => item.session_id === lesson.id)!;
    expect(card.state).toBe("completed");
    const evaluations: Evaluation[] = await (
      await page.request.get("/api/evaluations")
    ).json();
    const evaluation = evaluations.find((item) => item.card_id === card.id)!;
    expect(evaluation.model_info.rules).toBe("evalcore");
    // Семь критериев карточки и два комментария (#57): грамотность, ключевые сведения.
    expect(evaluation.criteria).toHaveLength(9);
    expect(
      evaluation.criteria.every((item) => item.evidence.length > 0),
    ).toBeTruthy();
    expect(evaluation.total).toBe(1);
    // Ждём именно пересчёт worker, а не только мгновенную оценку API.
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(`/api/evaluations/${evaluation.id}`)
            ).json()
          ).model_info.embeddings,
      )
      .toBe("off");
    await detail.getByRole("tab", { name: /Вердикты/ }).click();
    const feed = page.getByRole("list", { name: "Вердикты ИИ" });
    await expect(
      feed.getByText("100 %", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      feed.getByText(evaluation.criteria[0].evidence[0], { exact: true }),
    ).toBeVisible();
    // Форма решения (29.09): решение — переключателем, балл — в процентах, одна кнопка.
    await expect(feed.getByLabel("Согласен с оценкой")).toBeChecked();
    await feed.getByLabel("Не согласен", { exact: true }).check();
    await feed.getByLabel("Причина несогласия").selectOption("other");
    await feed.getByLabel("Что не так").fill("Интеграционная проверка");
    await feed.getByLabel("Комментарий обучаемому").fill("Результат проверен");
    await feed.getByLabel("Новый балл, %").fill("80");
    await feed
      .getByRole("button", { name: "Сохранить решение", exact: true })
      .click();
    await expect(feed.getByText("80 %", { exact: true })).toBeVisible();
    // Итоги у обучаемого — одна дорога: «Мои результаты» в АРМ (/results ведёт туда же).
    await arm.goto("/app/arm");
    await arm
      .getByRole("button", { name: "Мои результаты", exact: true })
      .click();
    const results = arm.getByRole("region", { name: "Мои результаты" });
    await results
      .getByRole("button", { name: new RegExp(scenario.card.number) })
      .click();
    const review = results.getByRole("article");
    await expect(review.getByText("80 %", { exact: true })).toBeVisible();
    await expect(
      review.getByText("Результат проверен", { exact: true }),
    ).toBeVisible();
    // Разбор (29.09): полный список критериев с доказательствами свёрнут под
    // «Все критерии», если они не вынесены в «Итоги».
    const allCriteria = review.locator("details > summary", {
      hasText: "Все критерии",
    });
    if (await allCriteria.isVisible()) await allCriteria.click();
    await expect(
      review.getByText(evaluation.criteria[0].evidence[0], { exact: true }),
    ).toBeVisible();
    // Решение преподавателя сохраняется: после перезагрузки итог тот же.
    await arm.reload();
    await results
      .getByRole("button", { name: new RegExp(scenario.card.number) })
      .click();
    await expect(review.getByText("80 %", { exact: true })).toBeVisible();
    await feed.getByRole("button", { name: "Разобрать действия" }).click();
    await expect(
      feed.getByRole("slider", { name: "Время от вручения карточки" }),
    ).toBeVisible();
    await expect(
      feed.getByText("Комментарий преподавателя: Результат проверен"),
    ).toBeVisible();
    await detail.getByRole("tab", { name: "Отчёт", exact: true }).click();
    await expect(
      detail.getByRole("cell", { name: "80 %", exact: true }),
    ).toBeVisible();
    const downloading = page.waitForEvent("download");
    await detail.getByRole("button", { name: "Отчёт CSV" }).click();
    expect((await downloading).suggestedFilename()).toBe(
      `report-${lesson.id}.csv`,
    );
    const csv = await page.request.get(`/api/reports/session/${lesson.id}/csv`);
    expect(await csv.text()).toContain("0.8");
    await detail
      .getByRole("button", { name: "Завершить", exact: true })
      .click();
    await expect(detail.getByText("Занятие завершено.")).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: /Показать завершённые/ }).click();
    await page
      .getByRole("button", { name: new RegExp(`^${title} завершено`) })
      .click();
    await detail.getByRole("tab", { name: /Вердикты/ }).click();
    await expect(feed.getByText("80 %", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: new RegExp(`^${decoy.title} идёт`) })
      .click();
    await detail.getByRole("tab", { name: /Вердикты/ }).click();
    await expect(feed.getByText("80 %", { exact: true })).toHaveCount(0);
    await expect(
      detail.getByText(/Вердиктов по этому занятию пока нет/),
    ).toBeVisible();
  } finally {
    await traineeContext.close();
    // Только собственные занятия завершаются; записи сохраняем для воспроизведения.
    for (const id of sessions)
      await page.request.post(`/api/sessions/${id}/finish`, { headers });
    await page.request.post(`/api/scenarios/${scenario.id}/retire`, {
      headers,
    });
  }
});
