import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    base: "/app/",
    // Параллельные browser-регрессии не должны переоптимизировать чужой кэш.
    cacheDir: "node_modules/.vite-final-review-ack",
    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@tanstack/react-query",
        "react-router-dom",
        "openapi-fetch",
        "idb",
        "ajv",
        "ajv/dist/2020",
        "ajv-formats",
      ],
      noDiscovery: true,
    },
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "final-review-ack",
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url?.includes("__final_review_ack__")) {
              response.setHeader("Content-Type", "text/html");
              response.end("<!doctype html><html><body></body></html>");
            } else next();
          });
        },
      },
    ],
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0];
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

// Никаких подмен confirmsReport, useVoiceReply, useBrigade или Softphone.
// Границы: распознавание HTTP, устройства Audio/MediaRecorder и outbox.enqueue.
const phrases = [
  { text: "Не совсем понял", confirms: false },
  { text: "Не всё понял", confirms: false },
  { text: "Не до конца понял", confirms: false },
  { text: "Не понял, повторите", confirms: false },
  { text: "Принял, не выезжайте", confirms: true },
  { text: "Понял вас", confirms: true },
];

describe.each([false, true])(
  "PR2-02: голосовой ACK, hold/resume=%s",
  (resume) => {
    it.each(phrases)(
      "«$text»",
      async ({ text, confirms }) => {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(`${origin}__final_review_ack__`);
          const result = await page.evaluate(
            async ({ text, confirms, resume }) => {
              const load = new Function("url", "return import(url)") as (
                url: string,
              ) => Promise<unknown>;
              const sleep = (ms = 50) =>
                new Promise((done) => setTimeout(done, ms));
              let recognition = text;
              const requests: {
                path: string;
                method: string;
                audioBytes: number;
              }[] = [];
              // Клиент захватывает fetch при импорте, поэтому HTTP-граница устанавливается первой.
              window.fetch = async (input) => {
                const request = input as Request;
                if (!request.url.endsWith("/voice-reply"))
                  return Response.json([]);
                const audio = (await request.formData()).get("audio");
                requests.push({
                  path: new URL(request.url).pathname,
                  method: request.method,
                  audioBytes: audio instanceof Blob ? audio.size : 0,
                });
                return Response.json({ text: recognition, option_key: null });
              };
              const {
                mountComponent,
                sessionHarness,
                audioHarness,
                microphoneHarness,
              } = (await load(
                "/app/src/arm/softphone/hookHarness.tsx",
              )) as typeof import("./hookHarness");
              const { Softphone } = (await load(
                "/app/src/arm/softphone/Softphone.tsx",
              )) as typeof import("./Softphone");
              const { requestPickup, requestLine } = (await load(
                "/app/src/arm/pickup.ts",
              )) as typeof import("../pickup");
              const { activeCall } = (await load(
                "/app/src/arm/callGuard.ts",
              )) as typeof import("../callGuard");
              const { Wrap, client, events, realtime } = sessionHarness();
              // Эта фикстура распознавания моделирует исправный сервер. Одна запись в очередь
              // не должна давать владение линией или подтверждать доклад.
              type Outcome = import("../../shared/ws/outbox").OutboxOutcome;
              const listeners = new Set<(outcome: Outcome) => void>();
              realtime.subscribeOutcomes = (listener) => {
                listeners.add(listener);
                return () => {
                  listeners.delete(listener);
                };
              };
              realtime.pending = async () => [];
              realtime.enqueue = async (cardId, event) => {
                events.push(event);
                const item = {
                  id: event.client_event_id,
                  userId: "review",
                  cardId,
                  event,
                  queuedAt: Date.now(),
                  sequence: events.length,
                };
                for (const listener of listeners)
                  listener({ item, status: "accepted" });
              };
              const played = audioHarness();
              microphoneHarness();
              client.setQueryData(["brigades", "101"], []);
              client.setQueryData(
                ["call-targets", "101"],
                [
                  {
                    id: "target",
                    brigade_id: "brigade",
                    service_id: "101",
                    name: "Расчёт",
                    phone_ext: "201",
                    voice_profile: "denis",
                    is_active: true,
                  },
                ],
              );
              client.setQueryData(["card-training", "card"], {
                card_id: "card",
                revision: 1,
                selected_brigade_ids: ["brigade"],
                incoming: [
                  {
                    call_id: "incoming",
                    brigade_id: "brigade",
                    call_target_id: "target",
                    started_at: new Date().toISOString(),
                    priority: "normal",
                  },
                ],
                messages: [
                  {
                    state: "delivered",
                    presented_at: null,
                    reply_key: null,
                    delivery: {
                      delivery_id: "report",
                      call_id: "outgoing",
                      brigade_id: "brigade",
                      call_target_id: "target",
                      message: {
                        id: "message",
                        version: 1,
                        text: "Вызов принят, расчёт выехал.",
                        audio: {
                          url: "/report.ogg",
                          duration_ms: 3000,
                          version: 1,
                        },
                      },
                      reply_options: [],
                      reply_by: null,
                    },
                  },
                ],
              });
              const component = mountComponent(
                Softphone,
                {
                  cardId: "card",
                  ownServiceId: "101",
                  callOnly: true,
                  cardState: "accepted",
                },
                Wrap,
              );
              const finishAudio = () =>
                played
                  .filter((audio) => !audio.ended)
                  .forEach((audio) => audio.finish());
              const confirmations = () =>
                events.filter((event) => event.type === "report_confirmed");
              const snapshot = () => ({
                active: activeCall() !== null,
                ack:
                  component.container.querySelector('[data-reply="ack"]') !==
                  null,
                confirmations: confirmations().map((event) => event.payload),
              });
              const click = (label: string) => {
                const button = [
                  ...component.container.querySelectorAll("button"),
                ].find((item) => item.textContent?.trim() === label);
                if (!button || button.disabled)
                  throw new Error(
                    `Нет доступной кнопки «${label}»: ${component.container.textContent}`,
                  );
                button.click();
              };
              const say = async (phrase: string) => {
                recognition = phrase;
                click("Говорить");
                await sleep(80);
                click("Закончить ответ");
                for (
                  let n = 0;
                  n < 40 && !component.container.textContent?.includes(phrase);
                  n++
                )
                  await sleep();
                if (!component.container.textContent?.includes(phrase))
                  throw new Error(`Фраза не прошла через consumer: ${phrase}`);
                await sleep();
              };
              try {
                requestPickup("card", "incoming");
                for (
                  let n = 0;
                  n < 80 &&
                  !played.some((audio) => audio.src === "/report.ogg");
                  n++
                ) {
                  played
                    .filter(
                      (audio) => !audio.ended && audio.src !== "/report.ogg",
                    )
                    .forEach((audio) => audio.finish());
                  await sleep();
                }
                const report = played.find(
                  (audio) => audio.src === "/report.ogg",
                );
                if (!report) throw new Error("Доклад не начался");
                let heldInbound: boolean | undefined;
                if (resume) {
                  const held = activeCall()?.hold?.();
                  if (!held) throw new Error("Разговор не удержан");
                  heldInbound = held.saved?.inbound;
                  await sleep();
                  requestLine({
                    kind: "resume",
                    cardId: "card",
                    callId: held.callId,
                    phoneExt: held.phoneExt,
                    saved: held.saved,
                  });
                  await sleep();
                }
                report.finish();
                for (let n = 0; n < 10; n++) {
                  finishAudio();
                  await sleep();
                }
                // Исходный repro: держим линию дольше 6-секундного таймера тишины.
                if (resume) await sleep(6500);
                const before = snapshot();
                await say(text);
                const after = snapshot();
                // После отрицания можно подтвердить тот же доклад, не начиная новый звонок.
                if (!confirms) {
                  for (let n = 0; n < 10; n++) {
                    finishAudio();
                    await sleep();
                  }
                  await say("Принял, не выезжайте");
                }
                return {
                  before,
                  after,
                  final: snapshot(),
                  heldInbound,
                  requests,
                  events: events.map((event) => ({
                    type: event.type,
                    payload: event.payload,
                  })),
                };
              } finally {
                component.unmount();
              }
            },
            { text, confirms, resume },
          );
          if (process.env.FINAL_REVIEW_ACK_EVIDENCE === "1")
            console.log(
              "FINAL_REVIEW_ACK=" +
                JSON.stringify({ text, confirms, resume, ...result, errors }),
            );
          expect(errors).toEqual([]);
          expect(result.before).toEqual({
            active: true,
            ack: true,
            confirmations: [],
          });
          if (resume) expect(result.heldInbound).toBe(true);
          const expected = (phrase: string) => ({
            call_id: "incoming",
            delivery_id: "report",
            text: phrase,
          });
          expect(result.after.confirmations).toEqual(
            confirms ? [expected(text)] : [],
          );
          expect(result.after.ack).toBe(!confirms);
          expect(result.final.confirmations).toEqual([
            expected(confirms ? text : "Принял, не выезжайте"),
          ]);
          expect(result.requests).toHaveLength(confirms ? 1 : 2);
          for (const request of result.requests) {
            expect(request.path).toBe("/api/calls/incoming/voice-reply");
            expect(request.method).toBe("POST");
            expect(request.audioBytes).toBeGreaterThan(0);
          }
          if (!confirms)
            expect(result.events).toContainEqual({
              type: "brigade_said",
              payload: { call_id: "incoming", text },
            });
        } finally {
          await page.close();
        }
      },
      30_000,
    );
  },
);
