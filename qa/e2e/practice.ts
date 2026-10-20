import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { briefingText } from "./brigade-briefing";

// Самостоятельная тренировка через API (29.09, «Мой путь»): ступени, события карточки и
// прохождение ступени 1. Запросы — от имени обучаемого (его cookie в `request`).

type Card = components["schemas"]["Card"];
type Session = components["schemas"]["Session"];
type Brigade = components["schemas"]["Brigade"];
type CallTarget = components["schemas"]["CallTarget"];
type CardTraining = components["schemas"]["CardTraining"];
type TraineeProgress = components["schemas"]["TraineeProgress"];

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

/** Доставка карточки: открытый АРМ мог подтвердить её раньше теста — это не ошибка. */
export async function deliver(request: APIRequestContext, cardId: string) {
  const response = await request.post(`/api/cards/${cardId}/events`, {
    headers: { "X-CSRF-Token": await csrf(request) },
    data: {
      client_event_id: randomUUID(),
      client_ts: new Date().toISOString(),
      type: "deliver",
      payload: {},
    },
  });
  const text = await response.text();
  expect(response.ok() || text.includes("card_already_delivered"), text).toBe(
    true,
  );
}

export async function startStep(request: APIRequestContext, step: number) {
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
  return { session, card: card! };
}

export async function training(
  request: APIRequestContext,
  cardId: string,
): Promise<CardTraining> {
  return (await request.get(`/api/cards/${cardId}/training`)).json();
}

export async function progress(
  request: APIRequestContext,
): Promise<TraineeProgress> {
  const [own] = (await (
    await request.get("/api/progress")
  ).json()) as TraineeProgress[];
  return own;
}

/** Ступень 1 через API: полный цикл упражнения с докладами — открывает ступень 2. */
export async function passTutorial(request: APIRequestContext) {
  const { session, card } = await startStep(request, 1);
  await closeTutorialCard(
    request,
    card,
    session.participants[0].dds_service_id,
  );
  await request.post(`/api/sessions/${session.id}/finish`, {
    headers: { "X-CSRF-Token": await csrf(request) },
  });
}

/**
 * Упражнение до «Работ завершены» через API: «Принята», вводная, доклады и статусы. Карточку
 * мог уже открыть АРМ (этап из окна наставника) — доставка и открытие тогда не мешают.
 */
export async function closeTutorialCard(
  request: APIRequestContext,
  card: Card,
  serviceId: string,
) {
  await deliver(request, card.id);
  await send(request, card.id, "open", {});
  await send(request, card.id, "status_change", {
    state: "accepted",
    comment: "Принята, направляю бригаду",
  });
  await send(request, card.id, "field_change", {
    field: "service_number",
    value: "15",
  });
  // Адрес ДДС не вводит (DT-14): адрес карточки верен, в комментарии его можно не повторять.
  const comment = [card.source.description, "Направлена бригада."];
  const brigades: Brigade[] = await (
    await request.get(`/api/services/${serviceId}/brigades`)
  ).json();
  const brigade = [...brigades].sort((a, b) => a.name.localeCompare(b.name))[0];
  const targets: CallTarget[] = await (
    await request.get(`/api/services/${serviceId}/call-targets`)
  ).json();
  const target = targets.find((item) => item.brigade_id === brigade.id)!;
  await send(request, card.id, "brigades_select", {
    brigade_ids: [brigade.id],
  });
  const presented = new Set<string>();
  for (const [index, state] of [
    "responding",
    "arrived",
    "working",
    "completed",
  ].entries()) {
    // Бригада могла перезвонить сама (DT-20): её вызов звонит, а второй звонок той же бригаде
    // сервер не даёт («Линия занята», 20.10) — отвечаем на входящий.
    let callId = "";
    for (let attempt = 0; !callId && attempt < 3; attempt++) {
      const ringing = ((await training(request, card.id)).incoming ?? []).find(
        (item) => item.brigade_id === brigade.id,
      );
      if (ringing) {
        callId = ringing.call_id;
        break;
      }
      const dialed = randomUUID();
      const response = await request.post(`/api/cards/${card.id}/events`, {
        headers: { "X-CSRF-Token": await csrf(request) },
        data: {
          client_event_id: randomUUID(),
          client_ts: new Date().toISOString(),
          type: "call_dial_target",
          payload: {
            call_id: dialed,
            call_target_id: target.id,
            brigade_id: brigade.id,
          },
        },
      });
      const text = await response.text();
      if (response.ok()) callId = dialed;
      else expect(text, text).toContain("line_busy");
    }
    expect(callId, "бригаде не дозвониться").not.toBe("");
    await send(request, card.id, "call_answer", { call_id: callId });
    // GP-05: в первом разговоре — вводная, без неё бригада не выезжает.
    if (index === 0)
      await send(request, card.id, "brigade_briefing", {
        call_id: callId,
        mode: "parts",
        text: briefingText(card.source),
      });
    await expect
      .poll(async () => (await training(request, card.id)).messages.length, {
        timeout: 30_000,
      })
      .toBe(index + 1);
    await send(request, card.id, "call_hangup", { call_id: callId });
    for (const { delivery } of (await training(request, card.id)).messages) {
      if (presented.has(delivery.delivery_id)) continue;
      presented.add(delivery.delivery_id);
      comment.push(delivery.message.text);
      const audio = delivery.message.audio;
      await send(request, card.id, "message_presented", {
        delivery_id: delivery.delivery_id,
        playback_id: randomUUID(),
        message_version: delivery.message.version,
        audio_version: audio ? audio.version : null,
        channel: audio ? "audio" : "text",
      });
    }
    await send(request, card.id, "field_change", {
      field: "comment",
      value: comment.join(" "),
    });
    await send(request, card.id, "status_change", {
      state,
      comment: comment.join(" "),
    });
  }
}

/** Ступень 2 открыта: если ступень 1 ещё не пройдена — проходит её через API. */
export async function unlockStep2(request: APIRequestContext) {
  if (!(await progress(request)).steps[1].unlocked) await passTutorial(request);
  await expect
    .poll(async () => (await progress(request)).steps[1].unlocked, {
      timeout: 30_000,
    })
    .toBe(true);
}
