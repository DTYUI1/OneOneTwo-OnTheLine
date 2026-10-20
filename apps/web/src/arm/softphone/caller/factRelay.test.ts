import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type { components } from "../../../api-client/schema";

interface SourceEvent {
  key: string;
  line: { text: string };
  reply_options: { key: string; label: string }[];
}
interface Source {
  service_id: string;
  caller: { plot: string; character: "calm" };
  card: { address: { street: string; house: string } };
  events: SourceEvent[];
}
let server: ViteDevServer;
let browser: Browser;
let origin: string;
beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    base: "/app/",
    cacheDir: "node_modules/.vite-caller-fact-relay",
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
        name: "caller-fact-relay",
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (!request.url?.includes("__caller_fact_relay__")) return next();
            response.setHeader("Content-Type", "text/html");
            response.end("<!doctype html><html><body></body></html>");
          });
        },
      },
    ],
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0];
  browser = await chromium.launch({ headless: true });
}, 30000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

// HTTP/outbox и устройство управляемые; настоящий Softphone, разговор и hold/resume.
it.each(["pipe-access-gkh-2", "lift-location-moslift-2"])(
  "%s: caller facts → return to brigade → actual parts controls relay both answers",
  async (code) => {
    const source = JSON.parse(
      readFileSync(
        new URL(
          `../../../../../../data/scenarios/${code}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Source;
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${origin}__caller_fact_relay__`);
      const handle = await page.evaluateHandle(async (source) => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        window.fetch = async () => Response.json(training);
        const hmod = (await load(
          "/app/src/arm/softphone/hookHarness.tsx",
        )) as typeof import("../hookHarness");
        const { Softphone } = (await load(
          "/app/src/arm/softphone/Softphone.tsx",
        )) as typeof import("../Softphone");
        const { requestLine } = (await load(
          "/app/src/arm/pickup.ts",
        )) as typeof import("../../pickup");
        const { activeCall } = (await load(
          "/app/src/arm/callGuard.ts",
        )) as typeof import("../../callGuard");
        const { useHold } = (await load(
          "/app/src/arm/phone/useHold.ts",
        )) as typeof import("../../phone/useHold");
        const { holdMark } = (await load(
          "/app/src/arm/phone/hold.ts",
        )) as typeof import("../../phone/hold");
        const { PhoneContext, PhoneWindow, usePhoneState } = (await load(
          "/app/src/arm/phone/PhoneWindow.tsx",
        )) as typeof import("../../phone/PhoneWindow");
        const { callerBook } = (await load(
          "/app/src/arm/softphone/caller/book.ts",
        )) as typeof import("./book");
        const h = hmod.sessionHarness();
        const audio = hmod.audioHarness();
        const tick = window.setInterval(() => {
          for (const clip of audio) if (!clip.ended) clip.finish();
        }, 50);
        const cardId = "00000000-0000-4000-8000-000000000010";
        const crew = "00000000-0000-4000-8000-000000000011";
        const target = "00000000-0000-4000-8000-000000000012";
        const originalCall = "00000000-0000-4000-8000-000000000013";
        const book = callerBook("calm", source.caller.plot);
        if (!book) throw new Error("Нет книги заявителя");
        const required =
          source.caller.plot === "pipe_access"
            ? ["where", "eta", "box"]
            : ["where", "box"];
        const factPhrases = new Map(
          required.map((key) => [key, book.slot(`tell_${key}`)[0].id]),
        );
        const heard = new Set<string>();
        const presented = (
          event: SourceEvent,
        ): components["schemas"]["InformationEvidence"] => ({
          state: "presented",
          presented_at: new Date().toISOString(),
          failed_at: null,
          presentation_event_id: crypto.randomUUID(),
          failure_reason: null,
          reply_key: null,
          delivery: {
            delivery_id: crypto.randomUUID(),
            card_id: cardId,
            participant_id: "00000000-0000-4000-8000-000000000014",
            call_id: originalCall,
            brigade_id: crew,
            call_target_id: target,
            delivered_at: new Date().toISOString(),
            message: {
              id: crypto.randomUUID(),
              version: 1,
              text: event.line.text,
              audio: null,
            },
            reply_options: event.reply_options,
            reply_by: new Date(Date.now() + 120000).toISOString(),
          },
        });
        const training: components["schemas"]["CardTraining"] = {
          card_id: cardId,
          revision: 1,
          selected_brigade_ids: [crew],
          caller: source.caller,
          messages: [presented(source.events[0])],
        };
        window.fetch = async () => Response.json(training);
        let stage = 0;
        const update = () =>
          h.client.setQueryData(
            ["card-training", cardId],
            structuredClone(training),
          );
        const outcomes = new Set<
          Parameters<typeof h.realtime.subscribeOutcomes>[0]
        >();
        h.realtime.subscribeOutcomes = (listener) => {
          outcomes.add(listener);
          return () => {
            outcomes.delete(listener);
          };
        };
        h.realtime.enqueue = async (id, event) => {
          h.events.push(event);
          if (event.type === "caller_said") {
            for (const [key, phrase] of factPhrases)
              if (event.payload.phrase_id === phrase) heard.add(key);
            if (heard.size === required.length && stage === 0) {
              stage = 1;
              training.messages.push(presented(source.events[1]));
            }
          }
          if (event.type === "brigade_reply") {
            const message = training.messages.find(
              (item) => item.delivery.delivery_id === event.payload.delivery_id,
            );
            if (message) message.reply_key = event.payload.option_key;
            if (event.payload.option_key === "relay" && stage === 1) {
              stage = 2;
              training.messages.push(presented(source.events[2]));
            } else if (event.payload.option_key === "relay" && stage === 2)
              stage = 3;
          }
          update();
          const item = {
            id: event.client_event_id,
            cardId: id,
            event,
            userId: "review",
            queuedAt: Date.now(),
            sequence: h.events.length,
          };
          for (const listener of outcomes)
            listener({ status: "accepted", item });
        };
        h.client.setQueryData(
          ["services"],
          [
            {
              id: source.service_id,
              name: "Учебная служба",
              phone_ext: "105",
              voice_profile: "denis",
              is_active: true,
            },
          ],
        );
        h.client.setQueryData(["brigades", source.service_id], []);
        h.client.setQueryData(
          ["call-targets", source.service_id],
          [
            {
              id: target,
              brigade_id: crew,
              service_id: source.service_id,
              name: "Бригада",
              phone_ext: "201",
              voice_profile: "denis",
              is_active: true,
            },
          ],
        );
        update();
        h.client.setQueryData(["session", "session"], {
          settings_snapshot: {
            voice_only: false,
            phone_contacts: {
              [source.service_id]: [
                {
                  role: "caller",
                  name: "Заявитель",
                  number: "458",
                  character: "calm",
                },
              ],
            },
          },
        });
        h.client.setQueryData(
          ["cards"],
          [
            {
              id: cardId,
              session_id: "session",
              source: {
                number: "100",
                incident_class: "Учебное происшествие",
                description: "Заявка",
                address: {
                  ...source.card.address,
                  building: "",
                  apartment: "",
                },
                service_ids: [source.service_id],
              },
            },
          ],
        );
        let hold!: ReturnType<typeof useHold>;
        let phone!: ReturnType<typeof usePhoneState>;
        const el = hmod.createElement;
        function Harness() {
          hold = useHold((effect) => {
            if (effect.type !== "resume") return;
            const line = effect.line;
            requestLine({
              kind: "resume",
              cardId: line.cardId,
              callId: line.callId,
              phoneExt: line.phoneExt,
              saved: line.saved ?? null,
              accept: (start) => {
                if (!hold.acceptResume(line.callId, start)) return false;
                void h.realtime.enqueue(
                  line.cardId,
                  holdMark("call_resume", line.callId),
                );
                return true;
              },
            });
          });
          phone = usePhoneState([], [], hold.state);
          return el(
            PhoneContext.Provider,
            { value: phone },
            el(PhoneWindow, {
              title: "Телефон",
              idle: null,
              onAnswer: () => {},
              onHold: () => {
                const line = activeCall()?.hold?.();
                if (!line) return;
                hold.dispatch({ type: "hold", line, at: Date.now() });
                void h.realtime.enqueue(
                  line.cardId,
                  holdMark("call_hold", line.callId),
                );
              },
              onResume: (callId) =>
                hold.dispatch({ type: "resume", callId, at: Date.now() }),
            }),
            el(Softphone, {
              cardId,
              ownServiceId: source.service_id,
              cardState: "arrived",
            }),
          );
        }
        const component = hmod.mountComponent(Harness, {}, h.Wrap);
        phone.show();
        requestLine({
          kind: "resume",
          cardId,
          callId: originalCall,
          phoneExt: "201",
          saved: { lines: [], report: null, said: [], inbound: true },
        });
        return {
          ...h,
          component,
          tick,
          cardId,
          originalCall,
          required,
          get stage() {
            return stage;
          },
        };
      }, source);
      const parts = page.getByRole("button", {
        name: "По частям",
        exact: true,
      });
      await parts.click();
      await page
        .getByRole("button", {
          name: source.events[0].reply_options[0].label,
          exact: true,
        })
        .click();
      await page.getByRole("button", { name: "Удержать", exact: true }).click();
      await page
        .getByRole("button", { name: "К контактам", exact: true })
        .click();
      await page.getByRole("tab", { name: "Набор", exact: true }).click();
      await page
        .getByRole("textbox", { name: "Номер", exact: true })
        .fill("74951050458");
      await page
        .getByRole("button", { name: "Позвонить", exact: true })
        .click();
      await page
        .waitForFunction(
          (r) => r.events.some((event) => event.type === "caller_said"),
          handle,
          { timeout: 20000 },
        )
        .catch(async (error: unknown) => {
          console.error(
            await page.evaluate(
              (r) => ({ events: r.events, body: document.body.innerText }),
              handle,
            ),
          );
          throw error;
        });
      await parts.click();
      await page.locator('[data-caller="intro"]').click();
      for (const key of source.caller.plot === "pipe_access"
        ? ["where", "eta", "box"]
        : ["where", "box"]) {
        await page.locator(`[data-caller="${key}"]`).click();
      }
      await page.waitForFunction((r) => r.stage === 1, handle, {
        timeout: 20000,
      });
      await page
        .getByRole("button", { name: "Положить трубку", exact: true })
        .click();
      await page.getByTitle(/^Снять с удержания:/).click();
      await parts.click();
      for (const event of source.events.slice(1)) {
        await page
          .getByRole("button", {
            name: event.reply_options[0].label,
            exact: true,
          })
          .click();
      }
      await page.waitForFunction((r) => r.stage === 3, handle);
      const relays = await page.evaluate(
        (r) =>
          r.events.flatMap((event) =>
            event.type === "brigade_reply" &&
            event.payload.option_key === "relay"
              ? [event.payload]
              : [],
          ),
        handle,
      );
      expect(relays).toHaveLength(2);
      expect(
        relays.every(
          (payload) =>
            payload.call_id === "00000000-0000-4000-8000-000000000013",
        ),
      ).toBe(true);
      expect(new Set(relays.map((payload) => payload.delivery_id)).size).toBe(
        2,
      );
      expect(errors).toEqual([]);
      await page.evaluate((r) => {
        clearInterval(r.tick);
        r.component.unmount();
      }, handle);
    } finally {
      await page.close();
    }
  },
  90000,
);
