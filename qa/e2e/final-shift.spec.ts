import { randomUUID } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { answerRing, expectTalking, lineTab, openPhone } from "./phone";
import { briefingText } from "./brigade-briefing";

type Card = components["schemas"]["Card"];
type Session = components["schemas"]["Session"];
type Scenario = components["schemas"]["Scenario"];
type CallTarget = components["schemas"]["CallTarget"];
type StoredEvent = components["schemas"]["StoredEvent"];

const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-local";
/** Скриншоты для ручной проверки (HQ-033): окно проверки памяти и ответ без карточки. */
const SHOTS = process.env.E2E_SHOTS_DIR;

async function csrf(request: APIRequestContext) {
  return {
    "X-CSRF-Token": (await request.storageState()).cookies.find(
      (cookie) => cookie.name === "csrf",
    )!.value,
  };
}

async function event(
  page: Page,
  cardId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  const response = await page.request.post(`/api/cards/${cardId}/events`, {
    headers: await csrf(page.request),
    data: {
      client_event_id: randomUUID(),
      client_ts: new Date().toISOString(),
      type,
      payload,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

// Финальная смена (HQ-033, решения 18.10): вызов бригады подписан только бригадой, ответ из
// окна телефона карточку не открывает — разговор идёт в окне; посреди смены — окно
// «Проверка памяти» без паузы, итог пишется в журнал первой карточки. Ждёт минуту после
// последней карточки — ночной прогон.
test(
  "Финальная смена: разговор без карточки и проверка памяти",
  { tag: "@night" },
  async ({ page, request }) => {
    test.skip(
      process.env.E2E_DATABASE !== "1",
      "Нужны PostgreSQL, worker, app.seed.training и явное E2E_DATABASE=1",
    );
    test.setTimeout(300_000);
    page.setDefaultTimeout(15_000);
    // Database-прогоны идут последовательно; используем существующую учётку seed
    // в обоих браузерах, не предполагая несуществующего trainee06.
    const login = "trainee05";

    expect(
      (
        await request.post("/api/auth/login", {
          data: { login: "teacher", password: PASSWORD },
        })
      ).ok(),
    ).toBeTruthy();
    const headers = await csrf(request);
    const users: components["schemas"]["User"][] = await (
      await request.get("/api/users")
    ).json();
    const trainee = users.find((user) => user.login === login)!;
    const scenarios: Scenario[] = await (
      await request.get("/api/scenarios")
    ).json();
    // Учебный набор параллельной смены (seed/training.py): номер 700042N.
    const parallel = scenarios
      .filter(
        (item) =>
          item.status === "approved" && item.card.number.startsWith("7000424"),
      )
      .sort((a, b) => a.card.number.localeCompare(b.card.number));
    test.skip(parallel.length < 2, "Нет учебных сценариев параллельной смены");
    const [first, second] = parallel;
    const settings = await (await request.get("/api/settings")).json();
    const created = await request.post("/api/sessions", {
      headers,
      data: {
        title: `Финальная смена ${Date.now()}`,
        participants: [
          {
            user_id: trainee.id,
            workstation_number: 22,
            dds_service_id: first.target_service_id,
            level: 4,
          },
        ],
        settings_snapshot: {
          ...settings,
          hints_level: 0,
          parallel_cards: 2,
          final_shift: true,
        },
      },
    });
    expect(created.status()).toBe(201);
    const session: Session = await created.json();
    try {
      for (const [order, scenario, delay] of [
        [1, first, 0],
        [2, second, 5_000],
      ] as const) {
        const response = await request.post(
          `/api/sessions/${session.id}/assignments`,
          {
            headers,
            data: {
              participant_id: trainee.id,
              scenario_id: scenario.id,
              order,
              planned_at: new Date(Date.now() + delay).toISOString(),
            },
          },
        );
        expect(response.status()).toBe(201);
      }
      expect(
        (
          await request.post(`/api/sessions/${session.id}/start`, { headers })
        ).ok(),
      ).toBeTruthy();

      await page.goto("/app/login");
      await page.getByLabel("Логин", { exact: true }).fill(login);
      await page.getByLabel("Пароль").fill(PASSWORD);
      await page.getByRole("button", { name: "Войти", exact: true }).click();
      await page
        .getByRole("button", {
          name: /^(Диспетчер служб|Перейти в тренажёр)$/,
        })
        .click();
      const notice = page.getByRole("dialog", { name: "Параллельная работа" });
      await notice.getByRole("button", { name: "Понятно" }).click();

      // Первая карточка: «Принята», бригада получила вводную, трубку положили до доклада о
      // выезде — бригада перезвонит сама.
      let card: Card | undefined;
      await expect
        .poll(
          async () => {
            const cards: Card[] = await (
              await page.request.get("/api/cards")
            ).json();
            card = cards.find(
              (item) =>
                item.session_id === session.id &&
                item.source.number === first.card.number,
            );
            return card?.delivered_at ?? null;
          },
          { timeout: 30_000 },
        )
        .not.toBeNull();
      await event(page, card!.id, "status_change", {
        state: "accepted",
        comment: "Принята",
      });
      const targets: CallTarget[] = await (
        await page.request.get(
          `/api/services/${first.target_service_id}/call-targets`,
        )
      ).json();
      const target = targets.find((item) => item.brigade_id !== null)!;
      await event(page, card!.id, "brigades_select", {
        brigade_ids: [target.brigade_id],
      });
      const dispatch = randomUUID();
      await event(page, card!.id, "call_dial_target", {
        call_id: dispatch,
        call_target_id: target.id,
        brigade_id: target.brigade_id,
      });
      await event(page, card!.id, "call_answer", { call_id: dispatch });
      await event(page, card!.id, "brigade_briefing", {
        call_id: dispatch,
        mode: "parts",
        text: briefingText(card!.source),
      });
      await event(page, card!.id, "call_hangup", { call_id: dispatch });

      // Открыта вторая карточка (X), вызывает бригада первой (Y). Вкладка линии подписана
      // только бригадой. Ответ — разговор в окне телефона, карточка X остаётся на месте, а
      // в окне — только разговор Y: ни контактов, ни набора по X (HQ-033, круг 3).
      const nav = page.getByRole("navigation", {
        name: "Происшествия в работе",
      });
      await nav
        .getByRole("button", {
          name: new RegExp(`Происшествие ${second.card.number}`),
        })
        .click({ timeout: 40_000 });
      const regionX = page.getByRole("region", {
        name: `Происшествие ${second.card.number}`,
        exact: true,
      });
      await expect(regionX).toBeVisible();
      const win = await openPhone(page);
      // Контакты X — кнопки «Позвонить: …» (в окне без карточки они не набираются).
      const dialX = win.getByRole("button", { name: /^Позвонить: / });
      await expect(dialX.first()).toBeVisible();
      const ring = lineTab(win, "ringing");
      await expect(ring).toBeVisible({ timeout: 40_000 });
      await expect(ring).toContainText(target.phone_ext);
      await expect(ring).not.toContainText(first.card.number);
      await answerRing(win);
      await expectTalking(win);
      await expect(lineTab(win, "active")).not.toContainText(first.card.number);
      await expect(regionX).toBeVisible();
      await expect(
        page.getByRole("region", {
          name: `Происшествие ${first.card.number}`,
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(dialX).toHaveCount(0);
      await page.waitForTimeout(3_000);
      await shot(page, "hq033b-answer-no-card");
      // Удержание — контакты и табло сил X снова в окне; снятие — снова только разговор Y.
      await win.getByRole("button", { name: "Удержать", exact: true }).click();
      await expect(dialX.first()).toBeVisible();
      await shot(page, "hq033d-held-contacts-x");
      await lineTab(win, "held").first().click();
      await expectTalking(win);
      await expect(dialX).toHaveCount(0);
      await expect(regionX).toBeVisible();

      // PR3-01: разговор итоговой смены остаётся видимым в реестре, пока обучаемый ищет
      // карточку по номеру бригады; закрытие карточки X не завершает линию Y.
      await regionX
        .getByRole("button", { name: "Закрыть карточку", exact: true })
        .click();
      await expect(page).toHaveURL(/\/app\/arm$/);
      await expect(win).toBeVisible();
      await expectTalking(win);
      await expect(lineTab(win, "active")).toContainText(target.phone_ext);
      // Не только заголовок talking: ответ доступен, а подтверждение уходит именно
      // в разговор карточки Y, не в закрытую карточку X.
      const answer = win.getByRole("group", { name: "Ответ", exact: true });
      await expect(answer).toBeVisible();
      const accepted = answer.getByRole("button", {
        name: "Принял",
        exact: true,
      });
      // ACK появляется после полного доклада; Firefox может закончить аудио позже 5 с.
      await expect(accepted).toBeVisible({ timeout: 20_000 });
      const beforeReply: StoredEvent[] = await (
        await page.request.get(`/api/cards/${card!.id}/events`)
      ).json();
      const answered = beforeReply.findLast(
        (item) =>
          item.type === "call_answer" &&
          (item.payload as { call_id: string }).call_id !== dispatch,
      );
      expect(answered).toBeDefined();
      const incomingCallId = (answered!.payload as { call_id: string }).call_id;
      const confirmations = (events: StoredEvent[]) =>
        events.filter(
          (item) =>
            item.type === "report_confirmed" &&
            (item.payload as { call_id: string }).call_id === incomingCallId,
        ).length;
      const beforeConfirmations = confirmations(beforeReply);
      const confirmation = page.waitForResponse((response) => {
        const sent = response.request();
        return (
          response.url().endsWith(`/api/cards/${card!.id}/events`) &&
          sent.method() === "POST" &&
          sent.postDataJSON()?.type === "report_confirmed"
        );
      });
      await accepted.click();
      const confirmed = await confirmation;
      expect(confirmed.ok(), await confirmed.text()).toBeTruthy();
      expect(confirmed.request().postDataJSON().payload.call_id).toBe(
        incomingCallId,
      );
      // Успешного HTTP-ответа недостаточно: подтверждение должно сохраниться в журнале Y.
      await expect
        .poll(async () => {
          const events: StoredEvent[] = await (
            await page.request.get(`/api/cards/${card!.id}/events`)
          ).json();
          return confirmations(events);
        })
        .toBeGreaterThan(beforeConfirmations);
      await shot(page, "review-final-shift-call-in-registry");

      // Нашёл карточку сам посреди разговора — разговор не обрывается.
      await page
        .getByRole("navigation", { name: "Происшествия в работе" })
        .getByRole("button", {
          name: new RegExp(`Происшествие ${first.card.number}`),
        })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Идёт разговор" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("region", {
          name: `Происшествие ${first.card.number}`,
          exact: true,
        }),
      ).toBeVisible();
      await expectTalking(win);
      await shot(page, "hq033b-answer-card-found");

      // Проверка памяти: минута после последней карточки, линия свободна (или две минуты);
      // пока звонят — не появляется. Не модальная панель: телефон не закрывает, сворачивается.
      const check = page.getByRole("region", { name: "Проверка памяти" });
      await expect(check).toBeVisible({ timeout: 180_000 });
      await expect(check.locator("[data-memory-question]")).toHaveCount(3);
      // Телефон поверх панели: в любой точке окна телефона сверху — оно само.
      const phoneBox = (await win.boundingBox())!;
      const handle = await win.elementHandle();
      for (const [dx, dy] of [
        [0.02, 0.02],
        [0.02, 0.5],
        [0.02, 0.98],
        [0.5, 0.5],
      ])
        expect(
          await page.evaluate(
            ([x, y, phoneEl]) =>
              (phoneEl as Element).contains(document.elementFromPoint(x, y)),
            [
              phoneBox.x + phoneBox.width * dx,
              phoneBox.y + phoneBox.height * dy,
              handle,
            ] as const,
          ),
        ).toBeTruthy();
      await check.getByRole("button", { name: "Свернуть" }).click();
      await expect(check.locator("[data-memory-question]")).toHaveCount(0);
      await check.getByRole("button", { name: "Развернуть" }).click();
      // До ответа журнал не выдаёт верных ответов.
      const sealed: StoredEvent[] = await (
        await page.request.get(`/api/cards/${card!.id}/events`)
      ).json();
      const shown = sealed.find((item) => item.type === "memory_check")!;
      expect(
        (shown.payload.questions as Record<string, unknown>[]).every(
          (question) => !("answer" in question),
        ),
      ).toBeTruthy();
      for (const question of await check
        .locator("[data-memory-question]")
        .all())
        await question.getByRole("button").first().click();
      await shot(page, "hq033c-memory");
      await check.getByRole("button", { name: "Проверить" }).click();
      await expect(check.getByText(/Верно \d из 3\./)).toBeVisible();
      await shot(page, "hq033b-memory-result");
      await check.getByRole("button", { name: "Продолжить смену" }).click();
      await expect(check).toHaveCount(0);

      // Итог — в журнале первой карточки смены.
      const events: StoredEvent[] = await (
        await page.request.get(`/api/cards/${card!.id}/events`)
      ).json();
      expect(events.map((item) => item.type)).toEqual(
        expect.arrayContaining(["memory_check", "memory_check_answer"]),
      );
    } finally {
      await request.post(`/api/sessions/${session.id}/finish`, { headers });
    }
  },
);
