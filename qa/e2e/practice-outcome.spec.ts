import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { briefingText } from "./brigade-briefing";

type Card = components["schemas"]["Card"];
type Session = components["schemas"]["Session"];
type Brigade = components["schemas"]["Brigade"];
type CallTarget = components["schemas"]["CallTarget"];
type CardTraining = components["schemas"]["CardTraining"];
type Evaluation = components["schemas"]["Evaluation"];

// DT-08, GP-27: после закрытой карточки тренировки разбор говорит «Что было дальше» — исход
// самого сценария (блок outcome файла data/scenarios), а у сценария без блока — исход
// тренировки data/practice по номеру карточки. Ступени проходятся через API без открытого АРМ: открытый
// АРМ сам подтверждает доставку и спорит с тестом (409 card_already_delivered).
const OWNER = "trainee03";
const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-local";

interface Incident {
  order: number;
  key: string;
  outcome: { people: string };
}
const incidents: Incident[] = readdirSync(join(process.cwd(), "data/practice"))
  .filter((name) => name.endsWith(".json"))
  .map((name) =>
    JSON.parse(
      readFileSync(join(process.cwd(), "data/practice", name), "utf8"),
    ),
  );

interface ScenarioFile {
  version: number;
  card: { number: string };
  outcome?: { people: string };
}
/** Исход сценария по номеру карточки: последняя версия файла data/scenarios с блоком outcome. */
function scenarioOutcome(number: string): string | undefined {
  const dir = join(process.cwd(), "data/scenarios");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map(
      (name) =>
        JSON.parse(readFileSync(join(dir, name), "utf8")) as ScenarioFile,
    )
    .filter((file) => file.card.number === number && file.outcome)
    .sort((a, b) => b.version - a.version)[0]?.outcome?.people;
}

async function csrf(request: APIRequestContext): Promise<string> {
  return (await request.storageState()).cookies.find(
    (cookie) => cookie.name === "csrf",
  )!.value;
}

async function send(
  request: APIRequestContext,
  cardId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  const response = await request.post(`/api/cards/${cardId}/events`, {
    headers: { "X-CSRF-Token": await csrf(request) },
    data: {
      client_event_id: randomUUID(),
      client_ts: new Date().toISOString(),
      type,
      payload,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function training(
  request: APIRequestContext,
  cardId: string,
): Promise<CardTraining> {
  return (await request.get(`/api/cards/${cardId}/training`)).json();
}

/** Ступень через API: полный ход карточки по докладам бригады, занятие завершено. */
async function playStep(
  request: APIRequestContext,
  step: number,
): Promise<Card> {
  const started = await request.post(`/api/practice?step=${step}`, {
    headers: { "X-CSRF-Token": await csrf(request) },
  });
  expect(started.ok(), await started.text()).toBeTruthy();
  const session: Session = await started.json();
  let card: Card | undefined;
  await expect
    .poll(
      async () => {
        const cards: Card[] = await (await request.get("/api/cards")).json();
        card = cards.find((item) => item.session_id === session.id);
        return card?.id ?? null;
      },
      { timeout: 20_000 },
    )
    .not.toBeNull();
  const id = card!.id;
  const serviceId = session.participants[0].dds_service_id;
  const address = card!.source.address;
  await send(request, id, "deliver", {});
  await send(request, id, "open", {});
  const comment = [card!.source.description, "Направлена бригада."];
  await send(request, id, "status_change", {
    state: "accepted",
    comment: comment.join(" "),
  });
  await send(request, id, "field_change", {
    field: "service_number",
    value: "15",
  });
  await send(request, id, "field_change", {
    field: "address",
    value: {
      city: address.city,
      street: address.street,
      house: address.house,
      building: address.building,
      apartment: address.apartment,
    },
  });
  const brigades: Brigade[] = await (
    await request.get(`/api/services/${serviceId}/brigades`)
  ).json();
  const brigade = [...brigades].sort((a, b) => a.name.localeCompare(b.name))[0];
  const targets: CallTarget[] = await (
    await request.get(`/api/services/${serviceId}/call-targets`)
  ).json();
  const target = targets.find((item) => item.brigade_id === brigade.id)!;
  await send(request, id, "brigades_select", { brigade_ids: [brigade.id] });
  const presented = new Set<string>();
  for (const [index, state] of [
    "responding",
    "arrived",
    "working",
    "completed",
  ].entries()) {
    const callId = randomUUID();
    await send(request, id, "call_dial_target", {
      call_id: callId,
      call_target_id: target.id,
      brigade_id: brigade.id,
    });
    await send(request, id, "call_answer", { call_id: callId });
    // GP-05: в первом разговоре — вводная, без неё бригада не выезжает.
    if (index === 0)
      await send(request, id, "brigade_briefing", {
        call_id: callId,
        mode: "parts",
        text: briefingText(card!.source),
      });
    // Ждём доклад о самом этапе, а не «ещё одно сообщение»: между докладами бригада может
    // спросить своё (DT-10, «Заявитель нас встретит?»). Предъявленное — в комментарий.
    await expect
      .poll(
        async () => {
          for (const { delivery } of (await training(request, id)).messages) {
            if (presented.has(delivery.delivery_id)) continue;
            presented.add(delivery.delivery_id);
            comment.push(delivery.message.text);
            const audio = delivery.message.audio;
            await send(request, id, "message_presented", {
              delivery_id: delivery.delivery_id,
              playback_id: randomUUID(),
              message_version: delivery.message.version,
              audio_version: audio ? audio.version : null,
              channel: audio ? "audio" : "text",
            });
          }
          return (await training(request, id)).missing_report_states ?? [];
        },
        { timeout: 45_000 },
      )
      .not.toContain(state);
    await send(request, id, "call_hangup", { call_id: callId });
    await send(request, id, "status_change", {
      state,
      comment: comment.join(" "),
    });
  }
  await request.post(`/api/sessions/${session.id}/finish`, {
    headers: { "X-CSRF-Token": await csrf(request) },
  });
  return card!;
}

test("Тренировка: в разборе — «Что было дальше» из сценария", async ({
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
  test.setTimeout(240_000);
  page.setDefaultTimeout(15_000);
  // Вход — только ради cookie: АРМ не открываем, пока ступени идут через API.
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(OWNER);
  await page.getByLabel("Пароль").fill(PASSWORD);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  await page.goto("about:blank");
  const request = page.request;

  const [progress] = await (await request.get("/api/progress")).json();
  if (!progress.steps[1].unlocked) await playStep(request, 1);
  const card = await playStep(request, 2);
  // Ступень 2 — полный ход готового происшествия: 70005{происшествие}{служба}1.
  const match = /^70005(\d)\d1$/.exec(card.source.number);
  expect(match, card.source.number).not.toBeNull();
  const incident = incidents.find((item) => String(item.order) === match![1])!;
  await expect
    .poll(
      async () => {
        const list: Evaluation[] = await (
          await request.get("/api/evaluations")
        ).json();
        return list.some((item) => item.card_id === card.id);
      },
      { timeout: 90_000 },
    )
    .toBe(true);

  // Занятия завершены — АРМ больше ничего не доставит; дальше путь как у обучаемого.
  await page.goto("/app/arm");
  await page
    .getByRole("button", { name: /^(Диспетчер служб|Перейти в тренажёр)$/ })
    .click();
  await page.getByRole("link", { name: "Мои результаты" }).click();
  // Список — по времени закрытия, свежая сверху: тот же сценарий мог выпасть раньше.
  await page
    .getByRole("navigation", { name: "Закрытые карточки" })
    .getByRole("button", { name: new RegExp(card.source.number) })
    .first()
    .click();
  await expect(
    page.getByRole("heading", {
      name: new RegExp(`Происшествие ${card.source.number}`),
    }),
  ).toBeVisible();
  const outcome = page.getByRole("region", { name: "Что было дальше" });
  await expect(outcome).toBeVisible({ timeout: 30_000 });
  // Реакция и статусы через API — в нормативе и по докладам: только исход для людей.
  await expect(outcome).toContainText(
    scenarioOutcome(card.source.number) ?? incident.outcome.people,
  );
  await expect(outcome).not.toContainText("позже норматива");
  await expect(outcome).toContainText("Учебная иллюстрация");
});
