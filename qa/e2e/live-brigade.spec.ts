import { expect, test, type Page } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { briefBrigade } from "./brigade-briefing";
import { answer, openPhone } from "./phone";

type Scenario = components["schemas"]["Scenario"];
type Card = components["schemas"]["Card"];
type CardTraining = components["schemas"]["CardTraining"];

// GP-05: бригада выезжает после вводной по частям (адрес и что случилось).
// DT-10, «живая бригада», два события целиком: при выезде расчёт повторяет адрес с ошибкой
// («Бескудниковский переулок» вместо бульвара из карточки) — диспетчер поправляет его
// вариантом; на месте расчёт спрашивает этаж (ответ — в описании карточки). Ответ — вариантом
// в окне разговора, расчёт отвечает в том же разговоре, ответ виден серверу. Сценарий — тренировка «Задымление в квартире», служба 101,
// полный цикл (`python -m app.seed.training` на свежей БД: существующие сценарии seed не
// меняет). Без стенда не прогонялся: Docker в среде разработки DT-10 не был поднят.

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

test("Живая бригада: поправка адреса и этаж — ответ вариантом, расчёт отвечает", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker и явное E2E_DATABASE=1",
  );
  // Один обучаемый ДДС 101 на оба браузера — занятия не должны пересекаться.
  test.skip(testInfo.project.name !== "chromium", "Только Chromium");
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  await login(page, "teacher");
  const headers = await csrf(page);
  const scenarios: Scenario[] = await (
    await page.request.get("/api/scenarios")
  ).json();
  const scenario = scenarios.find(
    (item) =>
      item.target_service_id === "101" &&
      item.level === 1 &&
      item.status === "approved" &&
      (item.teacher_comment ?? "").startsWith(
        "Тренировка без преподавателя: задымление в квартире",
      ),
  );
  test.skip(!scenario, "Нет сценария тренировки: выполните app.seed.training");
  expect(scenario!.card.description).toContain("на девятом этаже");
  const users = await (await page.request.get("/api/users")).json();
  const trainee = users.find(
    (user: { login: string }) => user.login === "trainee02",
  );
  const settings = await (await page.request.get("/api/settings")).json();
  const created = await page.request.post("/api/sessions", {
    headers,
    data: {
      title: `Живая бригада ${Date.now()}`,
      participants: [
        {
          user_id: trainee.id,
          workstation_number: 21,
          dds_service_id: "101",
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
    arm.setDefaultTimeout(20_000);
    await login(arm, trainee.login);
    await arm
      .getByRole("button", { name: /^(Диспетчер служб|Перейти в тренажёр)$/ })
      .click();
    let cardId = "";
    await expect
      .poll(async () => {
        const listed: Card[] = await (
          await arm.request.get("/api/cards")
        ).json();
        cardId = listed.find((item) => item.session_id === lesson.id)?.id ?? "";
        return cardId;
      })
      .not.toBe("");
    await arm.locator(`[data-card-id="${cardId}"]`).click();
    const number = scenario!.card.number;
    const cardView = arm.getByRole("region", {
      name: `Происшествие ${number}`,
      exact: true,
    });
    await expect(cardView).toBeVisible();

    async function status(state: string) {
      await cardView
        .getByRole("button", { name: "Изменить статус", exact: true })
        .click();
      await cardView.getByLabel("Статус", { exact: true }).selectOption(state);
      await cardView.getByLabel(/^Номер (службы|наряда)$/).fill("101");
      await cardView
        .getByLabel("Комментарий", { exact: true })
        .fill(scenario!.reference.expected_comment);
      await cardView
        .getByRole("button", { name: "Подтвердить", exact: true })
        .click();
      // Строка статуса всегда на виду (DT-19): после сохранения она очищается.
      await expect(
        cardView.getByLabel("Комментарий", { exact: true }),
      ).toHaveValue("");
    }

    async function training(): Promise<CardTraining> {
      return (await arm.request.get(`/api/cards/${cardId}/training`)).json();
    }

    async function heard(count: number) {
      await expect
        .poll(
          async () =>
            (await training()).messages.filter(
              (item) => item.state === "presented",
            ).length,
          { timeout: 40_000 },
        )
        .toBeGreaterThanOrEqual(count);
    }

    await status("accepted");
    // Связь службы — окно телефона ДДС (GP-09): силы службы в контактах.
    // GP-05: бригаду направляет вводная в разговоре — флажков и «Направить выбранные» нет.
    const win = await openPhone(arm);
    await expect(win.getByRole("checkbox")).toHaveCount(0);
    await expect(
      win.getByRole("button", { name: "Направить выбранные" }),
    ).toHaveCount(0);
    const line = await briefBrigade(arm);
    // В ленте — сказанное по частям; бригада выехала.
    await expect(
      line.getByText("Бескудниковский бульвар, 24").first(),
    ).toBeVisible();
    await expect(line.getByText("задымление: квартира")).toBeVisible();
    // Выбранный способ держится до конца разговора (макет телефона): после вводной по
    // частям «По частям» уже нажата — варианты ответа видны сразу.
    const chooseOption = async () => {
      const parts = answer(line).getByRole("button", {
        name: "По частям",
        exact: true,
      });
      await expect(parts).toBeVisible({ timeout: 20_000 });
      if ((await parts.getAttribute("aria-pressed")) !== "true")
        await parts.click({ timeout: 20_000 });
    };
    await expect(
      line.getByRole("button", { name: "Положить трубку" }),
    ).toBeVisible();

    // Выезд: доклад в том же разговоре, затем ловушка сценария — расчёт повторяет адрес
    // с ошибкой (своего повтора у бригады нет) — поправка вариантом в том же разговоре.
    // Голос — основной путь (DT-16): варианты свёрнуты за «По частям».
    await heard(1);
    await chooseOption();
    const fix = line.getByRole("button", {
      name: "Поправка по адресу: Бескудниковский бульвар, 24",
      exact: true,
    });
    await expect(fix).toBeVisible({ timeout: 20_000 });
    await expect(
      line.getByRole("button", { name: "Понял", exact: true }),
    ).toBeVisible();
    await fix.click();
    await expect(fix).toHaveCount(0);
    await expect(
      line.getByText("Принял поправку, перестраиваем маршрут."),
    ).toBeVisible({ timeout: 20_000 });

    // «Начало реагирования», доклад о прибытии (выезд, повтор, ответ, прибытие) → «Прибытие».
    await status("responding");
    await heard(4);
    await status("arrived");

    // Через 2 с после доклада о прибытии расчёт спрашивает этаж в том же разговоре.
    await expect(
      line.getByText("Диспетчер, на каком этаже квартира?"),
    ).toBeVisible({ timeout: 40_000 });
    await chooseOption();
    const floor = line.getByRole("button", {
      name: "Девятый этаж",
      exact: true,
    });
    await expect(floor).toBeVisible({ timeout: 20_000 });
    // Верный вариант ничем не отмечен: рядом другие варианты того же вида.
    await expect(
      line.getByRole("button", { name: "Этаж не знаю — ищите по подъездам" }),
    ).toBeVisible();
    await floor.click();
    await expect(floor).toHaveCount(0);
    await expect(line.getByText("Понял, поднимаемся.")).toBeVisible({
      timeout: 20_000,
    });

    const after = await training();
    const replied = after.messages.filter(
      (item) => (item.delivery.reply_options ?? []).length > 0,
    );
    expect(replied.map((item) => item.reply_key)).toEqual(["fix", "floor_9"]);
    // План (ожидания, ветки) обучаемому не уходит.
    expect(JSON.stringify(after)).not.toContain("option_key");
  } finally {
    await page.request.post(`/api/sessions/${lesson.id}/finish`, { headers });
    await traineeContext.close();
  }
});
