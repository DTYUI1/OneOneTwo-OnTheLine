import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, type Browser } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    base: "/app/",
    cacheDir: "node_modules/.vite-phone-review",
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
        name: "review-harness",
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url?.includes("__review__")) {
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
  browser = await (
    process.env.PHONE_REVIEW_BROWSER === "firefox" ? firefox : chromium
  ).launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe("очередь реплик настоящего Softphone (PR2-04, PR2-05)", () => {
  it.each(["unmount", "replay", "hangup"] as const)(
    "%s: очередь принадлежит только живому разговору",
    async (action) => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}__review__`);
        const result = await page.evaluate(async (action) => {
          const load = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<unknown>;
          const base = "/app/src/arm/softphone/";
          const { mountComponent, sessionHarness, audioHarness } = (await load(
            base + "hookHarness.tsx",
          )) as typeof import("./hookHarness");
          const { Softphone } = (await load(
            base + "Softphone.tsx",
          )) as typeof import("./Softphone");
          const { requestLine } = (await load(
            "/app/src/arm/pickup.ts",
          )) as typeof import("../pickup");
          const { introPhrase, confirmRequestPhrase } = (await load(
            base + "brigade/incoming.ts",
          )) as typeof import("./brigade/incoming");
          const played = audioHarness();
          const { Wrap, client } = sessionHarness();
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
            messages: [
              {
                state: "presented",
                presented_at: "2026-10-18T10:00:00Z",
                reply_key: null,
                delivery: {
                  delivery_id: "question",
                  call_id: "old-call",
                  brigade_id: "brigade",
                  call_target_id: "target",
                  message: {
                    id: "message",
                    version: 1,
                    text: `${introPhrase("101")} ${confirmRequestPhrase("101")}`,
                    audio: null,
                  },
                  reply_options: [{ key: "ok", label: "Принял" }],
                  reply_by: null,
                },
              },
            ],
          });
          const component = mountComponent(
            Softphone,
            { cardId: "card", ownServiceId: "101", cardState: "accepted" },
            Wrap,
          );
          requestLine({
            kind: "resume",
            cardId: "card",
            callId: "new-call",
            phoneExt: "201",
            saved: {
              lines: [
                {
                  id: "history",
                  who: "peer",
                  text: "Прежний доклад",
                  replay: {
                    kind: "report",
                    deliveryId: "history",
                    url: "/history.ogg",
                    durationMs: 1000,
                  },
                },
              ],
              report: null,
              said: [],
              inbound: true,
            },
          });
          await new Promise((done) => setTimeout(done, 100));
          const started = played.length;
          if (action === "unmount") component.unmount();
          else if (action === "hangup")
            component.container
              .querySelector<HTMLButtonElement>(
                '[aria-label="Положить трубку"]',
              )!
              .click();
          else
            component.container
              .querySelector<HTMLButtonElement>(
                '[aria-label="Повторить реплику"]',
              )!
              .click();
          await new Promise((done) => setTimeout(done, 50));
          const after = {
            count: played.length,
            firstPaused: played[0]?.paused,
          };
          if (action === "replay") {
            played[1]!.finish();
            played[0]!.finish();
            await new Promise((done) => setTimeout(done, 30));
          }
          if (action !== "unmount") component.unmount();
          await new Promise((done) => setTimeout(done, 30));
          return { started, after, finalCount: played.length };
        }, action);
        expect(result.started).toBe(1);
        expect(result.after).toEqual(
          action === "replay"
            ? { count: 2, firstPaused: false }
            : { count: 1, firstPaused: true },
        );
        expect(result.finalCount).toBe(action === "replay" ? 3 : 1);
      } finally {
        await page.close();
      }
    },
    30_000,
  );
});

describe("быстрая фраза Повторите доклад", () => {
  it.each(["hangup", "hold", "failed", "played"] as const)(
    "%s: вопрос только после живого повтора",
    async (action) => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}__review__`);
        const result = await page.evaluate(async (action) => {
          const load = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<unknown>;
          const { mountComponent, sessionHarness, audioHarness } = (await load(
            "/app/src/arm/softphone/hookHarness.tsx",
          )) as typeof import("./hookHarness");
          const { Softphone } = (await load(
            "/app/src/arm/softphone/Softphone.tsx",
          )) as typeof import("./Softphone");
          const { requestLine } = (await load(
            "/app/src/arm/pickup.ts",
          )) as typeof import("../pickup");
          const { activeCall } = (await load(
            "/app/src/arm/callGuard.ts",
          )) as typeof import("../callGuard");
          const { confirmRequestPhrase } = (await load(
            "/app/src/arm/softphone/brigade/incoming.ts",
          )) as typeof import("./brigade/incoming");
          const sleep = () => new Promise((done) => setTimeout(done, 40));
          const played = audioHarness();
          const { Wrap, client } = sessionHarness();
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
            messages: [
              {
                state: "delivered",
                presented_at: null,
                reply_key: null,
                delivery: {
                  delivery_id: "current",
                  call_id: "call",
                  brigade_id: "brigade",
                  call_target_id: "target",
                  message: {
                    id: "message",
                    version: 1,
                    text: "Докладываю обстановку",
                    audio: {
                      url: "/history.ogg",
                      duration_ms: 1000,
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
            { cardId: "card", ownServiceId: "101", cardState: "accepted" },
            Wrap,
          );
          requestLine({
            kind: "resume",
            cardId: "card",
            callId: "call",
            phoneExt: "201",
            saved: {
              lines: [
                {
                  id: "history",
                  who: "peer",
                  text: "Прежний доклад",
                  replay: {
                    kind: "report",
                    deliveryId: "history",
                    url: "/history.ogg",
                    durationMs: 1000,
                  },
                },
              ],
              report: null,
              said: [],
              inbound: true,
            },
          });
          await sleep();
          for (let n = 0; n < 65; n++) {
            played
              .filter((audio) => !audio.ended)
              .forEach((audio) => audio.finish());
            await sleep();
          }
          const count = () =>
            [...component.container.querySelectorAll("li")].filter((li) =>
              li.textContent?.includes(confirmRequestPhrase("101")),
            ).length;
          const before = count();
          const button = component.container.querySelector<HTMLButtonElement>(
            '[data-reply="repeat"]',
          );
          if (!button)
            throw new Error(
              component.container.textContent ?? "Нет быстрой фразы",
            );
          button.click();
          await sleep();
          const replay = played.at(-1)!;
          if (action === "hangup")
            component.container
              .querySelector<HTMLButtonElement>(
                '[aria-label="Положить трубку"]',
              )!
              .click();
          else if (action === "hold") activeCall()!.hold!();
          else if (action === "failed") {
            replay.dispatchEvent(new Event("error"));
            await new Promise((done) => setTimeout(done, 1500));
          } else replay.finish();
          await sleep();
          const after = count();
          const source = replay.src;
          component.unmount();
          return { before, after, source };
        }, action);
        expect(result.source).toBe("/history.ogg");
        expect(result.before).toBe(1);
        expect(result.after).toBe(action === "played" ? 2 : 1);
      } finally {
        await page.close();
      }
    },
    30_000,
  );
});

describe("lossless resume в настоящем ArmPage", () => {
  it("TTL оставляет удержанный снимок и не отправляет call_resume", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__review__`);
      const result = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const { mountComponent, sessionHarness, MemoryRouter, createElement } =
          (await load(
            "/app/src/arm/softphone/hookHarness.tsx",
          )) as typeof import("./hookHarness");
        const { ArmPage } = (await load(
          "/app/src/arm/ArmPage.tsx",
        )) as typeof import("../ArmPage");
        const { takeLine, LINE_WAIT_MS } = (await load(
          "/app/src/arm/pickup.ts",
        )) as typeof import("../pickup");
        const { Wrap, client, events } = sessionHarness();
        client.setQueryData(["cards"], []);
        client.setQueryData(["sessions"], []);
        client.setQueryData(["progress"], null);
        const saved = {
          lines: [{ id: "said", who: "you", text: "Тестовый адрес" }],
          report: null,
          said: [],
          earlier: ["Тестовый адрес"],
        };
        const line = {
          cardId: "missing-card",
          callId: "held",
          phoneExt: "101",
          kind: "service",
          who: "Служба 101",
          cardNumber: "100",
          heldAt: Date.now(),
          saved,
        };
        sessionStorage.setItem("dds-hold:review", JSON.stringify([line]));
        const component = mountComponent(ArmPage, {}, ({ children }) =>
          createElement(
            Wrap,
            null,
            createElement(MemoryRouter, null, children),
          ),
        );
        await new Promise((done) => setTimeout(done, 80));
        const buttons = [
          ...document.querySelectorAll<HTMLButtonElement>("button"),
        ];
        const resume = buttons.find((button) =>
          button.textContent?.includes("на удержании"),
        );
        if (!resume)
          throw new Error(
            buttons
              .map((button) => button.textContent + ":" + button.title)
              .join(";"),
          );
        resume.click();
        await new Promise((done) => setTimeout(done, 40));
        const pending = sessionStorage.getItem("dds-hold:review");
        const now = Date.now;
        Date.now = () => now() + LINE_WAIT_MS + 1;
        const expired = takeLine(line.cardId, () => true);
        Date.now = now;
        const after = sessionStorage.getItem("dds-hold:review");
        component.unmount();
        return {
          pending: JSON.parse(pending ?? "null"),
          after: JSON.parse(after ?? "null"),
          expired,
          events: events.map((event) => event.type),
          line,
        };
      });
      expect(result.pending).toEqual([result.line]);
      expect(result.after).toEqual([result.line]);
      expect(result.expired).toBeNull();
      expect(result.events).not.toContain("call_resume");
    } finally {
      await page.close();
    }
  }, 30_000);
});

describe("намерение resume в mounted ArmPage", () => {
  it.each(["help", "own", "after-own", "line"] as const)(
    "%s: поздний GET не переигрывает выбор пользователя",
    async (action) => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}__review__`);
        const result = await page.evaluate(async (action) => {
          const load = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<unknown>;
          const pending = new Map<string, (response: Response) => void>();
          window.fetch = async (value) => {
            const request = value as Request;
            if (!request.url.includes("/calls/")) return Response.json([]);
            return new Promise<Response>((resolve) =>
              pending.set(request.url.split("/").at(-1)!, resolve),
            );
          };
          const {
            mountComponent,
            sessionHarness,
            audioHarness,
            MemoryRouter,
            Routes,
            Route,
            useLocation,
            createElement,
          } = (await load(
            "/app/src/arm/softphone/hookHarness.tsx",
          )) as typeof import("./hookHarness");
          const { ArmPage } = (await load(
            "/app/src/arm/ArmPage.tsx",
          )) as typeof import("../ArmPage");
          const { Softphone } = (await load(
            "/app/src/arm/softphone/Softphone.tsx",
          )) as typeof import("./Softphone");
          const { activeCall } = (await load(
            "/app/src/arm/callGuard.ts",
          )) as typeof import("../callGuard");
          const { Wrap, client, events } = sessionHarness();
          audioHarness();
          for (const key of ["cards", "sessions"])
            client.setQueryData([key], []);
          client.setQueryData(["progress"], null);
          const line = {
            cardId: "held-card",
            callId: "held",
            phoneExt: "101",
            kind: "service",
            who: "Первая служба",
            cardNumber: "100",
            heldAt: Date.now(),
            saved: {
              lines: [],
              report: null,
              said: [],
              earlier: ["Сохраненный адрес"],
            },
          };
          const other = {
            ...line,
            callId: "other",
            cardId: "other-card",
            who: "Вторая служба",
          };
          const initial = action === "line" ? [line, other] : [line];
          sessionStorage.setItem("dds-hold:review", JSON.stringify(initial));
          let path = "";
          function App() {
            path = useLocation().pathname;
            return createElement(
              Routes,
              null,
              createElement(Route, {
                path: "/arm/*",
                element: createElement(ArmPage),
              }),
            );
          }
          const arm = mountComponent(App, {}, ({ children }) =>
            createElement(
              Wrap,
              null,
              createElement(
                MemoryRouter,
                { initialEntries: ["/arm"] },
                children,
              ),
            ),
          );
          const sleep = () => new Promise((done) => setTimeout(done, 70));
          const click = (text: string) => {
            const button = [
              ...document.querySelectorAll<HTMLButtonElement>("button"),
            ].find((button) => button.textContent?.includes(text));
            if (!button) throw new Error(`Нет кнопки ${text}`);
            button.click();
          };
          await sleep();
          click("Первая служба");
          await sleep();
          const requested = pending.has("held");
          if (action === "help") {
            click("Справка");
            await sleep();
          }
          if (action === "line") {
            click("Вторая служба");
            await sleep();
          }
          const before = path;
          pending.get("held")!(
            Response.json({
              id: "held",
              card_id: "held-card",
              state: "talking",
            }),
          );
          await sleep();
          const afterGet = path;
          if (action === "after-own") {
            // Навигация роутером после собственного перехода, пока получатель ещё не готов.
            const back = [
              ...document.querySelectorAll<HTMLButtonElement>("button"),
            ].find((button) => button.textContent?.includes("ГБУ Система 112"));
            if (!back) throw new Error("Нет возврата к реестру");
            back.click();
            await sleep();
            click("Справка");
            await sleep();
          }
          client.setQueryData(["brigades", "101"], []);
          client.setQueryData(
            ["call-targets", "101"],
            [
              {
                id: "target",
                brigade_id: null,
                phone_ext: "101",
                is_active: true,
              },
            ],
          );
          client.setQueryData(["card-training", "held-card"], {
            card_id: "held-card",
            revision: 1,
            selected_brigade_ids: [],
            messages: [],
          });
          const recipient = mountComponent(
            Softphone,
            { cardId: "held-card", ownServiceId: "101" },
            Wrap,
          );
          await sleep();
          const accepted = activeCall()?.hold?.()?.saved?.earlier ?? null;
          const stored = JSON.parse(
            sessionStorage.getItem("dds-hold:review") ?? "null",
          );
          const resumes = events.filter(
            (event) => event.type === "call_resume",
          ).length;
          recipient.unmount();
          arm.unmount();
          return {
            requested,
            before,
            afterGet,
            final: path,
            accepted,
            stored,
            initial,
            resumes,
          };
        }, action);
        expect(result.requested).toBe(true);
        expect(result.afterGet).toBe(
          action === "help"
            ? "/arm/reference"
            : action === "line"
              ? "/arm"
              : "/arm/cards/held-card",
        );
        expect(result.accepted).toEqual(
          action === "own" ? ["Сохраненный адрес"] : null,
        );
        expect(result.resumes).toBe(action === "own" ? 1 : 0);
        expect(result.stored).toEqual(action === "own" ? null : result.initial);
      } finally {
        await page.close();
      }
    },
    30_000,
  );
});

describe("передача удержания получателю", () => {
  it.each([
    "ready",
    "ended",
    "offline",
    "double",
    "late",
    "cancel",
    "wrong",
    "queued",
  ] as const)(
    "%s: сервер и готовность проверяются до снятия",
    async (action) => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}__review__`);
        const result = await page.evaluate(async (action) => {
          const load = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<unknown>;
          const sleep = () => new Promise((done) => setTimeout(done, 70));
          window.fetch = async (value) => {
            if (!(value as Request).url.includes("/calls/"))
              return new Response("[]", {
                headers: { "Content-Type": "application/json" },
              });
            if (action === "offline") throw new Error("Нет сети");
            return new Response(
              JSON.stringify({
                id: "held",
                card_id: "missing-card",
                state: action === "ended" ? "ended" : "talking",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          };
          const {
            mountComponent,
            sessionHarness,
            audioHarness,
            MemoryRouter,
            createElement,
          } = (await load(
            "/app/src/arm/softphone/hookHarness.tsx",
          )) as typeof import("./hookHarness");
          const { ArmPage } = (await load(
            "/app/src/arm/ArmPage.tsx",
          )) as typeof import("../ArmPage");
          const { Softphone } = (await load(
            "/app/src/arm/softphone/Softphone.tsx",
          )) as typeof import("./Softphone");
          const { activeCall } = (await load(
            "/app/src/arm/callGuard.ts",
          )) as typeof import("../callGuard");
          const { cancelLine, LINE_WAIT_MS } = (await load(
            "/app/src/arm/pickup.ts",
          )) as typeof import("../pickup");
          audioHarness();
          const { Wrap, client, events, realtime } = sessionHarness();
          if (action === "queued")
            realtime.enqueue = (_card, event) => {
              events.push(event);
              return new Promise<void>(() => {});
            };
          for (const key of ["cards", "sessions"])
            client.setQueryData([key], []);
          client.setQueryData(["progress"], null);
          const line = {
            cardId: "missing-card",
            callId: "held",
            phoneExt: "101",
            kind: "service",
            who: "Служба 101",
            cardNumber: "100",
            heldAt: Date.now(),
            saved: {
              lines: [{ id: "said", who: "you", text: "Тестовый адрес" }],
              report: null,
              said: [],
              earlier: ["Тестовый адрес"],
            },
          };
          sessionStorage.setItem("dds-hold:review", JSON.stringify([line]));
          const arm = mountComponent(ArmPage, {}, ({ children }) =>
            createElement(
              Wrap,
              null,
              createElement(MemoryRouter, null, children),
            ),
          );
          await sleep();
          const resume = [
            ...document.querySelectorAll<HTMLButtonElement>("button"),
          ].find((button) => button.textContent?.includes("на удержании"))!;
          resume.click();
          if (action === "double") resume.click();
          await sleep();
          const before = {
            stored: JSON.parse(
              sessionStorage.getItem("dds-hold:review") ?? "null",
            ),
            resumes: events.filter((event) => event.type === "call_resume")
              .length,
          };
          if (action === "cancel") cancelLine();
          const now = Date.now;
          if (action === "late") Date.now = () => now() + LINE_WAIT_MS + 1;
          client.setQueryData(["brigades", "101"], []);
          client.setQueryData(
            ["call-targets", "101"],
            [
              {
                id: "target",
                brigade_id: null,
                phone_ext: "101",
                is_active: true,
              },
            ],
          );
          const recipient = action === "wrong" ? "wrong-card" : "missing-card";
          client.setQueryData(["card-training", recipient], {
            card_id: recipient,
            revision: 1,
            selected_brigade_ids: [],
            messages: [],
          });
          const phone = mountComponent(
            Softphone,
            { cardId: recipient, ownServiceId: "101" },
            Wrap,
          );
          await sleep();
          Date.now = now;
          const active = activeCall()?.hold?.()?.saved?.earlier ?? null;
          const after = JSON.parse(
            sessionStorage.getItem("dds-hold:review") ?? "null",
          );
          const resumes = events.filter(
            (event) => event.type === "call_resume",
          ).length;
          phone.unmount();
          arm.unmount();
          return { before, after, active, resumes, line };
        }, action);
        expect(result.before.resumes).toBe(0);
        expect(result.before.stored).toEqual(
          action === "ended" ? null : [result.line],
        );
        const accepted =
          action === "ready" || action === "double" || action === "queued";
        expect(result.active).toEqual(accepted ? ["Тестовый адрес"] : null);
        expect(result.resumes).toBe(accepted ? 1 : 0);
        expect(result.after).toEqual(
          accepted || action === "ended" ? null : [result.line],
        );
      } finally {
        await page.close();
      }
    },
    30_000,
  );
});

describe("сохранённый hold при серверном отбое и reload", () => {
  it.each(["ended", "expired", "reload", "refused"] as const)(
    "%s: потерянный получатель не забирает снимок",
    async (action) => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}__review__`);
        const result = await page.evaluate(async (action) => {
          const load = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<unknown>;
          const { mountHook, sessionHarness } = (await load(
            "/app/src/arm/softphone/hookHarness.tsx",
          )) as typeof import("./hookHarness");
          const { useHold } = (await load(
            "/app/src/arm/phone/useHold.ts",
          )) as typeof import("../phone/useHold");
          const { HOLD_LIMIT_MS } = (await load(
            "/app/src/arm/phone/hold.ts",
          )) as typeof import("../phone/hold");
          const { Wrap, realtime } = sessionHarness();
          let receive!: Parameters<typeof realtime.subscribe>[0];
          realtime.subscribe = (callback) => {
            receive = callback;
            return () => {};
          };
          const effects: import("../phone/hold").HoldEffect[] = [];
          const hook = mountHook(
            useHold,
            (effect: import("../phone/hold").HoldEffect) => {
              effects.push(effect);
            },
            Wrap,
          );
          const heldAt = Date.now();
          const line: Omit<import("../phone/hold").HeldLine, "heldAt"> = {
            callId: "call",
            cardId: "card",
            cardNumber: "100",
            kind: "service",
            phoneExt: "101",
            who: "Служба 101",
            saved: {
              lines: [],
              report: null,
              said: [],
              earlier: ["Тестовый адрес"],
            },
          };
          hook.current.dispatch({ type: "hold", line, at: heldAt });
          hook.current.dispatch({
            type: "resume",
            callId: "call",
            at: heldAt + 1,
          });
          const stale = hook.current.acceptResume;
          if (action === "ended")
            receive({
              type: "call.state",
              payload: { id: "call", card_id: "card", state: "ended" },
            } as import("../../shared/api").ServerEvent);
          if (action === "expired")
            hook.current.dispatch({ type: "tick", at: heldAt + HOLD_LIMIT_MS });
          if (action === "reload") hook.unmount();
          let starts = 0;
          const accepted = stale("call", () => {
            starts++;
            return action !== "refused";
          });
          if (action !== "reload") hook.unmount();
          const restored = mountHook(
            useHold,
            (effect: import("../phone/hold").HoldEffect) => {
              effects.push(effect);
            },
            Wrap,
          );
          const held = restored.current.state.held;
          restored.unmount();
          return {
            accepted,
            starts,
            held,
            effects: effects.map((effect) => effect.type),
            line: { ...line, heldAt },
          };
        }, action);
        expect(result.accepted).toBe(false);
        expect(result.starts).toBe(action === "refused" ? 1 : 0);
        expect(result.held).toEqual(
          action === "reload" || action === "refused" ? [result.line] : [],
        );
        expect(result.effects).toEqual(
          action === "expired" ? ["resume", "hangup"] : ["resume"],
        );
      } finally {
        await page.close();
      }
    },
    30_000,
  );
});

describe("получатель ControlTalk", () => {
  it.each(["ready", "cancel", "ended"] as const)(
    "%s: не принимает линию до готовности",
    async (action) => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}__review__`);
        const result = await page.evaluate(async (action) => {
          const load = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<unknown>;
          const { mountComponent, sessionHarness, audioHarness } = (await load(
            "/app/src/arm/softphone/hookHarness.tsx",
          )) as typeof import("./hookHarness");
          const { ControlTalk } = (await load(
            "/app/src/arm/phone/ControlTalk.tsx",
          )) as typeof import("../phone/ControlTalk");
          const { activeCall } = (await load(
            "/app/src/arm/callGuard.ts",
          )) as typeof import("../callGuard");
          const { Wrap, events } = sessionHarness();
          const played = audioHarness();
          let accepts = 0;
          let done = 0;
          const props = {
            cardId: "card",
            callId: "control",
            resumed: true,
            line: null as import("../phone/PhoneWindow").ControlLine | null,
            onResume: () => {
              accepts++;
              return true;
            },
            onDone: () => {
              done++;
            },
          };
          const component = mountComponent(ControlTalk, props, Wrap);
          const before = {
            accepts,
            active: activeCall() !== null,
            audio: played.length,
          };
          if (action === "cancel")
            component.container
              .querySelector<HTMLButtonElement>(
                '[aria-label="Положить трубку"]',
              )!
              .click();
          const line = {
            card: { source: { number: "100" } },
            control: {
              call_id: "control",
              answered_at: "2026-10-19T10:00:00Z",
              ended_at: action === "ended" ? "2026-10-19T10:01:00Z" : null,
              without_status_s: 10,
              reply_options: [],
            },
          } as unknown as import("../phone/PhoneWindow").ControlLine;
          component.render({ ...props, line });
          await new Promise((done) => setTimeout(done, 40));
          const after = {
            accepts,
            active: activeCall() !== null,
            audio: played.length,
            done,
            events: events.map((event) => event.type),
          };
          component.unmount();
          return { before, after };
        }, action);
        expect(result.before).toEqual({ accepts: 0, active: false, audio: 0 });
        expect(result.after.accepts).toBe(action === "ready" ? 1 : 0);
        expect(result.after.active).toBe(action === "ready");
        expect(result.after.events).toEqual([]);
        expect(result.after.done).toBe(action === "ready" ? 0 : 1);
      } finally {
        await page.close();
      }
    },
    30_000,
  );
});

describe("ArmPage сохраняет доклад в call_hold", () => {
  it.each(["empty", "partial", "full"] as const)(
    "%s: снимок Softphone проходит в outbox и reload",
    async (kind) => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}__review__`);
        const result = await page.evaluate(async (kind) => {
          const load = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<unknown>;
          const {
            mountComponent,
            sessionHarness,
            audioHarness,
            MemoryRouter,
            createElement,
          } = (await load(
            "/app/src/arm/softphone/hookHarness.tsx",
          )) as typeof import("./hookHarness");
          const { ArmPage } = (await load(
            "/app/src/arm/ArmPage.tsx",
          )) as typeof import("../ArmPage");
          const { Softphone } = (await load(
            "/app/src/arm/softphone/Softphone.tsx",
          )) as typeof import("./Softphone");
          const { requestLine } = (await load(
            "/app/src/arm/pickup.ts",
          )) as typeof import("../pickup");
          const { reportPayload } = (await load(
            "/app/src/arm/softphone/heldTalk.ts",
          )) as typeof import("./heldTalk");
          audioHarness();
          const { Wrap, client, events } = sessionHarness();
          client.setQueryData(["cards"], []);
          client.setQueryData(["sessions"], []);
          client.setQueryData(["progress"], null);
          const line = {
            cardId: "other-card",
            callId: "other",
            phoneExt: "101",
            kind: "service",
            who: "Служба 101",
            cardNumber: "100",
            heldAt: Date.now(),
          };
          sessionStorage.setItem("dds-hold:review", JSON.stringify([line]));
          const arm = mountComponent(ArmPage, {}, ({ children }) =>
            createElement(
              Wrap,
              null,
              createElement(MemoryRouter, null, children),
            ),
          );
          const report: import("./heldTalk").ReportLog = {
            callId: "report-call",
            choices:
              kind === "empty" ? [] : [kind === "full" ? "full" : "no_address"],
            modes: kind === "empty" ? [] : ["voice"],
            parts:
              kind === "empty"
                ? []
                : [
                    kind === "full"
                      ? ["who", "address", "card", "change"]
                      : ["who"],
                  ],
            loudness: kind === "empty" ? [] : [null],
            voiceFailures: kind === "empty" ? 0 : 1,
            registration: kind === "full" ? "123" : null,
          };
          client.setQueryData(["brigades", "101"], []);
          client.setQueryData(
            ["call-targets", "101"],
            [
              {
                id: "target",
                brigade_id: null,
                phone_ext: "101",
                is_active: true,
              },
            ],
          );
          client.setQueryData(["card-training", "source"], {
            card_id: "source",
            revision: 1,
            selected_brigade_ids: [],
            messages: [],
          });
          const phone = mountComponent(
            Softphone,
            { cardId: "source", ownServiceId: "101" },
            Wrap,
          );
          requestLine({
            kind: "resume",
            cardId: "source",
            callId: "report-call",
            phoneExt: "101",
            saved: { lines: [], said: [], report },
          });
          await new Promise((done) => setTimeout(done, 80));
          [...document.querySelectorAll<HTMLButtonElement>("button")]
            .find((button) => button.textContent?.includes("на удержании"))!
            .click();
          await new Promise((done) => setTimeout(done, 80));
          const stored = JSON.parse(
            sessionStorage.getItem("dds-hold:review") ?? "[]",
          ) as import("../phone/hold").HeldLine[];
          phone.unmount();
          arm.unmount();
          return {
            payload: events.find((event) => event.type === "call_hold")
              ?.payload,
            expected: { call_id: report.callId, ...reportPayload(report) },
            saved: stored.find((line) => line.callId === report.callId)?.saved
              ?.report,
            report,
          };
        }, kind);
        expect(result.saved).toEqual(result.report);
        expect(result.payload).toEqual(result.expected);
      } finally {
        await page.close();
      }
    },
    30_000,
  );
});

describe("замена реплики службы (PR2-04)", () => {
  it.each(["audio", "text"] as const)(
    "%s: предыдущая реплика не завершает новую",
    async (kind) => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}__review__`);
        const result = await page.evaluate(async (kind) => {
          const load = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<unknown>;
          const base = "/app/src/arm/softphone/";
          const { mountHook, sessionHarness, audioHarness } = (await load(
            base + "hookHarness.tsx",
          )) as typeof import("./hookHarness");
          const { useSoftphone } = (await load(
            base + "useSoftphone.ts",
          )) as typeof import("./useSoftphone");
          const { BANK_BOOKS } = (await load(
            base + "bank.ts",
          )) as typeof import("./bank");
          if (kind === "text") {
            // Фикстура банка без записи ответа: штатный текстовый путь speakBank.
            for (const phrase of BANK_BOOKS.OFFICIAL_101!.slots.answer!)
              Object.defineProperty(phrase, "id", {
                value: "missing-recording",
              });
          }
          const played = audioHarness();
          const { Wrap, events } = sessionHarness();
          const hook = mountHook(
            () => useSoftphone("card", []),
            undefined,
            Wrap,
          );
          hook.current.resume("call", "101", {
            callId: "call",
            choices: [],
            modes: [],
            parts: [],
            loudness: [],
            voiceFailures: 0,
            registration: null,
          });
          await new Promise((done) => setTimeout(done, 30));
          const firstLeft = hook.current.speechLeftMs();
          hook.current.accept();
          await new Promise((done) =>
            setTimeout(done, kind === "text" ? (firstLeft ?? 0) + 30 : 30),
          );
          const beforeEnd = {
            state: hook.current.model.state,
            phase: hook.current.model.phase,
            speaking: hook.current.speaking,
            hangups: events.filter((event) => event.type === "call_hangup")
              .length,
          };
          played.at(-1)!.finish();
          await new Promise((done) => setTimeout(done, 30));
          const afterEnd = hook.current.model.state;
          hook.unmount();
          return { beforeEnd, afterEnd, played: played.length };
        }, kind);
        expect(result.beforeEnd).toEqual({
          state: "talking",
          phase: "closing",
          speaking: true,
          hangups: 0,
        });
        expect(result.afterEnd).toBe("ended");
        expect(result.played).toBe(kind === "audio" ? 2 : 1);
      } finally {
        await page.close();
      }
    },
    30_000,
  );
});

describe("доклад после удержания (PR2-07)", () => {
  it("Softphone переносит earlier через снимок удержания и повторный монтаж", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__review__`);
      const result = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const base = "/app/src/arm/softphone/";
        const { mountComponent, sessionHarness, audioHarness } = (await load(
          base + "hookHarness.tsx",
        )) as typeof import("./hookHarness");
        const { Softphone } = (await load(
          base + "Softphone.tsx",
        )) as typeof import("./Softphone");
        const { requestLine } = (await load(
          "/app/src/arm/pickup.ts",
        )) as typeof import("../pickup");
        const { activeCall } = (await load(
          "/app/src/arm/callGuard.ts",
        )) as typeof import("../callGuard");
        audioHarness();
        const { Wrap, client } = sessionHarness();
        client.setQueryData(["brigades", "101"], []);
        client.setQueryData(
          ["call-targets", "101"],
          [
            {
              id: "target",
              brigade_id: "brigade",
              phone_ext: "201",
              is_active: true,
            },
          ],
        );
        client.setQueryData(["card-training", "card"], {
          card_id: "card",
          revision: 1,
          selected_brigade_ids: [],
          messages: [],
        });
        let saved: import("./heldTalk").SavedTalk | null = {
          lines: [],
          report: null,
          said: [],
          earlier: ["Тестовая улица, дом 10"],
        };
        const snapshots: (readonly string[] | undefined)[] = [];
        for (let mount = 0; mount < 2; mount += 1) {
          const component = mountComponent(
            Softphone,
            { cardId: "card", ownServiceId: "101" },
            Wrap,
          );
          requestLine({
            kind: "resume",
            cardId: "card",
            callId: "service-call",
            phoneExt: "101",
            saved,
          });
          await new Promise((done) => setTimeout(done, 100));
          saved = activeCall()?.hold?.()?.saved ?? null;
          snapshots.push(saved?.earlier);
          component.unmount();
        }
        return snapshots;
      });
      expect(result).toEqual([
        ["Тестовая улица, дом 10"],
        ["Тестовая улица, дом 10"],
      ]);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("восстанавливает earlier своего звонка, не переносит его в чужой", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__review__`);
      const result = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const base = "/app/src/arm/softphone/";
        const requests: { call: string; earlier: FormDataEntryValue | null }[] =
          [];
        window.fetch = async (value) => {
          const request = value as Request;
          const form = await request.formData();
          requests.push({
            call: request.url.split("/").at(-2)!,
            earlier: form.get("earlier"),
          });
          return new Response(
            JSON.stringify({
              text: form.get("text"),
              choice: "no_address",
              parts: ["who"],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        };
        const { mountHook } = (await load(
          base + "hookHarness.tsx",
        )) as typeof import("./hookHarness");
        const { useVoiceReport } = (await load(
          base + "useVoiceReport.ts",
        )) as typeof import("./useVoiceReport");
        const input: Parameters<typeof useVoiceReport>[0] = {
          callId: "service-a",
          listening: true,
          voiceOnly: false,
          onHeard: () => {},
          onUnclear: () => {},
        };
        const hook = mountHook(useVoiceReport, input);
        hook.current.submitDraft("Тестовая улица, дом 10");
        await new Promise((done) => setTimeout(done, 50));
        const saved = { callId: "service-a", earlier: hook.current.earlier() };
        hook.render({ ...input, callId: "service-b", saved });
        hook.current.submitDraft("Диспетчер ЖКХ");
        await new Promise((done) => setTimeout(done, 50));
        hook.render({ ...input, saved });
        hook.current.submitDraft("Пожар в подъезде");
        await new Promise((done) => setTimeout(done, 50));
        hook.unmount();
        return requests;
      });
      expect(result).toEqual([
        { call: "service-a", earlier: null },
        { call: "service-b", earlier: null },
        { call: "service-a", earlier: "Тестовая улица, дом 10" },
      ]);
    } finally {
      await page.close();
    }
  }, 30_000);
});

describe("вводная считается принятой только по выдаче сервера (PR2-08)", () => {
  it("enqueue и отвергнутая вводная не оставляют бригаду выехавшей", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__review__`);
      const result = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const base = "/app/src/arm/softphone/";
        const { mountHook, sessionHarness } = (await load(
          base + "hookHarness.tsx",
        )) as typeof import("./hookHarness");
        const { useBrigade } = (await load(
          base + "brigade/useBrigade.ts",
        )) as typeof import("./brigade/useBrigade");
        const { Wrap, events } = sessionHarness();
        const input: import("./brigade/useBrigade").BrigadeInput = {
          cardId: "card",
          sessionFinished: false,
          data: {
            brigades: [],
            targets: [],
            unavailable: false,
            refresh: () => {},
            reload: async () => null,
            training: {
              card_id: "card",
              revision: 1,
              selected_brigade_ids: [],
              messages: [],
            },
          },
        };
        const hook = mountHook(useBrigade, input, Wrap);
        hook.current.brief("call", "brigade", "voice", "Тестовая 10, пожар");
        await new Promise((done) => setTimeout(done, 30));
        const queued = [...hook.current.dispatched];
        hook.render({
          ...input,
          data: {
            ...input.data,
            training: { ...input.data.training!, revision: 2 },
          },
        });
        const rejected = [...hook.current.dispatched];
        hook.render({
          ...input,
          data: {
            ...input.data,
            training: {
              ...input.data.training!,
              revision: 3,
              selected_brigade_ids: ["brigade"],
            },
          },
        });
        const confirmed = [...hook.current.dispatched];
        hook.unmount();
        return {
          queued,
          rejected,
          confirmed,
          events: events.map((event) => event.type),
        };
      });
      expect(result).toEqual({
        queued: [],
        rejected: [],
        confirmed: ["brigade"],
        events: ["brigade_briefing"],
      });
    } finally {
      await page.close();
    }
  }, 30_000);
});

describe("вводная с задержкой или отказом outbox (PR2-08)", () => {
  it.each(["queued", "rejected"] as const)(
    "%s не является подтверждением выезда",
    async (outcome) => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}__review__`);
        const result = await page.evaluate(async (outcome) => {
          const load = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<unknown>;
          const { mountHook, sessionHarness } = (await load(
            "/app/src/arm/softphone/hookHarness.tsx",
          )) as typeof import("./hookHarness");
          const { useBrigade } = (await load(
            "/app/src/arm/softphone/brigade/useBrigade.ts",
          )) as typeof import("./brigade/useBrigade");
          const { Wrap, realtime } = sessionHarness();
          let resolve!: () => void;
          let reject!: (error: Error) => void;
          let unhandled = 0;
          window.addEventListener("unhandledrejection", (event) => {
            unhandled++;
            event.preventDefault();
          });
          realtime.enqueue = () =>
            new Promise<void>((yes, no) => {
              resolve = yes;
              reject = no;
            });
          const input: import("./brigade/useBrigade").BrigadeInput = {
            cardId: "card",
            sessionFinished: false,
            data: {
              brigades: [],
              targets: [],
              unavailable: false,
              refresh: () => {},
              reload: async () => null,
              training: {
                card_id: "card",
                revision: 1,
                selected_brigade_ids: [],
                messages: [],
              },
            },
          };
          const hook = mountHook(useBrigade, input, Wrap);
          hook.current.brief("call", "brigade", "voice", "Тестовая 10, пожар");
          await new Promise((done) => setTimeout(done, 30));
          const pending = [...hook.current.dispatched];
          if (outcome === "queued") resolve();
          else reject(new Error("Запись outbox отклонена"));
          await new Promise((done) => setTimeout(done, 30));
          const settled = [...hook.current.dispatched];
          hook.render({
            ...input,
            data: {
              ...input.data,
              training: {
                ...input.data.training!,
                revision: 2,
                selected_brigade_ids: outcome === "queued" ? ["brigade"] : [],
              },
            },
          });
          const confirmed = [...hook.current.dispatched];
          hook.unmount();
          return { pending, settled, confirmed, unhandled };
        }, outcome);
        expect(result).toEqual({
          pending: [],
          settled: [],
          confirmed: outcome === "queued" ? ["brigade"] : [],
          unhandled: 0,
        });
      } finally {
        await page.close();
      }
    },
    30_000,
  );
});

describe("распознавание через hold/resume (PR2-07)", () => {
  it("поздний submitDraft того же callId не меняет восстановленный доклад", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__review__`);
      const result = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const requests: {
          call: string;
          earlier: FormDataEntryValue | null;
          text: FormDataEntryValue | null;
          resolve: (response: Response) => void;
        }[] = [];
        window.fetch = async (value) => {
          const request = value as Request;
          const form = await request.formData();
          return new Promise<Response>((resolve) =>
            requests.push({
              call: request.url.split("/").at(-2)!,
              earlier: form.get("earlier"),
              text: form.get("text"),
              resolve,
            }),
          );
        };
        const { mountHook } = (await load(
          "/app/src/arm/softphone/hookHarness.tsx",
        )) as typeof import("./hookHarness");
        const { useVoiceReport } = (await load(
          "/app/src/arm/softphone/useVoiceReport.ts",
        )) as typeof import("./useVoiceReport");
        const heard: string[] = [];
        const input: Parameters<typeof useVoiceReport>[0] = {
          callId: "a",
          listening: true,
          voiceOnly: false,
          onHeard: (text: string) => {
            heard.push(text);
          },
          onUnclear: () => {},
        };
        const hook = mountHook(useVoiceReport, input);
        const sleep = () => new Promise((done) => setTimeout(done, 25));
        const complete = (i: number) =>
          requests[i]?.resolve(
            new Response(
              JSON.stringify({
                text: requests[i].text,
                choice: "no_address",
                parts: ["who"],
              }),
              { headers: { "Content-Type": "application/json" } },
            ),
          );
        hook.current.submitDraft("Тестовая 10");
        await sleep();
        complete(0);
        await sleep();
        hook.current.submitDraft("Устаревшая фраза");
        await sleep();
        const saved = { callId: "a", earlier: hook.current.earlier() };
        hook.render({ ...input, callId: null, listening: false, saved });
        hook.render({ ...input, callId: "b", saved });
        hook.render({ ...input, saved });
        hook.current.submitDraft("Новая фраза");
        await sleep();
        complete(1);
        await sleep();
        const afterStale = {
          earlier: hook.current.earlier(),
          sending: hook.current.sending,
          heard: [...heard],
        };
        complete(2);
        await sleep();
        const after = hook.current.earlier();
        hook.unmount();
        return {
          requests: requests.map(({ call, earlier, text }) => ({
            call,
            earlier,
            text,
          })),
          afterStale,
          after,
        };
      });
      expect(result.requests).toEqual([
        { call: "a", earlier: null, text: "Тестовая 10" },
        { call: "a", earlier: "Тестовая 10", text: "Устаревшая фраза" },
        { call: "a", earlier: "Тестовая 10", text: "Новая фраза" },
      ]);
      expect(result.afterStale).toEqual({
        earlier: ["Тестовая 10"],
        sending: true,
        heard: ["Тестовая 10"],
      });
      expect(result.after).toEqual(["Тестовая 10", "Новая фраза"]);
    } finally {
      await page.close();
    }
  }, 30_000);
});

describe("входящий доклад через настоящее удержание", () => {
  it("дослушивает доклад, ждёт ACK дольше quiet timer и подтверждает исходный callId", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__review__`);
      const result = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const { mountComponent, sessionHarness, audioHarness } = (await load(
          "/app/src/arm/softphone/hookHarness.tsx",
        )) as typeof import("./hookHarness");
        const { Softphone } = (await load(
          "/app/src/arm/softphone/Softphone.tsx",
        )) as typeof import("./Softphone");
        const { requestLine, requestPickup } = (await load(
          "/app/src/arm/pickup.ts",
        )) as typeof import("../pickup");
        const { activeCall } = (await load(
          "/app/src/arm/callGuard.ts",
        )) as typeof import("../callGuard");
        const { Wrap, client, events, realtime } = sessionHarness();
        // Эта проверка удержания использует исправный сервер: enqueue и HTTP-приём
        // разделены, но принятый ответ/ACK подтверждаем явно, как в рабочем realtime.
        type Outcome = import("../../shared/ws/outbox").OutboxOutcome;
        const outcomes = new Set<(outcome: Outcome) => void>();
        realtime.subscribeOutcomes = (listener) => {
          outcomes.add(listener);
          return () => {
            outcomes.delete(listener);
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
          for (const listener of outcomes)
            listener({ item, status: "accepted" });
        };
        const played = audioHarness();
        client.setQueryData(["brigades", "101"], []);
        const target = {
          id: "target",
          brigade_id: "brigade",
          service_id: "101",
          name: "Расчёт",
          phone_ext: "201",
          voice_profile: "denis",
          is_active: true,
        };
        client.setQueryData(["call-targets", "101"], [target]);
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
                  audio: { url: "/report.ogg", duration_ms: 3000, version: 1 },
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
        const sleep = () => new Promise((done) => setTimeout(done, 50));
        requestPickup("card", "incoming");
        // Дожидаемся настоящего начала аудио, не сокращая 2-секундное слушание бригады.
        for (
          let n = 0;
          n < 70 && !played.some((audio) => audio.src === "/report.ogg");
          n++
        ) {
          played
            .filter((audio) => !audio.ended && audio.src !== "/report.ogg")
            .forEach((audio) => audio.finish());
          await sleep();
        }
        const first = played.find((audio) => audio.src === "/report.ogg");
        if (!first) throw new Error("Доклад не начался");
        const held = activeCall()?.hold?.();
        if (!held) throw new Error("Разговор не удержан");
        await sleep();
        requestLine({
          kind: "resume",
          cardId: "card",
          callId: held.callId,
          phoneExt: held.phoneExt,
          saved: held.saved,
        });
        await sleep();
        // Закрытие посторонней карточки меняет режим окна, не владельца разговора.
        component.render({
          cardId: "card",
          ownServiceId: "101",
          callOnly: false,
          cardState: "accepted",
        });
        // Доклад ещё не закончился: ACK не подменяет его предъявление.
        const beforePlaybackEnd = events.filter(
          (event) => event.type === "report_confirmed",
        ).length;
        first.finish();
        for (let n = 0; n < 8; n++) {
          played
            .filter((audio) => !audio.ended)
            .forEach((audio) => audio.finish());
          await sleep();
        }
        await new Promise((done) => setTimeout(done, 6500));
        const ack =
          component.container.querySelector<HTMLButtonElement>(
            '[data-reply="ack"]',
          );
        const before = {
          active: activeCall() !== null,
          ack: ack !== null,
          hangups: events.filter((event) => event.type === "call_hangup")
            .length,
        };
        ack?.click();
        await sleep();
        const confirmations = events
          .filter((event) => event.type === "report_confirmed")
          .map((event) => event.payload);
        component.unmount();
        return {
          before,
          confirmations,
          beforePlaybackEnd,
          heldInbound: held.saved?.inbound,
        };
      });
      expect(result.beforePlaybackEnd).toBe(0);
      expect(result.heldInbound).toBe(true);
      expect(result.before).toEqual({ active: true, ack: true, hangups: 0 });
      expect(result.confirmations).toEqual([
        { call_id: "incoming", delivery_id: "report", text: "Принял." },
      ]);
    } finally {
      await page.close();
    }
  }, 30_000);
});

describe("реальный Softphone: поздний submitDraft после разрыва разговора", () => {
  it.each(["hold", "hangup", "server", "unmount"] as const)(
    "%s не принимает устаревшую фразу",
    async (action) => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}__review__`);
        const result = await page.evaluate(async (action) => {
          const load = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<unknown>;
          const requests: {
            text: FormDataEntryValue | null;
            earlier: FormDataEntryValue | null;
            resolve: (response: Response) => void;
          }[] = [];
          window.fetch = async (value) => {
            const request = value as Request;
            if (!request.url.endsWith("/voice-report"))
              return Response.json([]);
            const form = await request.formData();
            return new Promise<Response>((resolve) =>
              requests.push({
                text: form.get("text"),
                earlier: form.get("earlier"),
                resolve,
              }),
            );
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
          const { requestLine } = (await load(
            "/app/src/arm/pickup.ts",
          )) as typeof import("../pickup");
          const { activeCall } = (await load(
            "/app/src/arm/callGuard.ts",
          )) as typeof import("../callGuard");
          const { Wrap, client, realtime, events } = sessionHarness();
          const listeners = new Set<Parameters<typeof realtime.subscribe>[0]>();
          realtime.subscribe = (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          };
          const played = audioHarness();
          microphoneHarness();
          client.setQueryData(
            ["cards"],
            [
              {
                id: "card",
                state: "accepted",
                session_id: null,
                source: {
                  number: "100",
                  address: { street: "Тестовая", house: "10", building: "" },
                  service_ids: [],
                  incident_class: "Пожар",
                  description: "Учебный пожар",
                },
              },
            ],
          );
          client.setQueryData(["brigades", "101"], []);
          client.setQueryData(
            ["call-targets", "101"],
            [
              {
                id: "target",
                brigade_id: null,
                phone_ext: "101",
                is_active: true,
              },
            ],
          );
          client.setQueryData(["card-training", "card"], {
            card_id: "card",
            revision: 1,
            selected_brigade_ids: [],
            messages: [],
          });
          const component = mountComponent(
            Softphone,
            { cardId: "card", ownServiceId: "101" },
            Wrap,
          );
          const sleep = () => new Promise((done) => setTimeout(done, 60));
          const saved = {
            lines: [],
            report: null,
            said: [],
            earlier: ["Сохраненная фраза"],
          };
          requestLine({
            kind: "resume",
            cardId: "card",
            callId: "a",
            phoneExt: "101",
            saved,
          });
          await sleep();
          for (const audio of played) audio.finish();
          await sleep();
          const click = (label: string) => {
            const button = [
              ...component.container.querySelectorAll<HTMLButtonElement>(
                "button",
              ),
            ].find((button) => button.textContent?.trim() === label);
            if (!button || button.disabled)
              throw new Error(
                `Нет кнопки ${label}: ${component.container.textContent}`,
              );
            button.click();
          };
          click("Говорить");
          await sleep();
          click("Закончить ответ");
          await sleep();
          if (!requests[0]) throw new Error("Запись не отправлена");
          requests[0].resolve(
            Response.json({
              text: "Устаревшая фраза",
              choice: null,
              parts: [],
            }),
          );
          await sleep();
          click("Отправить");
          await sleep();
          if (!requests[1]) throw new Error("Правка не отправлена");
          let snapshot: import("./heldTalk").SavedTalk | null = null;
          if (action === "hold") {
            snapshot = activeCall()?.hold?.()?.saved ?? null;
            await sleep();
            requestLine({
              kind: "resume",
              cardId: "card",
              callId: "a",
              phoneExt: "101",
              saved: snapshot,
            });
            await sleep();
          } else if (action === "hangup")
            component.container
              .querySelector<HTMLButtonElement>(
                '[aria-label="Положить трубку"]',
              )!
              .click();
          else if (action === "server") {
            for (const listener of listeners)
              listener({
                type: "call.state",
                payload: { id: "a", state: "ended" },
              } as Parameters<typeof listener>[0]);
          } else component.unmount();
          requests[1].resolve(
            Response.json({
              text: "STALE",
              choice: "no_address",
              parts: ["who"],
            }),
          );
          await sleep();
          const staleVisible =
            component.container.textContent?.includes("STALE");
          const after =
            action === "hold" ? activeCall()?.hold?.()?.saved : null;
          if (action !== "unmount") component.unmount();
          return {
            snapshot,
            after,
            staleVisible,
            requests: requests.map(({ text, earlier }) => ({ text, earlier })),
            events: events.map((event) => event.type),
          };
        }, action);
        expect(result.requests).toEqual([
          { text: null, earlier: "Сохраненная фраза" },
          { text: "Устаревшая фраза", earlier: "Сохраненная фраза" },
        ]);
        expect(result.staleVisible).toBe(false);
        if (action === "hold") {
          expect(result.snapshot?.earlier).toEqual(["Сохраненная фраза"]);
          expect(result.after?.earlier).toEqual(["Сохраненная фраза"]);
          expect(
            result.after?.lines.some((line) => line.text.includes("STALE")),
          ).toBe(false);
        }
      } finally {
        await page.close();
      }
    },
    30_000,
  );
});

describe("две проверки вводной одного callId (PR2-03)", () => {
  it("поздняя первая проверка не отвечает поверх второй", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__review__`);
      const result = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const pending: ((response: Response) => void)[] = [];
        window.fetch = () =>
          new Promise<Response>((resolve) => pending.push(resolve));
        const { mountHook } = (await load(
          "/app/src/arm/softphone/hookHarness.tsx",
        )) as typeof import("./hookHarness");
        const { useBriefing } = (await load(
          "/app/src/arm/softphone/brigade/useBriefing.ts",
        )) as typeof import("./brigade/useBriefing");
        const events: (string | null)[] = [];
        const hook = mountHook(useBriefing, {
          callId: "call",
          brigadeId: "brigade",
          service: "101",
          needed: true,
          steps: [],
          onSaid: () => {},
          onAnswer: (text) => events.push(text),
          onDispatch: () => events.push("dispatch"),
          onIncomplete: () => events.push("incomplete"),
        });
        hook.current.say("Тестовая 10");
        hook.current.say("Пожар");
        await new Promise((done) => setTimeout(done, 20));
        const response = (complete: boolean) =>
          new Response(
            JSON.stringify({
              complete,
              readback: "Повторяю адрес",
              ask_again: "Что случилось?",
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        pending[1](response(true));
        await new Promise((done) => setTimeout(done, 20));
        pending[0](response(false));
        await new Promise((done) => setTimeout(done, 20));
        hook.unmount();
        return events;
      });
      expect(result).toEqual(["Повторяю адрес", "dispatch"]);
    } finally {
      await page.close();
    }
  }, 30_000);
});

describe("проверка вводной после ухода с линии (PR2-03)", () => {
  it.each(["hangup", "other", "unmount", "same"] as const)(
    "%s: устаревшая проверка не отправляет событий и не отвечает",
    async (change) => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}__review__`);
        const results = await page.evaluate(async (change) => {
          const base = "/app/src/arm/softphone/";
          const load = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<unknown>;
          let resolve!: (response: Response) => void;
          window.fetch = () =>
            new Promise<Response>((done) => {
              resolve = done;
            });
          const { mountHook } = (await load(
            base + "hookHarness.tsx",
          )) as typeof import("./hookHarness");
          const { useBriefing } = (await load(
            base + "brigade/useBriefing.ts",
          )) as typeof import("./brigade/useBriefing");
          const outcomes: string[][] = [];
          for (const complete of [true, false]) {
            const events: string[] = [];
            const input = {
              callId: "first" as string | null,
              brigadeId: "brigade",
              service: "101",
              needed: true,
              steps: [],
              onSaid: () => {},
              onAnswer: () => events.push("answer"),
              onDispatch: () => events.push("dispatch"),
              onIncomplete: () => events.push("incomplete"),
            };
            const hook = mountHook(useBriefing, input);
            hook.current.say("Улица Тестовая, дом 10. Пожар.");
            await new Promise((done) => setTimeout(done, 0));
            if (change === "unmount") hook.unmount();
            else if (change !== "same")
              hook.render({
                ...input,
                callId: change === "hangup" ? null : "second",
              });
            resolve(
              new Response(
                JSON.stringify({
                  complete,
                  readback: "Принял",
                  ask_again: "Повторите адрес",
                }),
                {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                },
              ),
            );
            await new Promise((done) => setTimeout(done, 30));
            outcomes.push(events);
            if (change !== "unmount") hook.unmount();
          }
          return outcomes;
        }, change);
        expect(results).toEqual(
          change === "same"
            ? [
                ["answer", "dispatch"],
                ["answer", "incomplete"],
              ]
            : [[], []],
        );
      } finally {
        await page.close();
      }
    },
    30_000,
  );
});
