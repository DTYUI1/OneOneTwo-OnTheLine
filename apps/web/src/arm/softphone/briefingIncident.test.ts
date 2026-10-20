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
    cacheDir: "node_modules/.vite-briefing-incident",
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
        name: "briefing-incident-harness",
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url?.includes("__briefing_incident__")) {
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

// Настоящие React, Softphone, useBriefing и useBrigade в Chromium. HTTP, очередь
// и аудиоустройства подменены на границе: это не проверка парсера и БД.
describe("Softphone: meaningful wrong incident is dispatchable", () => {
  it.each([
    { incident: "Драка на улице", correct: false },
    { incident: "Пожар в подъезде", correct: true },
  ])(
    "parts: $incident retains the selected address",
    async ({ incident, correct }) => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}__briefing_incident__`);
        const harness = await page.evaluateHandle(
          async ({ incident, correct }) => {
            const load = new Function("url", "return import(url)") as (
              url: string,
            ) => Promise<unknown>;
            const source = {
              number: "100",
              address: {
                city: "Москва",
                okrug: "",
                district: "",
                apartment: "",
                street: "Тестовая",
                house: "10",
                building: "",
              },
              service_ids: [],
              incident_class: "Пожар в подъезде",
              description: "Учебный пожар",
            };
            const training = {
              card_id: "card",
              revision: 1,
              selected_brigade_ids: [],
              messages: [],
            };
            const requests: { url: string; text: string }[] = [];
            window.fetch = async (value) => {
              const request = value as Request;
              if (request.url.endsWith("/briefing-check")) {
                const body = (await request.json()) as { text: string };
                requests.push({ url: request.url, text: body.text });
                return Response.json({
                  address: "ok",
                  heard_address: "Тестовая, 10",
                  incident: correct,
                  complete: true,
                  readback: "Повторяю: Тестовая, 10.",
                  ask_again: null,
                } satisfies import("./brigade/briefing").BriefingCheck);
              }
              if (request.url.endsWith("/training"))
                return Response.json(training);
              throw new Error(
                `Unexpected HTTP request: ${request.method} ${request.url}`,
              );
            };
            // Подмена сети устанавливается до импорта клиента API.
            const { mountComponent, sessionHarness, audioHarness } =
              (await load(
                "/app/src/arm/softphone/hookHarness.tsx",
              )) as typeof import("./hookHarness");
            const { Softphone } = (await load(
              "/app/src/arm/softphone/Softphone.tsx",
            )) as typeof import("./Softphone");
            const { briefingSteps } = (await load(
              "/app/src/arm/softphone/brigade/briefing.ts",
            )) as typeof import("./brigade/briefing");
            const { requestLine } = (await load(
              "/app/src/arm/pickup.ts",
            )) as typeof import("../pickup");
            // Настоящий генератор вариантов должен предложить неверный повод.
            const callId = Array.from(
              { length: 100 },
              (_, i) => `incident-call-${i}`,
            ).find((seed) =>
              briefingSteps(source, seed)[1].options.some(
                (option) => option.text === incident,
              ),
            );
            if (!callId)
              throw new Error("Production options do not offer the incident");
            const { Wrap, client, events } = sessionHarness();
            const played = audioHarness();
            client.setQueryData(
              ["cards"],
              [{ id: "card", state: "accepted", session_id: null, source }],
            );
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
            client.setQueryData(["card-training", "card"], training);
            const component = mountComponent(
              Softphone,
              { cardId: "card", ownServiceId: "101", cardState: "accepted" },
              Wrap,
            );
            requestLine({
              kind: "resume",
              cardId: "card",
              callId,
              phoneExt: "201",
              saved: { lines: [], report: null, said: [] },
            });
            return { component, events, requests, callId, played };
          },
          { incident, correct },
        );
        await expect
          .poll(async () =>
            page
              .getByRole("button", { name: "По частям", exact: true })
              .isEnabled(),
          )
          .toBe(true);
        await page
          .getByRole("button", { name: "По частям", exact: true })
          .click();
        const address = page.getByRole("button", {
          name: "Тестовая, 10",
          exact: true,
        });
        await address.waitFor({ state: "visible" });
        await address.click();
        const reason = page.getByRole("button", {
          name: incident,
          exact: true,
        });
        await reason.waitFor({ state: "visible" });
        expect(await reason.getAttribute("data-correct")).toBe(String(correct));
        expect(
          await harness.evaluate(
            (h) =>
              h.events.filter((event) => event.type === "brigade_briefing")
                .length,
          ),
        ).toBe(0);
        await reason.click();
        await expect
          .poll(() =>
            harness.evaluate(
              (h) =>
                h.events.filter((event) => event.type === "brigade_briefing")
                  .length,
            ),
          )
          .toBe(1);
        const result = await harness.evaluate((h) => ({
          callId: h.callId,
          requests: h.requests,
          events: h.events.map(({ type, payload }) => ({ type, payload })),
          peer: [...h.component.container.querySelectorAll("li")].map(
            (li) => li.textContent,
          ),
        }));
        const text = `Тестовая, 10. ${incident}`;
        expect(result.requests).toEqual([
          {
            url: expect.stringContaining(
              `/calls/${result.callId}/briefing-check`,
            ),
            text,
          },
        ]);
        expect(
          result.events.filter((event) => event.type === "brigade_briefing"),
        ).toEqual([
          {
            type: "brigade_briefing",
            payload: { call_id: result.callId, mode: "parts", text },
          },
        ]);
        expect(
          result.events.filter((event) => event.type === "brigade_said"),
        ).toEqual([]);
        expect(
          result.peer.some((line) => line?.includes("Повторяю: Тестовая, 10.")),
        ).toBe(true);
        expect(
          result.peer.some((line) =>
            /Что случилось\?|Повторите адрес/.test(line ?? ""),
          ),
        ).toBe(false);
        expect(await page.locator('[data-reply="brief"]').count()).toBe(0);
        await harness.evaluate((h) => h.component.unmount());
      } finally {
        await page.close();
      }
    },
    30_000,
  );
});

// Отдельная проверка накопления голосовых фраз настоящим хуком. HTTP-фикстура
// отвечает на адрес без повода, неверный повод и явную поправку; серверный
// распознаватель здесь не проверяется.
describe("useBriefing: accepted voice address retention", () => {
  it("missing reason does not dispatch; later reason and correction retain address", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__briefing_incident__`);
      const harness = await page.evaluateHandle(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const requests: string[] = [];
        window.fetch = async (value) => {
          const request = value as Request;
          const { text } = (await request.json()) as { text: string };
          requests.push(text);
          return Response.json({
            address: "ok",
            heard_address: "Тестовая, 10",
            incident: requests.length === 3,
            complete: requests.length > 1,
            readback: requests.length > 1 ? "Повторяю: Тестовая, 10." : null,
            ask_again: requests.length === 1 ? "Что случилось?" : null,
          } satisfies import("./brigade/briefing").BriefingCheck);
        };
        const { mountHook } = (await load(
          "/app/src/arm/softphone/hookHarness.tsx",
        )) as typeof import("./hookHarness");
        const { useBriefing } = (await load(
          "/app/src/arm/softphone/brigade/useBriefing.ts",
        )) as typeof import("./brigade/useBriefing");
        const dispatched: {
          callId: string;
          brigadeId: string;
          mode: string;
          text: string;
        }[] = [];
        const answers: (string | null)[] = [];
        const incomplete: string[] = [];
        const hook = mountHook(useBriefing, {
          callId: "voice-call",
          brigadeId: "brigade",
          service: "101",
          needed: true,
          steps: [],
          onSaid: () => {},
          onAnswer: (text) => answers.push(text),
          onIncomplete: (_callId, text) => incomplete.push(text),
          onDispatch: (callId, brigadeId, mode, text) =>
            dispatched.push({ callId, brigadeId, mode, text }),
        });
        hook.current.say("Тестовая, 10");
        return { hook, requests, dispatched, answers, incomplete };
      });
      await expect
        .poll(() => harness.evaluate((h) => h.answers.length))
        .toBe(1);
      expect(
        await harness.evaluate((h) => ({
          dispatched: h.dispatched,
          answers: h.answers,
          incomplete: h.incomplete,
        })),
      ).toEqual({
        dispatched: [],
        answers: ["Что случилось?"],
        incomplete: ["Тестовая, 10"],
      });
      await harness.evaluate((h) => h.hook.current.say("Драка на улице"));
      await expect
        .poll(() => harness.evaluate((h) => h.dispatched.length))
        .toBe(1);
      expect(await harness.evaluate((h) => h.dispatched)).toEqual([
        {
          callId: "voice-call",
          brigadeId: "brigade",
          mode: "voice",
          text: "Тестовая, 10. Драка на улице",
        },
      ]);
      await harness.evaluate((h) =>
        h.hook.current.say("Нет, исправляю: пожар в подъезде"),
      );
      await expect
        .poll(() => harness.evaluate((h) => h.dispatched.length))
        .toBe(2);
      expect(await harness.evaluate((h) => h.requests)).toEqual([
        "Тестовая, 10",
        "Тестовая, 10. Драка на улице",
        "Тестовая, 10. Драка на улице. Нет, исправляю: пожар в подъезде",
      ]);
      expect(await harness.evaluate((h) => h.dispatched[1])).toEqual({
        callId: "voice-call",
        brigadeId: "brigade",
        mode: "voice",
        text: "Тестовая, 10. Драка на улице. Нет, исправляю: пожар в подъезде",
      });
      expect(await harness.evaluate((h) => h.answers)).toEqual([
        "Что случилось?",
        "Повторяю: Тестовая, 10.",
        "Повторяю: Тестовая, 10.",
      ]);
      await harness.evaluate((h) => h.hook.unmount());
    } finally {
      await page.close();
    }
  }, 30_000);
});
