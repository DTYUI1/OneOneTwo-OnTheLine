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
    // Отдельный кеш: параллельный harness софтфона не перезапускает эту страницу.
    cacheDir: "node_modules/.vite-trainer-review",
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
        name: "trainer-review",
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url?.includes("__trainer_review__")) {
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

describe("перехват в живом React", () => {
  it("RESUMED-T01: поздний ACK после remount останавливает реальный показ и оставляет ручное действие", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__trainer_review__`);
      const result = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        let finishTakeOver: ((response: Response) => void) | undefined;
        let finishTraining: ((response: Response) => void) | undefined;
        let finishManual: ((response: Response) => void) | undefined;
        let posts = 0;
        let reads = 0;
        let serverDemo = true;
        let manual = false;
        const sent: { body: unknown; serverDemo: boolean; manual: boolean }[] =
          [];
        const json = (data: unknown) => Response.json(data);
        window.fetch = async (input) => {
          const request = input as Request;
          const path = new URL(request.url).pathname;
          if (path.endsWith("/take-over")) {
            posts += 1;
            return new Promise<Response>((done) => {
              finishTakeOver = done;
            });
          }
          if (path.endsWith("/training")) {
            reads += 1;
            // Второй refetch начат настоящим autopilot в первом экземпляре.
            if (reads === 2)
              return new Promise<Response>((done) => {
                finishTraining = done;
              });
            return json({
              card_id: "card",
              revision: 1,
              selected_brigade_ids: [],
              messages: [],
              missing_report_states: [],
            });
          }
          if (path.endsWith("/events") && request.method === "POST") {
            sent.push({ body: await request.json(), serverDemo, manual });
            if (manual)
              return new Promise<Response>((done) => {
                finishManual = done;
              });
            return json({});
          }
          return json([]);
        };
        const {
          mountIncident,
          armCompletion,
          tick,
          incidentSession,
          incidentTraining,
        } = (await load(
          "/app/src/arm/trainer/takeOverHarness.tsx",
        )) as typeof import("./takeOverHarness");
        const { sessionMode, takeOverUnconfirmed } = (await load(
          "/app/src/arm/trainer/stages.ts",
        )) as typeof import("./stages");
        const { readMs, SAY } = (await load(
          "/app/src/arm/trainer/demoModel.ts",
        )) as typeof import("./demoModel");
        const snapshot = (app: ReturnType<typeof mountIncident>) => ({
          mode: app.snapshot().mode,
          storedMode: sessionMode("session"),
          demoCard: app.snapshot().demo?.cardId ?? null,
          paused: app.snapshot().demo?.paused ?? null,
          uncertain: takeOverUnconfirmed("session"),
        });
        const first = mountIncident();
        first.realtime.start();
        await tick();
        await armCompletion();
        // Второе ✓ делает только реальный курсор: callback/owner не подменяем.
        for (let i = 0; i < 500 && !finishTraining; i += 1) await tick();
        if (!finishTraining)
          throw new Error("Автопилот не начал второй refetch");
        const pending = first.api.takeOver();
        for (let i = 0; i < 50 && !finishTakeOver; i += 1) await tick();
        if (!finishTakeOver) throw new Error("Нет POST перехвата");
        const beforeUnmount = snapshot(first);
        first.unmount();
        // Ни сброса localStorage, ни второй попытки takeOver на новом экране.
        const second = mountIncident("watch", false);
        second.realtime.start();
        await tick();
        const remounted = snapshot(second);
        serverDemo = false;
        finishTakeOver(
          json({
            ...incidentSession,
            settings_snapshot: {
              ...incidentSession.settings_snapshot,
              demo: false,
            },
          }),
        );
        await pending;
        await tick();
        const afterAck = snapshot(second);
        finishTraining(json(incidentTraining));
        await tick();
        second.api.openIntro();
        await tick();
        second.api.closeDialog();
        await tick();
        const resume = Array.from(
          document.querySelectorAll<HTMLButtonElement>("[data-coach] button"),
        ).find((button) => button.textContent === "Продолжить");
        const resumeAvailable = !!resume && !resume.disabled;
        resume?.click();
        await tick();
        await armCompletion();
        const armed = second.snapshot().card?.check?.status;
        // Полное окно intro + проверки: RED обязан поймать реальный POST,
        // а GREEN проверяет отсутствие и отправки, и durable-записи.
        const deadline =
          performance.now() + readMs(SAY.intro) + readMs(SAY.check) + 3000;
        while (!sent.length && performance.now() < deadline) await tick();
        const automatic = {
          sent: [...sent],
          pending: await second.realtime.pending(),
        };
        let manualPending: Awaited<ReturnType<typeof second.realtime.pending>> =
          [];
        if (!sent.length) {
          manual = true;
          document
            .querySelector<HTMLButtonElement>('[data-help="line-confirm"]')!
            .click();
          for (let i = 0; i < 50 && !finishManual; i += 1) await tick();
          if (!finishManual) throw new Error("Ручной статус не дошёл до HTTP");
          manualPending = await second.realtime.pending();
          finishManual(json({}));
          for (
            let i = 0;
            i < 50 && (await second.realtime.pending()).length;
            i += 1
          )
            await tick();
        }
        const finalPending = await second.realtime.pending();
        second.unmount();
        return {
          posts,
          beforeUnmount,
          remounted,
          afterAck,
          resumeAvailable,
          armed,
          automatic,
          manualPending,
          sent,
          finalPending,
        };
      });
      expect(result.automatic).toEqual({ sent: [], pending: [] });
      expect(result.posts).toBe(1);
      expect(result.beforeUnmount).toEqual({
        mode: "watch",
        storedMode: "watch",
        demoCard: "card",
        paused: true,
        uncertain: true,
      });
      expect(result.remounted).toEqual(result.beforeUnmount);
      expect(result.afterAck).toEqual({
        mode: "together",
        storedMode: "together",
        demoCard: null,
        paused: null,
        uncertain: false,
      });
      expect(result.resumeAvailable).toBe(false);
      expect(result.armed).toBe("completed");
      expect(result.manualPending).toHaveLength(1);
      expect(result.manualPending[0]).toMatchObject({
        cardId: "card",
        event: {
          type: "status_change",
          payload: { state: "completed", comment: "Работы завершены" },
        },
      });
      expect(result.sent).toEqual([
        {
          serverDemo: false,
          manual: true,
          body: {
            client_event_id: expect.any(String),
            client_ts: expect.any(String),
            type: "status_change",
            payload: { state: "completed", comment: "Работы завершены" },
          },
        },
      ]);
      expect(result.finalPending).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
  it("durable outbox без ACK блокирует POST перехвата до доставки и повторной попытки", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__trainer_review__`);
      const result = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const commits: string[] = [];
        const json = (data: unknown) =>
          new Response(JSON.stringify(data), {
            headers: { "Content-Type": "application/json" },
          });
        window.fetch = async (input) => {
          const request = input as Request;
          const path = new URL(request.url).pathname;
          if (path.endsWith("take-over")) {
            commits.push("take-over");
            return json({
              id: "session",
              kind: "practice",
              status: "running",
              settings_snapshot: { demo: false },
              participants: [
                {
                  user_id: "user",
                  dds_service_id: "101",
                  workstation_number: 1,
                },
              ],
            });
          }
          if (path.endsWith("/events") && request.method === "POST") {
            commits.push((await request.json()).type);
            return json({});
          }
          return json([]);
        };
        const { mountIncident, tick } = (await load(
          "/app/src/arm/trainer/takeOverHarness.tsx",
        )) as typeof import("./takeOverHarness");
        const app = mountIncident();
        await tick();
        // Реальный RealtimeClient/IndexedDB: offline enqueue завершился БЕЗ ACK.
        await app.realtime.enqueue("card", {
          client_event_id: crypto.randomUUID(),
          client_ts: new Date().toISOString(),
          type: "status_change",
          payload: { state: "completed", comment: "Работы завершены" },
        });
        const before = await app.realtime.pending();
        await app.api.takeOver();
        await tick();
        const blocked = {
          commits: [...commits],
          paused: app.snapshot().demo?.paused,
          note: app.snapshot().note,
          pending: await app.realtime.pending(),
        };
        app.realtime.start();
        app.realtime.retryNow();
        for (let i = 0; i < 50 && (await app.realtime.pending()).length; i += 1)
          await tick();
        await app.api.takeOver();
        await tick();
        const mode = app.snapshot().mode;
        app.unmount();
        return { before, blocked, commits, mode };
      });
      expect(result.before).toHaveLength(1);
      expect(result.blocked.pending).toEqual(result.before);
      expect(result.blocked.commits).toEqual([]);
      expect(result.blocked.paused).toBe(true);
      expect(result.blocked.note).toContain("очереди действий");
      expect(result.commits).toEqual(["status_change", "take-over"]);
      expect(result.mode).toBe("together");
    } finally {
      await page.close();
    }
  }, 30_000);

  it("ручное второе ✓ после refetch сохраняет статус через реальный outbox", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__trainer_review__`);
      const result = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        let finish!: (response: Response) => void;
        let reads = 0;
        const sent: unknown[] = [];
        const json = (data: unknown) =>
          new Response(JSON.stringify(data), {
            headers: { "Content-Type": "application/json" },
          });
        window.fetch = async (input) => {
          const request = input as Request;
          const path = new URL(request.url).pathname;
          if (path.endsWith("/training")) {
            reads += 1;
            if (reads === 2)
              return new Promise<Response>((done) => {
                finish = done;
              });
            return json({ messages: [], missing_report_states: [] });
          }
          if (path.endsWith("/events") && request.method === "POST") {
            sent.push(await request.json());
            return json({});
          }
          return json([]);
        };
        const { mountIncident, armCompletion, tick, incidentTraining } =
          (await load(
            "/app/src/arm/trainer/takeOverHarness.tsx",
          )) as typeof import("./takeOverHarness");
        const { stopDemo } = (await load(
          "/app/src/arm/trainer/autopilot.ts",
        )) as typeof import("./autopilot");
        const app = mountIncident("together");
        app.realtime.start();
        await tick();
        await armCompletion();
        const before = [...sent];
        document
          .querySelector<HTMLButtonElement>('[data-help="line-confirm"]')!
          .click();
        await tick();
        stopDemo();
        finish(json(incidentTraining));
        await tick();
        await tick();
        const pending = await app.realtime.pending();
        app.unmount();
        return { before, sent, pending, reads };
      });
      expect(result.before).toEqual([]);
      expect(result.reads).toBe(2);
      expect(result.sent).toHaveLength(1);
      expect(result.sent[0]).toMatchObject({
        type: "status_change",
        payload: { state: "completed", comment: "Работы завершены" },
      });
      expect(result.pending).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
  it.each(["status_change", "field_change"] as const)(
    "перехват ждёт ACK %s, а не только enqueue; поздний автостатус не уходит",
    async (waitingType) => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}__trainer_review__`);
        const result = await page.evaluate(async (waitingType) => {
          const load = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<unknown>;
          const commits: { type: string; serverDemo: boolean }[] = [];
          let serverDemo = true;
          let releaseStatus!: () => void;
          let statusStarted!: () => void;
          const started = new Promise<void>((done) => {
            statusStarted = done;
          });
          const json = (data: unknown) =>
            new Response(JSON.stringify(data), {
              headers: { "Content-Type": "application/json" },
            });
          window.fetch = async (input) => {
            const request = input as Request;
            const path = new URL(request.url).pathname;
            if (path.endsWith("/training"))
              return json({ messages: [], missing_report_states: [] });
            if (path.endsWith("take-over")) {
              serverDemo = false;
              commits.push({ type: "take-over", serverDemo });
              return json({
                id: "session",
                kind: "practice",
                status: "running",
                settings_snapshot: { demo: false },
                participants: [
                  {
                    user_id: "user",
                    dds_service_id: "101",
                    workstation_number: 1,
                  },
                ],
              });
            }
            if (path.endsWith("/events") && request.method === "POST") {
              const event = await request.json();
              if (event.type === waitingType) {
                await new Promise<void>((done) => {
                  releaseStatus = done;
                  statusStarted();
                });
              }
              commits.push({ type: event.type, serverDemo });
              return json({});
            }
            return json([]);
          };
          const { mountIncident, armCompletion, tick } = (await load(
            "/app/src/arm/trainer/takeOverHarness.tsx",
          )) as typeof import("./takeOverHarness");
          const app = mountIncident();
          app.realtime.start();
          await tick();
          if (waitingType === "field_change") {
            const number = document.querySelector<HTMLInputElement>(
              '[data-help="line-number"]',
            )!;
            Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              "value",
            )!.set!.call(number, "2");
            number.dispatchEvent(new Event("input", { bubbles: true }));
            await tick();
          }
          await armCompletion();
          await started;
          const pendingBefore = (await app.realtime.pending()).map(
            (item) => item.event.type,
          );
          const takeover = app.api.takeOver();
          await tick();
          const beforeAck = {
            serverDemo,
            commits: [...commits],
            paused: app.snapshot().demo?.paused,
          };
          releaseStatus();
          await takeover;
          await tick();
          const pendingAfter = (await app.realtime.pending()).map(
            (item) => item.event.type,
          );
          app.unmount();
          return { pendingBefore, beforeAck, commits, pendingAfter };
        }, waitingType);
        expect(result.pendingBefore).toEqual([waitingType]);
        expect(result.beforeAck).toEqual({
          serverDemo: true,
          commits: [],
          paused: true,
        });
        expect(result.commits).toEqual([
          { type: waitingType, serverDemo: true },
          { type: "take-over", serverDemo: false },
        ]);
        expect(result.pendingAfter).toEqual([]);
      } finally {
        await page.close();
      }
    },
    40_000,
  );
  it.each(["take-over", "pause-resume", "stop"] as const)(
    "IncidentCard: поздний refetch второго авто-✓ отменён после %s",
    async (cancel) => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}__trainer_review__`);
        const result = await page.evaluate(async (cancel) => {
          const load = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<unknown>;
          let finishTraining!: (response: Response) => void;
          let secondCheck!: () => void;
          const checking = new Promise<void>((done) => {
            secondCheck = done;
          });
          let reads = 0;
          let serverDemo = true;
          const sent: { type: string; serverDemo: boolean }[] = [];
          const json = (data: unknown) =>
            new Response(JSON.stringify(data), {
              headers: { "Content-Type": "application/json" },
            });
          window.fetch = async (input) => {
            const request = input as Request;
            const path = new URL(request.url).pathname;
            if (path.endsWith("/training")) {
              reads += 1;
              if (reads === 2)
                return new Promise<Response>((done) => {
                  finishTraining = done;
                  secondCheck();
                });
              return json({
                card_id: "card",
                messages: [],
                missing_report_states: [],
              });
            }
            if (path.endsWith("take-over")) {
              serverDemo = false;
              return json({
                id: "session",
                kind: "practice",
                status: "running",
                participants: [
                  {
                    user_id: "user",
                    dds_service_id: "101",
                    workstation_number: 1,
                  },
                ],
                settings_snapshot: { demo: false },
              });
            }
            if (path.endsWith("/events") && request.method === "POST") {
              const event = await request.json();
              sent.push({ type: event.type, serverDemo });
              return json({});
            }
            return json([]);
          };
          const { mountIncident, tick, incidentTraining } = (await load(
            "/app/src/arm/trainer/takeOverHarness.tsx",
          )) as typeof import("./takeOverHarness");
          const app = mountIncident();
          app.realtime.start();
          await tick();
          const select = document.querySelector<HTMLSelectElement>(
            '[data-help="line-status"]',
          )!;
          const comment = document.querySelector<HTMLInputElement>(
            '[data-help="line-comment"]',
          )!;
          Object.getOwnPropertyDescriptor(
            HTMLSelectElement.prototype,
            "value",
          )!.set!.call(select, "completed");
          select.dispatchEvent(new Event("change", { bubbles: true }));
          await tick();
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )!.set!.call(comment, "Работы завершены");
          comment.dispatchEvent(new Event("input", { bubbles: true }));
          await tick();
          document
            .querySelector<HTMLButtonElement>('[data-help="line-confirm"]')!
            .click();
          await tick();
          const armed = app.snapshot().card?.check?.status;
          // Второе ✓ нажимает настоящий autopilot, не копия обработчика submitStatus.
          await checking;
          if (cancel === "take-over") await app.api.takeOver();
          else if (cancel === "stop") {
            const { stopDemo } = (await load(
              "/app/src/arm/trainer/autopilot.ts",
            )) as typeof import("./autopilot");
            stopDemo();
          } else {
            const controls = () =>
              Array.from(
                document.querySelectorAll<HTMLButtonElement>(
                  "[data-coach] button",
                ),
              );
            controls()
              .find((b) => b.textContent === "Пауза")!
              .click();
            await tick();
            controls()
              .find((b) => b.textContent === "Продолжить")!
              .click();
          }
          await tick();
          const taken = {
            serverDemo,
            mode: app.snapshot().mode,
            demo: app.snapshot().demo,
          };
          finishTraining(json(incidentTraining));
          await tick();
          await tick();
          const pending = (await app.realtime.pending()).map(
            (item) => item.event.type,
          );
          const staleCheck = app.snapshot().card?.check;
          app.unmount();
          return { armed, reads, taken, sent, pending, staleCheck };
        }, cancel);
        expect(result.armed).toBe("completed");
        expect(result.reads).toBe(2);
        if (cancel === "take-over")
          expect(result.taken).toEqual({
            serverDemo: false,
            mode: "together",
            demo: null,
          });
        expect(result.sent).toEqual([]);
        expect(result.pending).toEqual([]);
        expect(result.staleCheck).toBeNull();
      } finally {
        await page.close();
      }
    },
    40_000,
  );
  it.each(["watch", "expert"] as const)(
    "%s: useParticipant теряет права после refetch, но управление видно без якоря",
    async (mode) => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}__trainer_review__`);
        const result = await page.evaluate(async (mode) => {
          const load = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<unknown>;
          const requests: string[] = [];
          window.fetch = async (input) => {
            const request = input as Request;
            requests.push(`${request.method} ${new URL(request.url).pathname}`);
            return new Response(
              JSON.stringify({ code: "unavailable", message: "Нет связи" }),
              {
                status: 503,
                headers: { "Content-Type": "application/json" },
              },
            );
          };
          const { mountIncident, tick } = (await load(
            "/app/src/arm/trainer/takeOverHarness.tsx",
          )) as typeof import("./takeOverHarness");
          const { trainerStore } = (await load(
            "/app/src/arm/trainer/trainerStore.ts",
          )) as typeof import("./trainerStore");
          const app = mountIncident(mode);
          await tick();
          const anchor = document.querySelector('[data-help="line-confirm"]')!;
          trainerStore.setAnchor(anchor);
          const button = (text: string) =>
            Array.from(
              document.querySelectorAll<HTMLButtonElement>(
                "[data-coach] button",
              ),
            ).find((b) => b.textContent === text)!;
          button("Пауза").click();
          await app.client.refetchQueries({ queryKey: ["session", "session"] });
          await tick();
          const coach = document.querySelector<HTMLElement>("[data-coach]")!;
          const rect = coach.getBoundingClientRect();
          const missing = {
            queryStatus: app.client.getQueryState(["session", "session"])
              ?.status,
            cached: !!app.client.getQueryData(["session", "session"]),
            canAct: app.snapshot().card?.canAct,
            tip: app.snapshot().card?.tip,
            form: !!document.querySelector('[data-help="card-action"]'),
            anchorConnected: anchor.isConnected,
            visibility: getComputedStyle(coach).visibility,
            inViewport:
              rect.left >= 0 &&
              rect.top >= 0 &&
              rect.right <= innerWidth &&
              rect.bottom <= innerHeight,
            resumeDisabled: button("Продолжить").disabled,
          };
          button("Продолжить").click();
          await tick();
          const resumed = app.snapshot().demo?.paused;
          button("Пауза").click();
          await tick();
          const paused = app.snapshot().demo?.paused;
          if (mode === "watch") {
            button("Беру управление").click();
            await tick();
          }
          app.unmount();
          return { missing, resumed, paused, requests };
        }, mode);
        expect(result.missing).toMatchObject({
          queryStatus: "error",
          cached: true,
          canAct: false,
          tip: null,
          form: false,
          anchorConnected: false,
          visibility: "visible",
          inViewport: true,
          resumeDisabled: false,
        });
        expect(result.resumed).toBe(false);
        expect(result.paused).toBe(true);
        if (mode === "watch")
          expect(result.requests).toContain(
            "POST /api/practice/session/take-over",
          );
      } finally {
        await page.close();
      }
    },
    30_000,
  );
  it("поздний 4xx A после unmount не стирает неизвестный commit B той же session", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__trainer_review__`);
      const result = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        let finishA!: (response: Response) => void;
        let posts = 0;
        let serverDemo = true;
        window.fetch = async (input) => {
          const request = input as Request;
          if (request.method === "POST") {
            posts += 1;
            if (posts === 1)
              return new Promise<Response>((done) => {
                finishA = done;
              });
            serverDemo = false;
          }
          throw new TypeError("Ответ и сверка недоступны");
        };
        const { mountTrainer, tick } = (await load(
          "/app/src/arm/trainer/takeOverHarness.tsx",
        )) as typeof import("./takeOverHarness");
        const { takeOverUnconfirmed } = (await load(
          "/app/src/arm/trainer/stages.ts",
        )) as typeof import("./stages");
        const first = mountTrainer();
        await tick();
        const pendingA = first.api.takeOver();
        await tick();
        first.unmount();
        const second = mountTrainer("watch", false);
        await tick();
        await second.api.takeOver();
        await tick();
        const before = takeOverUnconfirmed("session");
        finishA(
          new Response(JSON.stringify({ code: "denied", message: "Отказ A" }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          }),
        );
        await pendingA;
        await tick();
        const after = takeOverUnconfirmed("session");
        second.unmount();
        const third = mountTrainer("watch", false);
        await tick();
        const remounted = third.snapshot();
        third.unmount();
        return { before, after, remounted, posts, serverDemo };
      });
      expect(result.posts).toBe(2);
      expect(result.serverDemo).toBe(false);
      expect(result.before).toBe(true);
      expect(result.after).toBe(true);
      expect(result.remounted.mode).toBe("watch");
      expect(result.remounted.paused).toBe(true);
      expect(result.remounted.note).toContain("Показ на паузе");
    } finally {
      await page.close();
    }
  }, 30_000);
  it("ответ после unmount не останавливает показ нового провайдера", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__trainer_review__`);
      const result = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        let finish!: (response: Response) => void;
        window.fetch = async (input) => {
          if ((input as Request).method === "POST")
            return new Promise<Response>((done) => {
              finish = done;
            });
          return new Response("[]", {
            headers: { "Content-Type": "application/json" },
          });
        };
        const { mountTrainer, tick } = (await load(
          "/app/src/arm/trainer/takeOverHarness.tsx",
        )) as typeof import("./takeOverHarness");
        const first = mountTrainer();
        await tick();
        const pending = first.api.takeOver();
        await tick();
        first.unmount();
        const second = mountTrainer("watch", false);
        second.show("second", "second-card", "expert");
        await tick();
        finish(
          new Response(
            JSON.stringify({
              id: "session",
              settings_snapshot: { demo: false },
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
        );
        await pending;
        await tick();
        const final = second.snapshot();
        second.unmount();
        return final;
      });
      expect(result.demoCard).toBe("second-card");
      expect(result.mode).toBe("expert");
      expect(result.paused).toBe(false);
      expect(result.note).toBe("");
      expect(result.storedMode).toBe("together");
      expect(result.watchDone).toBe(false);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("повторный монтаж сохраняет безопасную паузу; идемпотентный повтор снимает её только после подтверждения", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__trainer_review__`);
      const result = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        let posts = 0;
        window.fetch = async (input) => {
          const request = input as Request;
          if (!new URL(request.url).pathname.endsWith("take-over"))
            throw new TypeError("Сеть недоступна");
          if (request.method === "POST") posts += 1;
          if (posts < 2 || request.method !== "POST")
            throw new TypeError("Ответ потерян");
          return new Response(
            JSON.stringify(
              posts === 2
                ? { code: "denied", message: "Отказ повтора" }
                : { id: "session", settings_snapshot: { demo: false } },
            ),
            {
              status: posts === 2 ? 409 : 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        };
        const { mountTrainer, tick } = (await load(
          "/app/src/arm/trainer/takeOverHarness.tsx",
        )) as typeof import("./takeOverHarness");
        let app = mountTrainer();
        await tick();
        await app.api.takeOver();
        app.unmount();
        app = mountTrainer("watch", false);
        await tick();
        const remounted = app.snapshot();
        app.api.startStage("solo");
        await tick();
        const failedLaunch = app.snapshot();
        await app.api.takeOver();
        await tick();
        const retryDenied = app.snapshot();
        await app.api.takeOver();
        await tick();
        const confirmed = app.snapshot();
        app.unmount();
        return { remounted, failedLaunch, retryDenied, confirmed, posts };
      });
      expect(result.remounted.paused).toBe(true);
      expect(result.remounted.note).toContain("Показ на паузе");
      expect(result.failedLaunch.paused).toBe(true);
      expect(result.retryDenied.paused).toBe(true);
      expect(result.retryDenied.mode).toBe("watch");
      expect(result.confirmed.mode).toBe("together");
      expect(result.confirmed.demoCard).toBeNull();
      expect(result.posts).toBe(3);
    } finally {
      await page.close();
    }
  }, 30_000);
  it.each([200, 408, 409, 503])(
    "HTTP %s: подтверждённый отказ отличён от неизвестного исхода",
    async (status) => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}__trainer_review__`);
        const result = await page.evaluate(async (status) => {
          const load = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<unknown>;
          let gets = 0;
          window.fetch = async (input) => {
            const request = input as Request;
            if (request.method === "GET") gets += 1;
            return new Response(
              JSON.stringify(
                request.method === "GET"
                  ? {
                      id: "session",
                      kind: "practice",
                      settings_snapshot: { demo: true },
                    }
                  : { code: "denied", message: "Сервер отказал" },
              ),
              {
                status: request.method === "GET" ? 200 : status,
                headers: { "Content-Type": "application/json" },
              },
            );
          };
          const { mountTrainer, tick } = (await load(
            "/app/src/arm/trainer/takeOverHarness.tsx",
          )) as typeof import("./takeOverHarness");
          const app = mountTrainer();
          await tick();
          await app.api.takeOver();
          await tick();
          const snapshot = app.snapshot();
          app.unmount();
          return { snapshot, gets };
        }, status);
        expect(result.snapshot.mode).toBe("watch");
        expect(result.snapshot.watchDone).toBe(false);
        expect(result.snapshot.paused).toBe(status !== 409);
        expect(result.gets).toBe(status === 409 ? 0 : 1);
      } finally {
        await page.close();
      }
    },
    30_000,
  );

  it("поздний ответ старой session не меняет паузу и блокировку нового перехвата", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__trainer_review__`);
      const result = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const pending = new Map<string, (response: Response) => void>();
        const requests: string[] = [];
        const json = (data: unknown) =>
          new Response(JSON.stringify(data), {
            headers: { "Content-Type": "application/json" },
          });
        window.fetch = async (input) => {
          const request = input as Request;
          const path = new URL(request.url).pathname;
          requests.push(`${request.method} ${path}`);
          if (request.method === "POST")
            return new Promise<Response>((done) => pending.set(path, done));
          return json([]);
        };
        const { mountTrainer, tick } = (await load(
          "/app/src/arm/trainer/takeOverHarness.tsx",
        )) as typeof import("./takeOverHarness");
        const app = mountTrainer();
        await tick();
        const first = app.api.takeOver();
        void app.api.takeOver();
        await tick();
        app.show("second", "second-card");
        await tick();
        const second = app.api.takeOver();
        await tick();
        pending.get("/api/practice/session/take-over")!(
          json({ id: "session", settings_snapshot: { demo: false } }),
        );
        await first;
        await tick();
        const beforeSecond = app.snapshot();
        const takeover = Array.from(
          document.querySelectorAll<HTMLButtonElement>("[data-coach] button"),
        ).find((button) => button.textContent === "Беру управление")!;
        const secondDisabled = takeover.disabled;
        pending.get("/api/practice/second/take-over")?.(
          json({ id: "second", settings_snapshot: { demo: false } }),
        );
        await second;
        await tick();
        const final = app.snapshot();
        app.unmount();
        return { requests, beforeSecond, secondDisabled, final };
      });
      expect(
        result.requests.filter((request) => request.startsWith("POST")),
      ).toEqual([
        "POST /api/practice/session/take-over",
        "POST /api/practice/second/take-over",
      ]);
      expect(result.beforeSecond.demoCard).toBe("second-card");
      expect(result.beforeSecond.mode).toBe("watch");
      expect(result.beforeSecond.paused).toBe(true);
      expect(result.secondDisabled).toBe(true);
      expect(result.final.mode).toBe("together");
    } finally {
      await page.close();
    }
  }, 30_000);

  it("возврат к неизвестной session не запускает курсор заново", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__trainer_review__`);
      const result = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        window.fetch = async () => {
          throw new TypeError("Сеть недоступна");
        };
        const { mountTrainer, tick } = (await load(
          "/app/src/arm/trainer/takeOverHarness.tsx",
        )) as typeof import("./takeOverHarness");
        const app = mountTrainer();
        await tick();
        await app.api.takeOver();
        app.show("second", "second-card", "expert");
        await tick();
        const away = app.snapshot();
        app.show("session", "card");
        await tick();
        const returned = app.snapshot();
        app.unmount();
        return { away, returned };
      });
      expect(result.away.note).toBe("");
      expect(result.away.paused).toBe(false);
      expect(result.returned.paused).toBe(true);
      expect(result.returned.note).toContain("Показ на паузе");
    } finally {
      await page.close();
    }
  }, 30_000);

  it.each(["watch", "expert"] as const)(
    "%s: ошибка refetch cards не блокирует локальную паузу",
    async (mode) => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}__trainer_review__`);
        const result = await page.evaluate(async (mode) => {
          const load = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<unknown>;
          const requests: string[] = [];
          window.fetch = async (input) => {
            const request = input as Request;
            requests.push(`${request.method} ${new URL(request.url).pathname}`);
            return new Response(
              JSON.stringify({ code: "unavailable", message: "Нет связи" }),
              { status: 503, headers: { "Content-Type": "application/json" } },
            );
          };
          const { mountTrainer, tick } = (await load(
            "/app/src/arm/trainer/takeOverHarness.tsx",
          )) as typeof import("./takeOverHarness");
          const app = mountTrainer(mode);
          await tick();
          await app.client.refetchQueries({ queryKey: ["cards"] });
          await tick();
          const buttons = () =>
            Array.from(
              document.querySelectorAll<HTMLButtonElement>(
                "[data-coach] button",
              ),
            );
          const pause = buttons().find(
            (button) => button.textContent === "Пауза",
          )!;
          const takeover = buttons().find(
            (button) => button.textContent === "Беру управление",
          );
          const before = {
            snapshot: app.snapshot(),
            pauseDisabled: pause.disabled,
            takeoverDisabled: takeover?.disabled ?? null,
            cardsStatus: app.client.getQueryState(["cards"])?.status,
          };
          pause.click();
          await tick();
          const paused = app.snapshot().paused;
          buttons()
            .find((button) => button.textContent === "Продолжить")
            ?.click();
          await tick();
          const resumed = app.snapshot().paused;
          takeover?.click();
          await tick();
          app.unmount();
          return { before, paused, resumed, requests };
        }, mode);
        expect(result.before.cardsStatus).toBe("error");
        expect(result.before.snapshot.busy).toBe(true);
        expect(result.before.pauseDisabled).toBe(false);
        expect(result.before.takeoverDisabled).toBe(
          mode === "watch" ? false : null,
        );
        expect(result.paused).toBe(true);
        expect(result.resumed).toBe(false);
        if (mode === "watch")
          expect(result.requests).toContain(
            "POST /api/practice/session/take-over",
          );
      } finally {
        await page.close();
      }
    },
    30_000,
  );

  it("не даёт снять паузу при неизвестном исходе и недоступном GET", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__trainer_review__`);
      const result = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        window.fetch = async () => {
          throw new TypeError("Сеть недоступна");
        };
        const { mountTrainer, tick } = (await load(
          "/app/src/arm/trainer/takeOverHarness.tsx",
        )) as typeof import("./takeOverHarness");
        const app = mountTrainer();
        await tick();
        await app.api.takeOver();
        await tick();
        const resume = Array.from(
          document.querySelectorAll<HTMLButtonElement>("[data-coach] button"),
        ).find((button) => button.textContent === "Продолжить")!;
        const disabled = resume.disabled;
        resume.click();
        await tick();
        const final = app.snapshot();
        app.unmount();
        return { disabled, final };
      });
      expect(result.disabled).toBe(true);
      expect(result.final.paused).toBe(true);
      expect(result.final.mode).toBe("watch");
      expect(result.final.note).toContain("Показ на паузе");
    } finally {
      await page.close();
    }
  }, 30_000);

  it("потерянный ответ после commit держит паузу до GET и переводит во Вместе", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__trainer_review__`);
      const result = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const requests: string[] = [];
        let committed = false;
        let finishGet: ((response: Response) => void) | undefined;
        const json = (data: unknown) =>
          new Response(JSON.stringify(data), {
            headers: { "Content-Type": "application/json" },
          });
        window.fetch = async (input) => {
          const request = input as Request;
          const path = new URL(request.url).pathname;
          requests.push(`${request.method} ${path}`);
          if (path.endsWith("take-over")) {
            committed = true;
            throw new TypeError("Ответ потерян после commit");
          }
          if (path === "/api/sessions/session")
            return new Promise<Response>((done) => {
              finishGet = done;
            });
          return json([]);
        };
        const { mountTrainer, tick } = (await load(
          "/app/src/arm/trainer/takeOverHarness.tsx",
        )) as typeof import("./takeOverHarness");
        const app = mountTrainer();
        await tick();
        const pending = app.api.takeOver();
        await tick();
        const waiting = app.snapshot();
        finishGet?.(
          json({
            id: "session",
            kind: "practice",
            status: "running",
            settings_snapshot: { demo: !committed, demo_mode: "watch" },
          }),
        );
        await pending;
        await tick();
        const final = app.snapshot();
        app.unmount();
        return { waiting, final, requests };
      });
      expect(result.waiting.paused).toBe(true);
      expect(result.waiting.mode).toBe("watch");
      expect(result.waiting.watchDone).toBe(false);
      expect(result.requests).toContain("GET /api/sessions/session");
      expect(result.final.mode).toBe("together");
      expect(result.final.watchDone).toBe(true);
      expect(result.final.demoCard).toBeNull();
    } finally {
      await page.close();
    }
  }, 30_000);
});
