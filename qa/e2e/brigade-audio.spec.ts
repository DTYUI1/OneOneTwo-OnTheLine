import { expect, test, type Page } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { briefBrigade } from "./brigade-briefing";
import { passWelcome } from "./practice-play";
import {
  answer,
  backToContacts,
  callHead,
  closePhone,
  expectEnded,
  openPhone,
} from "./phone";

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
  await passWelcome(page);
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
  // Микрофон не нужен (29.09): разрешение не выдаётся, шпион считает запросы.
  await traineeContext.addInitScript(() => {
    const spy = window as Window & { micRequests?: number };
    spy.micRequests = 0;
    const devices = navigator.mediaDevices;
    if (!devices) return;
    devices.getUserMedia = async () => {
      spy.micRequests = (spy.micRequests ?? 0) + 1;
      throw new DOMException("Микрофон не нужен", "NotAllowedError");
    };
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
    const trainingReady = arm.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/cards/${cardId}/training`) &&
        response.status() === 200,
    );
    await arm.locator(`[data-card-id="${cardId}"]`).click();
    const cardView = arm.getByRole("region", {
      name: `Происшествие ${number}`,
      exact: true,
    });
    await expect(cardView).toBeVisible();
    await trainingReady;

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
      // Строка статуса всегда на виду (DT-19): после сохранения она очищается.
      await expect(
        cardView.getByLabel("Комментарий", { exact: true }),
      ).toHaveValue("");
      await expect
        .poll(async () => {
          const card: Card = await (
            await arm.request.get(`/api/cards/${cardId}`)
          ).json();
          return card.state;
        })
        .toBe(state);
    }
    // Статус хода работ без доклада бригады: сервер его не примет (409
    // report_required), строка статуса объясняет причину и остаётся открытой.
    async function expectReportRequired() {
      await cardView
        .getByRole("button", { name: "Изменить статус", exact: true })
        .click();
      await cardView
        .getByLabel("Статус", { exact: true })
        .selectOption("responding");
      await cardView
        .getByLabel("Комментарий", { exact: true })
        .fill("Проверка доклада");
      await cardView
        .getByRole("button", { name: "Подтвердить", exact: true })
        .click();
      await expect(
        cardView.getByText(
          "Сначала получите и прослушайте доклад бригады об этом этапе.",
        ),
      ).toBeVisible();
    }
    // Силы службы видны в телефоне до решения по карточке, но направить бригаду до
    // «Принята» нельзя, рядом сказано почему (28.09). Флажков нет: направляет вводная в
    // разговоре (GP-05). Связь службы — окно телефона ДДС (GP-09).
    const win = await openPhone(arm);
    const firstBrigade = win.locator('button[data-state="free"]').first();
    await expect(firstBrigade).toBeVisible();
    const brigadeExt = await firstBrigade.getAttribute("data-ext");
    expect(brigadeExt).toBeTruthy();
    await expect(firstBrigade).toHaveAccessibleName(
      `Позвонить: Бригада ${brigadeExt}`,
    );
    await expect(
      win.locator('button[data-state="free"]').first(),
    ).toBeVisible();
    await expect(win.getByText("свободна").first()).toBeVisible();
    await expect(win.getByRole("checkbox")).toHaveCount(0);
    await expect(win.getByText(/Сначала примите решение/)).toBeVisible();

    // До решения звонок бригаде не запрещён: звонок проходит, бригада отвечает
    // отказом и сама кладёт трубку, доклада нет, очередь карточки не останавливается.
    await win.locator('button[data-state="free"]').nth(1).click();
    await expect(
      arm.getByText(
        /^Бригада не направлена на это происшествие — доклада не будет/,
      ),
    ).toBeVisible({ timeout: 20_000 });
    await expectEnded(win);
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
    // Разговор после отбоя остаётся с итогом, пока не вернутся к контактам.
    await backToContacts(win);
    // Окно телефона не заслоняет карточку, пока меняется статус.
    await closePhone(arm);

    await status("accepted");
    // Список статусов открыт целиком, как на arm_dds/14; без доклада о выезде
    // «Начало реагирования» не сохраняется — причина под строкой статуса.
    await expectReportRequired();
    // Попытка записана в журнал карточки (GP-26): её видят лента и разбор.
    await expect
      .poll(async () => {
        const events: { type: string; payload: { state?: string } }[] = await (
          await arm.request.get(`/api/cards/${cardId}/events`)
        ).json();
        return events
          .filter((item) => item.type === "status_denied")
          .map((item) => item.payload.state);
      })
      .toEqual(["responding"]);
    await cardView
      .getByRole("button", { name: "Отменить", exact: true })
      .click();

    // Вводная по частям (GP-05): бригада повторяет адрес и выезжает.
    const line = await briefBrigade(arm, firstBrigade);
    await expect(callHead(line)).toHaveAttribute("data-call-state", "talking");

    // Доклад о выезде выдаётся сразу после вводной. Засчитывается только
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
    const reports = win.getByRole("region", { name: "Доклады бригад" });
    if (first!.state === "presented") {
      expect(first!.presentation_event_id).toBeTruthy();
      // Доклад на линии — в ленте разговора окна телефона, с «Положить трубку».
      await expect(
        line.getByRole("button", { name: "Положить трубку" }),
      ).toBeVisible();
      await expect(line.getByText(report)).toBeVisible();
      // Ответ бригаде — вариантом с реакцией: она повторяет прозвучавший доклад.
      await answer(line)
        .getByRole("button", { name: "Повторите доклад" })
        .click();
      await expect(
        line.getByText(/^Вы сказали:?\s+Повторите доклад\.$/),
      ).toBeVisible();
    } else {
      // Chromium в CI всегда играет через фейковое устройство — там сбой был бы дефектом.
      expect(testInfo.project.name).not.toBe("chromium");
      expect(first!.failure_reason).toBe("playback_error");
      expect(first!.presented_at).toBeNull();
      await expect(line.getByText(report)).toBeVisible();
      await expect(
        line.getByRole("button", { name: "Повторить реплику" }).first(),
      ).toBeVisible();
    }

    await line.getByRole("button", { name: "Положить трубку" }).click();
    await expectEnded(line);
    expect(
      await arm.evaluate(
        () => (window as Window & { micRequests?: number }).micRequests,
      ),
    ).toBe(0);
    await backToContacts(line);
    // Бригада направлена сюда: в контактах её состояние сменилось.
    await expect(
      win.locator(`button[data-state="here"][data-ext="${brigadeExt}"]`),
    ).toHaveCount(1);
    // Доклад нужен и после разговора, когда по нему пишется комментарий в
    // карточке. Значит, он не должен исчезать вместе с разговором.
    if (first!.state === "presented")
      await expect(
        reports.getByRole("listitem").filter({ hasText: report }),
      ).toBeVisible();
    await closePhone(arm);
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
      await expectReportRequired();
    }
  } finally {
    await page.request.post(`/api/sessions/${lesson.id}/finish`, { headers });
    await traineeContext.close();
  }
});
