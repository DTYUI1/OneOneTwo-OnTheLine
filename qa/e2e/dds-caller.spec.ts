import { randomUUID } from "node:crypto";
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { login } from "./captain-fixture";
import {
  answer,
  callHead,
  expectTalking,
  openDial,
  openPhone,
  peerDone,
} from "./phone";

type Card = components["schemas"]["Card"];

// HQ-019 (docs/dds_caller.md, раздел 6): бытовой сценарий ЖКХ «Котёнок в вентиляционной
// шахте», заявитель в телефоне ДДС — растерянная (характер сменил преподаватель). Номер из
// карточки соединяет с заявителем, а не с дежурным: своя реплика вместо «Слушаю вас»,
// переспрашивает, кто звонит, срок — сначала неполно, на уточнение полностью; тишина 8 с —
// «Алло? Вы тут?». Каждая реплика — caller_said в журнале карточки.
const TRAINEE = "trainee03";
const PLACE = 19;
const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-local";
const HOUSEHOLD_CARD = "70008501";

test.skip(process.env.E2E_DATABASE !== "1", "Нужен стенд с БД");

async function csrf(request: APIRequestContext): Promise<string> {
  return (await request.storageState()).cookies.find(
    (cookie) => cookie.name === "csrf",
  )!.value;
}

test("Живой заявитель: своя реплика, «кто звонит», уточнение срока, «Алло, вы тут?»", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "Одна учётная запись обучаемого: браузеры не делят занятие",
  );
  test.setTimeout(180_000);
  const baseURL = testInfo.project.use.baseURL!;
  const teacher = await playwrightRequest.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
  });
  const signed = await teacher.post("/api/auth/login", {
    data: { login: "teacher", password: PASSWORD },
  });
  expect(signed.ok(), await signed.text()).toBeTruthy();
  let sessionId = "";
  try {
    const users: { id: string; login: string }[] = await (
      await teacher.get("/api/users")
    ).json();
    const traineeId = users.find((user) => user.login === TRAINEE)!.id;
    const scenarios: {
      id: string;
      version: number;
      status: string;
      card: { number: string };
    }[] = await (await teacher.get("/api/scenarios")).json();
    const scenario = scenarios
      .filter(
        (item) =>
          item.card.number === HOUSEHOLD_CARD && item.status === "approved",
      )
      .sort((a, b) => b.version - a.version)[0];
    expect(scenario, "animal-shaft-gkh-1").toBeTruthy();
    const settings = await (await teacher.get("/api/settings")).json();
    const created = await teacher.post("/api/sessions", {
      headers: { "X-CSRF-Token": await csrf(teacher) },
      data: {
        title: `Живой заявитель ${Date.now()}`,
        participants: [
          {
            user_id: traineeId,
            workstation_number: PLACE,
            dds_service_id: "GKH",
            level: 1,
          },
        ],
        settings_snapshot: {
          ...settings,
          phone_contacts: {
            GKH: [
              {
                role: "caller",
                name: "Заявитель",
                number: "458",
                character: "confused",
              },
            ],
          },
        },
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    sessionId = (await created.json()).id;
    const batch = await teacher.post(
      `/api/sessions/${sessionId}/assignments/batch`,
      {
        headers: { "X-CSRF-Token": await csrf(teacher) },
        data: {
          request_id: randomUUID(),
          items: [
            {
              participant_id: traineeId,
              scenario_id: scenario!.id,
              scenario_version: scenario!.version,
              order: 1,
              delay_from_start_s: 0,
              delivery_mode: "profile",
            },
          ],
        },
      },
    );
    expect(batch.status(), await batch.text()).toBe(201);
    const started = await teacher.post(`/api/sessions/${sessionId}/start`, {
      headers: { "X-CSRF-Token": await csrf(teacher) },
    });
    expect(started.ok(), await started.text()).toBeTruthy();

    await login(page, TRAINEE);
    let card: Card | undefined;
    await expect
      .poll(
        async () => {
          const cards: Card[] = await (
            await page.request.get("/api/cards")
          ).json();
          card = cards.find((item) => item.session_id === sessionId);
          return card?.id ?? null;
        },
        { timeout: 30_000 },
      )
      .not.toBeNull();
    await page.locator(`[data-card-id="${card!.id}"]`).click();
    const win = await openPhone(page);
    await (await openDial(win)).fill(card!.source.phone_aon);
    await win.getByRole("button", { name: "Позвонить", exact: true }).click();
    await expectTalking(win);
    await expect(callHead(win)).toContainText("Заявитель");
    const feed = win.getByRole("list", { name: /^Разговор/ });
    // Своя реплика заявителя, не «Слушаю вас» дежурного.
    await expect(feed).toContainText("Алло! Да! Кто это?");
    await expect(feed).not.toContainText("Слушаю вас");

    await answer(win).getByRole("button", { name: "По частям" }).click();
    // Вопрос — когда заявитель договорил: так говорит диспетчер.
    const ask = async (text: string) => {
      await peerDone(win);
      await answer(win)
        .getByRole("button", { name: text, exact: true })
        .click();
    };
    await ask("Где вы сейчас?");
    await expect(feed).toContainText("Кто это? Откуда звоните? Я не поняла.");
    await ask("Диспетчер ЖКХ, по вашей заявке.");
    await expect(feed).toContainText("Я в магазин вышла, на минутку.");
    await ask("Когда вы подойдёте?");
    await expect(feed).toContainText("Минут… не знаю, пять? Десять?");
    await ask("Когда вы подойдёте?");
    await expect(feed).toContainText("Пять минут, я рядом, у дома.");
    // Тишина 8 с после реплики — «Алло? Вы тут?».
    await expect(feed).toContainText("Алло? Вы тут? Алло!", {
      timeout: 25_000,
    });

    await expect
      .poll(
        async () => {
          const events = (await (
            await page.request.get(`/api/cards/${card!.id}/events`)
          ).json()) as { type: string; payload: { phrase_id?: string } }[];
          return events
            .filter((event) => event.type === "caller_said")
            .map((event) => event.payload.phrase_id);
        },
        { timeout: 15_000 },
      )
      .toEqual([
        "CALLER_CONFUSED.answer.animal_shaft.1",
        "CALLER_CONFUSED.ask_who.animal_shaft.1",
        "CALLER_CONFUSED.tell_where.animal_shaft.1",
        "CALLER_CONFUSED.tell_eta.animal_shaft.1",
        "CALLER_CONFUSED.tell_eta.animal_shaft.2",
        "CALLER_CONFUSED.no_reply.animal_shaft.1",
      ]);
  } finally {
    if (sessionId)
      await teacher.post(`/api/sessions/${sessionId}/finish`, {
        headers: { "X-CSRF-Token": await csrf(teacher) },
      });
    await teacher.dispose();
  }
});
