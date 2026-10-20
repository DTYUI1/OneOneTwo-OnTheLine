// Прохождение тренировки через API (как в practice-outcome.spec.ts): полный ход карточки
// по докладам бригады без открытого АРМ — открытый АРМ сам подтверждает доставку
// и спорит с тестом (409 card_already_delivered).
import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";

type Card = components["schemas"]["Card"];
type Session = components["schemas"]["Session"];
type Brigade = components["schemas"]["Brigade"];
type CallTarget = components["schemas"]["CallTarget"];
type CardTraining = components["schemas"]["CardTraining"];
type Evaluation = components["schemas"]["Evaluation"];

export const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-local";

export async function signIn(page: Page, login: string) {
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(login);
  await page.getByLabel("Пароль").fill(PASSWORD);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  await passWelcome(page);
}

/** Приветствие: у преподавателя «Начать работу», у обучаемого — вход в тренажёр (GP-13). */
export async function passWelcome(page: Page) {
  const enter = page.getByRole("button", {
    name: /^(Начать работу|Перейти в тренажёр|Диспетчер служб)$/,
  });
  await expect(
    enter.or(page.getByRole("button", { name: "Выйти", exact: true })).first(),
  ).toBeVisible();
  if (await enter.first().isVisible()) await enter.first().click();
}

export async function csrf(request: APIRequestContext): Promise<string> {
  return (await request.storageState()).cookies.find(
    (cookie) => cookie.name === "csrf",
  )!.value;
}

export async function send(
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

export async function training(
  request: APIRequestContext,
  cardId: string,
): Promise<CardTraining> {
  return (await request.get(`/api/cards/${cardId}/training`)).json();
}

/**
 * Ступень обучающего упражнения: выезд, прибытие, работы, завершение; занятие завершено.
 * `afterOpen` — свои действия сразу после открытия карточки (например, подсказка).
 */
export async function playTutorial(
  request: APIRequestContext,
  afterOpen?: (cardId: string) => Promise<void>,
): Promise<Card> {
  const started = await request.post(`/api/practice?step=1`, {
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
  await send(request, id, "deliver", {});
  await send(request, id, "open", {});
  await afterOpen?.(id);
  const comment = [card!.source.description, "Направлена бригада."];
  await send(request, id, "status_change", {
    state: "accepted",
    comment: comment.join(" "),
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
    await expect
      .poll(async () => (await training(request, id)).messages.length, {
        timeout: 30_000,
      })
      .toBe(index + 1);
    await send(request, id, "call_hangup", { call_id: callId });
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
    await send(request, id, "status_change", {
      state,
      comment: comment.join(" "),
    });
  }
  await request.post(`/api/sessions/${session.id}/finish`, {
    headers: { "X-CSRF-Token": await csrf(request) },
  });
  await expect
    .poll(
      async () => {
        const list: Evaluation[] = await (
          await request.get("/api/evaluations")
        ).json();
        return list.some((item) => item.card_id === card!.id);
      },
      { timeout: 90_000 },
    )
    .toBe(true);
  return card!;
}
