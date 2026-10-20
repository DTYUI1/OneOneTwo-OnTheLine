import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { csrf, PASSWORD, playTutorial, send, training } from "./practice-play";

type Card = components["schemas"]["Card"];
type Session = components["schemas"]["Session"];
type Brigade = components["schemas"]["Brigade"];
type CallTarget = components["schemas"]["CallTarget"];

// GP-15, TC-09: доклад бригады в тренировке звучит набором голосов по телефону (data/voices/dds-v3).
const manifest: { messages: { path: string; sha256: string }[] } = JSON.parse(
  readFileSync(join(process.cwd(), "data/voices/dds-v3/manifest.json"), "utf8"),
);
const NEW_VOICES = new Set(manifest.messages.map((item) => item.sha256));

test("Тренировка: доклад бригады озвучен набором dds-v3", async ({
  request,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker, app.seed.training и явное E2E_DATABASE=1",
  );
  test.skip(
    testInfo.project.name !== "chromium",
    "Одна учётка обучаемого: браузеры не делят занятия",
  );
  test.setTimeout(240_000);
  // Без открытого АРМ: он сам подтверждает доставку и спорит с тестом (practice-play.ts).
  const login = await request.post("/api/auth/login", {
    data: { login: "trainee04", password: PASSWORD },
  });
  expect(login.ok()).toBeTruthy();
  // Ступень 1 — обучающее упражнение (свой набор brigade/), сценарии ДДС — со ступени 2.
  await playTutorial(request);
  const started = await request.post("/api/practice?step=2", {
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
  await send(request, id, "status_change", {
    state: "accepted",
    comment: `${card!.source.description} Направлена бригада.`,
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
    .toBeGreaterThan(0);
  const [{ delivery }] = (await training(request, id)).messages;
  const audio = delivery.message.audio;
  expect(audio, delivery.message.text).toBeTruthy();
  const sound = await request.get(audio!.url);
  expect(sound.ok(), await sound.text()).toBeTruthy();
  const digest = createHash("sha256")
    .update(await sound.body())
    .digest("hex");
  expect(digest).toBe(audio!.sha256);
  expect(NEW_VOICES.has(digest), delivery.message.text).toBe(true);
  await send(request, id, "call_hangup", { call_id: callId });
  await request.post(`/api/sessions/${session.id}/finish`, {
    headers: { "X-CSRF-Token": await csrf(request) },
  });
});
