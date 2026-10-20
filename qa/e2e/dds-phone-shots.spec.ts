import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import {
  LEARNED_AFTER,
  LEARNED_HINTS,
  learnedKey,
} from "../../apps/web/src/arm/phone/learned";
import { test, login } from "./captain-fixture";
import {
  answer,
  answerRing,
  backToContacts,
  callHead,
  closePhone,
  currentStep,
  expectEnded,
  expectTalking,
  freeBrigade,
  openDial,
  peerDone,
  phoneButton,
  phoneWindow,
} from "./phone";
import { reportByParts } from "./report-parts";

// Снимки окна телефона ДДС (GP-09) для docs/dds_phone_window/ — только по запросу
// (DDS_PHONE_SHOTS=1): состояния окна и панель ДДС на 1366×768 и 1920×1080, рядом —
// те же состояния макета docs/dds_training_review/phone/index.html. Сравнение — в
// docs/dds_phone_window/README.md.
//
// GP-24, снимки «до и после» (docs/dds_phone_window.md): DDS_PHONE_SHOTS_OUT — папка,
// DDS_PHONE_SHOTS_PREFIX — начало имени файла вместо «app», DDS_PHONE_LEARNED=1 —
// обучаемый уже освоил окно: пояснения, которые легко запомнить, спрятаны
// (apps/web/src/arm/phone/learned.ts).
test.skip(
  process.env.E2E_DATABASE !== "1" || process.env.DDS_PHONE_SHOTS !== "1",
  "Снимки — по запросу: E2E_DATABASE=1 DDS_PHONE_SHOTS=1",
);

type Card = components["schemas"]["Card"];
type Scenario = components["schemas"]["Scenario"];
type Session = components["schemas"]["Session"];
type User = components["schemas"]["User"];

const OUT = process.env.DDS_PHONE_SHOTS_OUT ?? "docs/dds_phone_window";
const PREFIX = process.env.DDS_PHONE_SHOTS_PREFIX ?? "app";
const LEARNED = process.env.DDS_PHONE_LEARNED === "1";
const MOCKUP = resolve(
  __dirname,
  "../../docs/dds_training_review/phone/index.html",
);

test.use({
  // Микрофон — поддельное устройство Chromium: видны запись, шкала и «Распознаём…».
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
  permissions: ["microphone"],
});

async function full(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

async function part(target: Locator, name: string) {
  await target.page().waitForTimeout(400);
  await target.screenshot({ path: `${OUT}/${name}.png` });
}

/** Значок телефона с соседями по полосе служб. */
async function dial(page: Page, name: string) {
  const box = (await phoneButton(page).first().boundingBox())!;
  const size = page.viewportSize()!;
  const x = Math.max(0, box.x - 160);
  const y = Math.max(0, box.y - 20);
  await page.waitForTimeout(400);
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: {
      x,
      y,
      width: Math.min(360, size.width - x),
      height: Math.min(box.height + 40, size.height - y),
    },
  });
}

async function status(cardView: Locator, state: string, comment: string) {
  await cardView
    .getByRole("button", { name: "Изменить статус", exact: true })
    .click();
  await cardView.getByLabel("Статус", { exact: true }).selectOption(state);
  const number = cardView.getByLabel(/^Номер (службы|наряда)$/);
  if (await number.isVisible()) await number.fill("102");
  await cardView.getByLabel("Комментарий", { exact: true }).fill(comment);
  await cardView
    .getByRole("button", { name: "Подтвердить", exact: true })
    .click();
  await expect(cardView.getByLabel("Комментарий", { exact: true })).toHaveValue(
    "",
  );
}

/**
 * Занятие trainee05 со сценарием C-04 (доклады бригады о выезде, прибытии, работах):
 * бригада звонит сама — видны входящий вызов и значок со счётчиком.
 */
async function brigadeLesson(request: APIRequestContext) {
  expect(
    (
      await request.post("/api/auth/login", {
        data: {
          login: "teacher",
          password: process.env.DEMO_PASSWORD ?? "demo-local",
        },
      })
    ).ok(),
  ).toBeTruthy();
  const headers = {
    "X-CSRF-Token": (await request.storageState()).cookies.find(
      (cookie) => cookie.name === "csrf",
    )!.value,
  };
  const scenarios: Scenario[] = await (
    await request.get("/api/scenarios")
  ).json();
  const scenario = scenarios.find(
    (item) =>
      item.target_service_id === "102" &&
      item.status === "approved" &&
      (item.teacher_comment ?? "").startsWith("Учебный пример C-04"),
  );
  expect(
    scenario,
    "Нет сценария C-04: выполните app.seed.training",
  ).toBeTruthy();
  const users: User[] = await (await request.get("/api/users")).json();
  const trainee = users.find((user) => user.login === "trainee05")!;
  const settings = await (await request.get("/api/settings")).json();
  const created = await request.post("/api/sessions", {
    headers,
    data: {
      title: `Снимки телефона ДДС ${Date.now()}`,
      participants: [
        {
          user_id: trainee.id,
          workstation_number: 23,
          dds_service_id: "102",
          level: 4,
        },
      ],
      settings_snapshot: { ...settings, hints_level: 1, parallel_cards: 1 },
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const session: Session = await created.json();
  const finish = async () => {
    await request.post(`/api/sessions/${session.id}/finish`, { headers });
  };
  const assigned = await request.post(
    `/api/sessions/${session.id}/assignments`,
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
    (await request.post(`/api/sessions/${session.id}/start`, { headers })).ok(),
  ).toBeTruthy();
  return {
    id: session.id,
    traineeId: trainee.id,
    finish,
    card: undefined as unknown as Card,
  };
}

/**
 * Обучаемый до входа: освоил ли окно (DDS_PHONE_LEARNED=1 — пояснения спрятаны) и
 * флаг «без микрофона» — getUserMedia отвечает «устройство не найдено», пока он поднят.
 */
async function prepare(page: Page, traineeId: string, noMic = false) {
  if (LEARNED)
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [
        learnedKey(traineeId),
        JSON.stringify(
          Object.fromEntries(
            LEARNED_HINTS.map((hint) => [hint, LEARNED_AFTER]),
          ),
        ),
      ] as const,
    );
  await page.addInitScript((off) => {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) return;
    const original = media.getUserMedia.bind(media);
    media.getUserMedia = (constraints) =>
      off
        ? Promise.reject(
            new DOMException("Requested device not found", "NotFoundError"),
          )
        : original(constraints);
  }, noMic);
}

/** Карточка занятия обучаемого: ждём её в реестре и открываем. */
async function openCard(page: Page, lesson: { id: string; card: Card }) {
  await expect
    .poll(async () => {
      const cards: Card[] = await (await page.request.get("/api/cards")).json();
      lesson.card = cards.find((item) => item.session_id === lesson.id)!;
      return lesson.card?.id ?? "";
    })
    .not.toBe("");
  await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
  await expect(
    page.getByRole("region", {
      name: `Происшествие ${lesson.card.source.number}`,
      exact: true,
    }),
  ).toBeVisible();
}

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
]) {
  const size = `${viewport.width}x${viewport.height}`;
  test.describe(`АРМ ДДС ${size}`, () => {
    test.use({ viewport });
    test("панель ДДС и состояния окна телефона", async ({ page, request }) => {
      test.setTimeout(240_000);
      page.setDefaultTimeout(20_000);
      mkdirSync(OUT, { recursive: true });
      const shot = (name: string) => `${PREFIX}-${size}-${name}`;
      const lesson = await brigadeLesson(request);
      await prepare(page, lesson.traineeId);
      try {
        await login(page, "trainee05");
        await expect
          .poll(async () => {
            const cards: Card[] = await (
              await page.request.get("/api/cards")
            ).json();
            lesson.card = cards.find((item) => item.session_id === lesson.id)!;
            return lesson.card?.id ?? "";
          })
          .not.toBe("");
        await expect(
          page.locator(`[data-card-id="${lesson.card.id}"]`),
        ).toBeVisible();
        await full(page, shot("01-panel-list"));

        await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
        const cardView = page.getByRole("region", {
          name: `Происшествие ${lesson.card.source.number}`,
          exact: true,
        });
        await expect(cardView).toBeVisible();
        await full(page, shot("02-panel-card"));

        const win = phoneWindow(page);
        await phoneButton(page).click();
        await expect(win).toBeVisible();
        await full(page, shot("03-panel-card-phone"));
        await part(win, shot("04-contacts"));

        // Звонок в свою службу 102 — номер вручную: гудки, разговор, голос, части, итог.
        await (await openDial(win)).fill("102");
        await win
          .getByRole("button", { name: "Позвонить", exact: true })
          .click();
        await expect(callHead(win)).toHaveAttribute(
          "data-call-state",
          /^(dialing|ringing)$/,
        );
        await part(win, shot("05-dialing"));
        await expectTalking(win);
        const talk = answer(win).getByRole("button", {
          name: "Говорить",
          exact: true,
        });
        await expect(talk).toBeEnabled();
        await peerDone(win);
        await part(win, shot("06-talk-your-turn"));
        // Голос: запись со шкалой громкости, затем распознавание (на стенде без STT —
        // «не понят» и переход к частям).
        await talk.click();
        const stop = answer(win).getByRole("button", {
          name: "Закончить ответ",
        });
        await expect(stop).toBeVisible();
        await page.waitForTimeout(1500);
        await part(win, shot("07-recording"));
        await stop.click();
        await part(win, shot("08-after-voice"));
        await page.waitForTimeout(4000);
        await part(win, shot("09-voice-result"));

        // По частям (после неудачи голоса части уже открыты): ошибка в адресе — служба
        // переспрашивает недостающее одним вопросом.
        await reportByParts(win, ["Кто вы", "Адрес"], ["Адрес"]);
        await part(win, shot("10-report-parts"));
        // Служба 102: карточку не спрашивают (её называют только в звонке в 112).
        await reportByParts(win, ["Что случилось", "Что изменилось"]);
        // Дежурный 102 (персонаж банка) — одной фразой о недостающем адресе.
        await expect(win.getByText("Повторите адрес полностью.")).toBeVisible();
        await part(win, shot("10b-reask"));
        await reportByParts(win, ["Адрес", "Что случилось"]);
        await expectEnded(win);
        await part(win, shot("11-ended"));
        await backToContacts(win);
        await closePhone(page);

        // «Принята» — бригаде можно дать вводную.
        await status(cardView, "accepted", "Принята, направляю бригаду");

        await phoneButton(page).click();
        await freeBrigade(win).click();
        await expectTalking(win);
        const parts = answer(win).getByRole("button", {
          name: "По частям",
          exact: true,
        });
        await expect(parts).toBeEnabled();
        await parts.click();
        // Текущий шаг — в полосе шагов (пояснение «Вводная по частям, шаг …» может
        // быть спрятано, GP-24).
        await expect(currentStep(win, "Адрес")).toBeVisible();
        await part(win, shot("12-brief-parts"));
        const right = answer(win).locator(
          'button[data-reply="brief"][data-correct="true"]',
        );
        await right.click();
        await expect(currentStep(win, "Что случилось")).toBeVisible();
        const checked = page.waitForResponse((response) =>
          response.url().includes("/briefing-check"),
        );
        await right.click();
        // Бригада повторяет адрес, если повтор записан в банке (проверка 17.10: без записи
        // она молчит); снимок — до доклада о выезде. Здесь это только снимок: что повтор
        // звучит, когда запись есть, проверяет service-reply.spec.ts (банковские сценарии).
        const { readback } = (await (await checked).json()) as {
          readback: string | null;
        };
        if (readback)
          await expect(win.getByText(readback, { exact: true })).toBeVisible();
        else await expect(win.getByText(/^Повторяю:/)).toHaveCount(0);
        await win.screenshot({
          path: `${OUT}/${shot("13-brigade-repeats")}.png`,
        });
        // Доклад о выезде прозвучал — отбой, «Начало реагирования»; доклад о прибытии
        // бригада делает сама: входящий вызов.
        await expect
          .poll(
            async () =>
              (
                (await (
                  await page.request.get(
                    `/api/cards/${lesson.card.id}/training`,
                  )
                ).json()) as { messages: { state: string }[] }
              ).messages.filter((item) => item.state === "presented").length,
            { timeout: 60_000 },
          )
          .toBeGreaterThan(0);
        const hang = win.getByRole("button", {
          name: "Положить трубку",
          exact: true,
        });
        if (await hang.isVisible()) await hang.click();
        await backToContacts(win);
        await closePhone(page);
        await status(cardView, "responding", "Бригада выехала");
        await expect(
          page.getByRole("button", { name: /^Телефон: входящих \d+$/ }),
        ).toBeVisible({ timeout: 120_000 });
        await phoneButton(page).click();
        await part(win, shot("14-incoming"));
        await closePhone(page);
        await dial(page, shot("15-dial-ring"));
        await full(page, shot("16-panel-ring"));

        await phoneButton(page).click();
        await answerRing(win);
        await expectTalking(win);
        await page.waitForTimeout(2000);
        await part(win, shot("17-incoming-talk"));
        await win.getByRole("button", { name: "Свернуть телефон" }).click();
        await page.waitForTimeout(1500);
        await dial(page, shot("18-dial-timer"));
        await full(page, shot("19-collapsed"));
      } finally {
        await lesson.finish();
      }
    });

    // Без микрофона (GP-24): звонок в свою службу, «Говорить» — микрофона нет, доклад
    // по частям. Отдельное занятие: на стенде распознавание выключено до конца занятия,
    // и в прежнем звонке «Говорить» уже не показывается.
    test("окно телефона без микрофона", async ({ page, request }) => {
      test.setTimeout(120_000);
      page.setDefaultTimeout(20_000);
      mkdirSync(OUT, { recursive: true });
      const lesson = await brigadeLesson(request);
      await prepare(page, lesson.traineeId, true);
      try {
        await login(page, "trainee05");
        await openCard(page, lesson);
        const win = phoneWindow(page);
        await phoneButton(page).click();
        await (await openDial(win)).fill("102");
        await win
          .getByRole("button", { name: "Позвонить", exact: true })
          .click();
        await expectTalking(win);
        const talk = answer(win).getByRole("button", {
          name: "Говорить",
          exact: true,
        });
        await expect(talk).toBeEnabled();
        // После «Слушаю»: щелчок во время реплики только взвёл бы запись (HQ-052).
        await peerDone(win);
        await talk.click();
        await expect(win.getByText(/Микрофон не найден/)).toBeVisible();
        await expect(
          answer(win).locator('button[data-part="report"]').first(),
        ).toBeVisible();
        await part(win, `${PREFIX}-${size}-21-no-mic`);
      } finally {
        await lesson.finish();
      }
    });
  });
}

test.describe("макет телефона", () => {
  test.use({ viewport: { width: 1366, height: 768 } });
  test("состояния макета", async ({ page }) => {
    test.setTimeout(120_000);
    mkdirSync(OUT, { recursive: true });
    await page.goto(`file://${MOCKUP}`);
    const win = page.locator("#talk");
    const flow = (name: string) =>
      page.locator(`[data-flow="${name}"]`).click();
    const shot = (name: string) =>
      `${PREFIX === "app" ? "" : `${PREFIX}-`}mockup-1366x768-${name}`;
    // GP-24: флажок «освоил окно» — пояснения макета спрятаны.
    if (LEARNED) await page.locator("#learned").check();

    await flow("contacts");
    await full(page, shot("03-panel-card-phone"));
    await part(win, shot("04-contacts"));
    await flow("brief");
    await part(win, shot("05-dialing"));
    const talk = win.locator('[data-act="rec"]');
    await expect(talk).toBeVisible({ timeout: 15_000 });
    await part(win, shot("06-talk-your-turn"));
    await talk.click();
    await page.waitForTimeout(1500);
    await part(win, shot("07-recording"));
    await win.locator('[data-act="stop"]').click();
    await part(win, shot("08-after-voice"));
    await page.waitForTimeout(1500);
    await part(win, shot("09-voice-result"));
    await win.locator('[data-act="parts"]').click();
    await part(win, shot("12-brief-parts"));

    // Доклад в 112 без микрофона: части, переспрос, итог.
    await page.locator("#nomic").check();
    await flow("s112");
    const pick = win.locator("[data-pick]").first();
    await expect(pick).toBeVisible({ timeout: 15_000 });
    await part(win, shot("10-report-parts"));
    for (
      let i = 0;
      i < 6 && !(await win.locator('[data-act="back"]').isVisible());
      i++
    ) {
      if (await pick.isVisible()) await pick.click();
      await page.waitForTimeout(1200);
    }
    await expect(win.locator('[data-act="back"]')).toBeVisible({
      timeout: 20_000,
    });
    await part(win, shot("11-ended"));

    await flow("report");
    await expect(page.locator("#dial.ring")).toBeVisible({ timeout: 10_000 });
    await dial(page, shot("15-dial-ring")).catch(() => undefined);
    await page.locator("#dial").click();
    await part(win, shot("14-incoming"));

    await flow("alarm");
    await expect(win.locator(".ringRow.alarm")).toBeVisible({
      timeout: 15_000,
    });
    await part(win, shot("20-alarm"));
  });
});
