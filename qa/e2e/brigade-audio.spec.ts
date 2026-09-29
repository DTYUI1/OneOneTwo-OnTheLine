import { expect, test, type Page } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";

type Scenario = components["schemas"]["Scenario"];
type Card = components["schemas"]["Card"];
type CardTraining = components["schemas"]["CardTraining"];

async function login(page: Page, name: string) {
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(name);
  await page
    .getByLabel("Пароль")
    .fill(process.env.DEMO_PASSWORD ?? "demo-local");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

async function csrf(page: Page) {
  return {
    "X-CSRF-Token": (await page.context().cookies()).find(
      (cookie) => cookie.name === "csrf",
    )!.value,
  };
}

// Полный путь B-02 на настоящем C-04: ручной выбор бригады → звонок на её прямой
// номер → доклады выдаёт worker → звук → подтверждённое предъявление на сервере.
// Сценарии с озвученными докладами создаёт `python -m app.seed.training`.
test("Бригада: выбор → звонок → озвученный доклад → предъявление; карточка не блокируется", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker и явное E2E_DATABASE=1",
  );
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  await login(page, "teacher");
  const headers = await csrf(page);
  const scenarios: Scenario[] = await (
    await page.request.get("/api/scenarios")
  ).json();
  // Полный сценарий — с докладом о завершении. Первое поколение без него выведено в
  // архив (28.09): эталон ждал «Работы завершены», а бригада о них не докладывала.
  const scenario = scenarios.find(
    (item) =>
      item.target_service_id === "102" &&
      item.status === "approved" &&
      (item.teacher_comment ?? "").startsWith(
        "Учебный пример C-04: доклады бригады о выезде, прибытии, работах и завершении",
      ),
  );
  test.skip(!scenario, "Нет сценария с докладами: выполните app.seed.training");
  const users = await (await page.request.get("/api/users")).json();
  const trainee = users.find(
    (user: { login: string }) =>
      user.login ===
      (testInfo.project.name === "chromium" ? "trainee01" : "trainee03"),
  );
  const settings = await (await page.request.get("/api/settings")).json();
  // Название — кириллицей и цифрами: russian-ui проверяет, что в кабинете нет латиницы,
  // а занятия этого теста остаются в списке преподавателя.
  const title = `Бригады ${testInfo.project.name === "chromium" ? "Хромиум" : "Файрфокс"} ${Date.now()}`;
  const created = await page.request.post("/api/sessions", {
    headers,
    data: {
      title,
      participants: [
        {
          user_id: trainee.id,
          workstation_number: 22,
          dds_service_id: "102",
          level: 1,
        },
      ],
      settings_snapshot: settings,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const lesson = await created.json();
  const traineeContext = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    ignoreHTTPSErrors: true,
  });
  try {
    const assigned = await page.request.post(
      `/api/sessions/${lesson.id}/assignments`,
      {
        headers,
        data: {
          participant_id: trainee.id,
          scenario_id: scenario!.id,
          order: 1,
          planned_at: new Date().toISOString(),
        },
      },
    );
    expect(assigned.status(), await assigned.text()).toBe(201);
    expect(
      (
        await page.request.post(`/api/sessions/${lesson.id}/start`, { headers })
      ).ok(),
    ).toBeTruthy();

    const arm = await traineeContext.newPage();
    arm.setDefaultTimeout(15_000);
    await login(arm, trainee.login);
    await arm.getByRole("button", { name: "Диспетчер служб" }).click();
    const number = scenario!.card.number;
    // Номер сценария повторяется в прошлых занятиях: берём строку своей карточки
    // по её id (реестр показывает новые сверху, не в порядке сервера).
    let cardId = "";
    await expect
      .poll(async () => {
        const listed: Card[] = await (
          await arm.request.get("/api/cards")
        ).json();
        cardId =
          listed.find(
            (item) =>
              item.source.number === number && item.session_id === lesson.id,
          )?.id ?? "";
        return cardId;
      })
      .not.toBe("");
    await arm.locator(`[data-card-id="${cardId}"]`).click();
    const cardView = arm.getByRole("region", {
      name: `Происшествие ${number}`,
      exact: true,
    });
    await expect(cardView).toBeVisible();
    const services = await (await page.request.get("/api/services")).json();
    const police = services.find((item: { id: string }) => item.id === "102");
    await cardView
      .getByRole("button", { name: `Развернуть ${police.name}`, exact: true })
      .click();

    async function status(state: string) {
      await cardView
        .getByRole("button", { name: "Изменить статус", exact: true })
        .click();
      await cardView.getByLabel("Статус", { exact: true }).selectOption(state);
      await cardView.getByLabel(/^Номер (службы|наряда)$/).fill("102");
      await cardView
        .getByLabel("Комментарий", { exact: true })
        .fill(scenario!.reference.expected_comment);
      await cardView
        .getByRole("button", { name: "Подтвердить", exact: true })
        .click();
      // Форма остаётся открытой: успешная отправка сбрасывает выбор статуса.
      await expect(cardView.getByLabel("Статус", { exact: true })).toHaveValue(
        "",
      );
    }
    // Табло сил видно до решения по карточке, но направить бригаду до «Принята»
    // нельзя: кнопка недоступна, рядом сказано почему (28.09).
    const strip = arm.getByRole("button", {
      name: /^(Телефон|Звонок завершён)$/,
    });
    await strip.click();
    const panel = arm.getByRole("region", { name: "Бригады службы" });
    const firstBrigade = panel.getByRole("checkbox", {
      name: "Учебная бригада 1 службы 102",
    });
    await expect(firstBrigade).toBeVisible();
    await expect(panel.getByText("свободна").first()).toBeVisible();
    await firstBrigade.check();
    await expect(
      panel.getByRole("button", { name: "Направить выбранные" }),
    ).toBeDisabled();
    await expect(panel.getByText(/Сначала примите решение/)).toBeVisible();

    // Номер ненаправленной бригады не запрещён: звонок проходит, бригада отвечает
    // отказом и сама кладёт трубку, доклада нет, очередь карточки не останавливается.
    const brigades: { id: string; name: string }[] = await (
      await arm.request.get("/api/services/102/brigades")
    ).json();
    const targets: { brigade_id: string | null; phone_ext: string }[] = await (
      await arm.request.get("/api/services/102/call-targets")
    ).json();
    const secondBrigade = brigades.find(
      (item) => item.name === "Учебная бригада 2 службы 102",
    )!;
    const secondExt = targets.find(
      (item) => item.brigade_id === secondBrigade.id,
    )!.phone_ext;
    for (const digit of secondExt)
      await arm.getByRole("button", { name: digit, exact: true }).click();
    await arm.getByRole("button", { name: "Вызов", exact: true }).click();
    await expect(
      arm.getByText(
        /^Бригада не направлена на это происшествие — доклада не будет/,
      ),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      arm.getByRole("button", { name: "Звонок завершён", exact: true }),
    ).toBeVisible();
    const refusedCards: Card[] = await (
      await arm.request.get("/api/cards")
    ).json();
    const refusedCard = refusedCards.find(
      (item) => item.session_id === lesson.id,
    )!;
    const afterRefusal: CardTraining = await (
      await arm.request.get(`/api/cards/${refusedCard.id}/training`)
    ).json();
    expect(afterRefusal.messages).toEqual([]);
    // Окно разговора после отбоя остаётся с итогом, пока его не закроют.
    await arm.getByRole("button", { name: "Закрыть окно разговора" }).click();
    await arm.getByRole("button", { name: "Свернуть телефон" }).click();

    await status("accepted");
    await cardView
      .getByRole("button", { name: "Изменить статус", exact: true })
      .click();
    await expect(
      cardView
        .getByLabel("Статус", { exact: true })
        .locator('option[value="responding"]'),
    ).toBeDisabled();
    await cardView
      .getByRole("button", { name: "Отменить", exact: true })
      .click();

    await strip.click();
    await firstBrigade.check();
    await panel.getByRole("button", { name: "Направить выбранные" }).click();
    await expect(panel.getByText("Направлено бригад: 1.")).toBeVisible();

    // Неизвестный номер не уходит на сервер: иначе 422 заблокировал бы очередь карточки.
    for (const digit of "999")
      await arm.getByRole("button", { name: digit, exact: true }).click();
    await arm.getByRole("button", { name: "Вызов", exact: true }).click();
    await expect(
      arm.getByText("Номер не обслуживается. Проверьте его в справочнике."),
    ).toBeVisible();

    const links = panel.getByRole("list", { name: "Связь с бригадами" });
    await links.getByRole("button", { name: "Позвонить" }).first().click();
    await expect(
      arm.getByRole("button", { name: "Разговор", exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // Первый доклад выдаётся через 3 с после ответа. Засчитывается только
    // прозвучавший целиком: без звукового устройства это честный сбой, не успех.
    const cards: Card[] = await (await arm.request.get("/api/cards")).json();
    const card = cards.find((item) => item.session_id === lesson.id)!;
    let first: CardTraining["messages"][number] | undefined;
    await expect
      .poll(
        async () => {
          const training: CardTraining = await (
            await arm.request.get(`/api/cards/${card.id}/training`)
          ).json();
          first = [...training.messages].sort((left, right) =>
            left.delivery.delivered_at.localeCompare(
              right.delivery.delivered_at,
            ),
          )[0];
          return first?.state ?? "none";
        },
        { timeout: 30_000 },
      )
      .toMatch(/^(presented|failed)$/);
    expect(first!.delivery.message.audio).not.toBeNull();
    const report = first!.delivery.message.text;
    const reports = arm.getByRole("region", { name: "Доклады бригад" });
    if (first!.state === "presented") {
      expect(first!.presentation_event_id).toBeTruthy();
      await expect(
        reports.getByRole("listitem").filter({ hasText: report }),
      ).toBeVisible();
      // Доклад на линии — крупной строкой в окне разговора, а не только в
      // списке докладов: окно с «Положить трубку», вне регионов «Бригады службы»
      // и «Доклады бригад».
      const line = arm.getByRole("region", { name: /^Разговор: / });
      await expect(
        line.getByRole("button", { name: "Положить трубку" }),
      ).toBeVisible();
      await expect(line.getByText(report, { exact: true })).toBeVisible();
    } else {
      // Chromium в CI всегда играет через фейковое устройство — там сбой был бы дефектом.
      expect(testInfo.project.name).not.toBe("chromium");
      expect(first!.failure_reason).toBe("playback_error");
      expect(first!.presented_at).toBeNull();
      await expect(panel.getByText(report)).toBeVisible();
      await expect(
        panel.getByRole("button", { name: "Прослушать ещё раз" }),
      ).toBeVisible();
    }

    await arm.getByRole("button", { name: "Положить трубку" }).click();
    await expect(
      arm.getByRole("button", { name: "Звонок завершён", exact: true }),
    ).toBeVisible();
    await arm.getByRole("button", { name: "Закрыть окно разговора" }).click();
    await arm
      .getByRole("button", { name: "Звонок завершён", exact: true })
      .click();
    await expect(panel).toHaveCount(0);
    // Доклад нужен именно сейчас — при свёрнутой панели, когда по нему пишется
    // комментарий в карточке. Значит, он не должен исчезать вместе с панелью.
    if (first!.state === "presented")
      await expect(
        reports.getByRole("listitem").filter({ hasText: report }),
      ).toBeVisible();
    if (first!.state === "presented") {
      // После доклада статус снова доступен и очередь принимает действие.
      await status("responding");
      await expect
        .poll(
          async () =>
            (
              (await (await arm.request.get("/api/cards")).json()) as Card[]
            ).find((item) => item.id === card.id)?.state,
        )
        .toBe("responding");
    } else {
      await cardView
        .getByRole("button", { name: "Изменить статус", exact: true })
        .click();
      await expect(
        cardView
          .getByLabel("Статус", { exact: true })
          .locator('option[value="responding"]'),
      ).toBeDisabled();
    }
  } finally {
    await page.request.post(`/api/sessions/${lesson.id}/finish`, { headers });
    await traineeContext.close();
  }
});
