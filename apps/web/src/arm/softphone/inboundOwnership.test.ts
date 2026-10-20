import { afterAll, beforeAll, expect, it } from "vitest";
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
    cacheDir: "node_modules/.vite-inbound-ownership",
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
        name: "inbound-ownership",
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url?.includes("__inbound_ownership__")) {
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

it("Входящий ответ и подтверждение доклада требуют точной квитанции; отказ разрешает повтор", async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}__inbound_ownership__`);
    const result = await page.evaluate(async () => {
      const load = new Function("url", "return import(url)") as (
        url: string,
      ) => Promise<unknown>;
      let training: unknown = [];
      window.fetch = async (input) =>
        Response.json(
          (input as Request).url.endsWith("/training") ? training : [],
        );
      const { mountComponent, sessionHarness, audioHarness } = (await load(
        "/app/src/arm/softphone/hookHarness.tsx",
      )) as typeof import("./hookHarness");
      const { Softphone } = (await load(
        "/app/src/arm/softphone/Softphone.tsx",
      )) as typeof import("./Softphone");
      const { requestPickup } = (await load(
        "/app/src/arm/pickup.ts",
      )) as typeof import("../pickup");
      const { activeCall } = (await load(
        "/app/src/arm/callGuard.ts",
      )) as typeof import("../callGuard");
      const { Outbox, flushOutbox } = (await load(
        "/app/src/shared/ws/outbox.ts",
      )) as typeof import("../../shared/ws/outbox");
      const { Wrap, client, realtime } = sessionHarness();
      const outbox = new Outbox(crypto.randomUUID());
      type Outcome = import("../../shared/ws/outbox").OutboxOutcome;
      const listeners = new Set<(o: Outcome) => void>();
      const publish = (o: Outcome) => {
        for (const listener of listeners) listener(o);
      };
      realtime.subscribeOutcomes = (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      };
      realtime.pending = () => outbox.list("review");
      realtime.enqueue = async (cardId, event) => {
        await outbox.add("review", cardId, event);
      };
      const sleep = (ms = 50) => new Promise((done) => setTimeout(done, ms));
      const until = async (condition: () => boolean) => {
        for (let n = 0; n < 100 && !condition(); n++) await sleep();
        if (!condition())
          throw new Error("Timed out: " + document.body.textContent);
      };
      const played = audioHarness();
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

      training = client.getQueryData(["card-training", "card"]);
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
      const ack = () =>
        component.container.querySelector<HTMLButtonElement>(
          '[data-reply="ack"]',
        );
      try {
        requestPickup("card", "incoming");
        await sleep(100);
        await sleep(200);
        const pendingAnswer = {
          report: played.some((a) => a.src === "/report.ogg"),
          ack: !!ack(),
          talking:
            component.container.textContent?.includes("Разговор") === true,
        };
        if (pendingAnswer.report || pendingAnswer.talking)
          throw new Error(
            "Inbound answer started conversation/media before acceptance",
          );
        const answer = (await outbox.list("review")).find(
          (i) => i.event.type === "call_answer",
        )!;
        if (!answer) throw new Error("No call_answer");
        // Квитанции чужой карточки, события и звонка не дают владения линией.
        for (const item of [
          { ...answer, cardId: "other" },
          { ...answer, id: "other" },
          {
            ...answer,
            event: {
              ...answer.event,
              type: "call_answer" as const,
              payload: { call_id: "other" },
            },
          },
        ])
          publish({ item, status: "accepted" });
        await sleep();
        const afterForeignAnswer = played.length;
        await flushOutbox(
          outbox,
          "review",
          async () => ({ status: 200 }),
          publish,
        );
        await until(() => {
          played
            .filter((a) => !a.ended && a.src !== "/report.ogg")
            .forEach((a) => a.finish());
          return played.some((a) => a.src === "/report.ogg");
        });
        for (let n = 0; n < 10; n++) {
          played.filter((a) => !a.ended).forEach((a) => a.finish());
          await sleep();
        }
        await until(() => !!ack());
        ack()!.click();
        await sleep(100);
        const pendingAck = (await outbox.list("review")).find(
          (i) => i.event.type === "report_confirmed",
        )!;
        if (!pendingAck || pendingAck.event.type !== "report_confirmed")
          throw new Error("No report_confirmed");
        ack()?.click();
        await sleep();
        const duplicateCount = (await outbox.list("review")).filter(
          (i) => i.event.type === "report_confirmed",
        ).length;
        for (const item of [
          { ...pendingAck, cardId: "other" },
          { ...pendingAck, id: "other" },
          {
            ...pendingAck,
            event: {
              ...pendingAck.event,
              payload: { ...pendingAck.event.payload, call_id: "other" },
            },
          },
        ])
          publish({ item, status: "accepted" });
        await sleep(6500);
        const pending = {
          ack: !!ack(),
          active: activeCall() !== null,
          hangups: (await outbox.list("review")).filter(
            (i) => i.event.type === "call_hangup",
          ).length,
        };
        await flushOutbox(
          outbox,
          "review",
          async (i) =>
            i.id === pendingAck.id
              ? {
                  status: 409,
                  code: "brigade_line",
                  message: "Бригаде говорят, пока идёт разговор с ней",
                }
              : { status: 200 },
          publish,
        );
        await sleep();
        const rejected = {
          ack: !!ack(),
          active: activeCall() !== null,
          pending: (await outbox.list("review")).length,
        };
        ack()?.click();
        await sleep(100);
        const retry = (await outbox.list("review")).find(
          (i) => i.event.type === "report_confirmed",
        );
        await flushOutbox(
          outbox,
          "review",
          async () => ({ status: 200 }),
          publish,
        );
        await sleep(100);
        const accepted = { ack: !!ack(), active: activeCall() !== null };
        await sleep(1600);
        const ended = {
          active: activeCall() !== null,
          hangups: (await outbox.list("review")).filter(
            (i) => i.event.type === "call_hangup",
          ).length,
        };
        return {
          pendingAnswer,
          afterForeignAnswer,
          duplicateCount,
          pending,
          rejected,
          retry: !!retry && retry.id !== pendingAck.id,
          accepted,
          ended,
        };
      } finally {
        component.unmount();
        client.clear();
        await outbox.close();
      }
    });
    expect(errors).toEqual([]);
    expect(result.pendingAnswer).toEqual({
      report: false,
      ack: false,
      talking: false,
    });
    expect(result.afterForeignAnswer).toBe(0);
    expect(result.duplicateCount).toBe(1);
    expect(result.pending).toEqual({ ack: true, active: true, hangups: 0 });
    expect(result.rejected).toEqual({ ack: true, active: true, pending: 0 });
    expect(result.retry).toBe(true);
    expect(result.accepted).toEqual({ ack: false, active: true });
    expect(result.ended).toEqual({ active: false, hangups: 1 });
  } finally {
    await page.close();
  }
}, 30_000);

it.each(["replacement", "same-call"])(
  "Устаревший таймер тишины не завершает разговор %s",
  async (kind) => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__inbound_ownership__`);
      const result = await page.evaluate(async (kind) => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const training = {
          card_id: "card",
          revision: 1,
          selected_brigade_ids: ["brigade"],
          messages: [],
          incoming: [],
        };
        window.fetch = async (input) =>
          Response.json(
            (input as Request).url.endsWith("/training") ? training : [],
          );
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
        const { Wrap, client, events } = sessionHarness();
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
        const played = audioHarness();
        const timers: (() => void)[] = [];
        const timeout = window.setTimeout.bind(window);
        window.setTimeout = ((
          handler: TimerHandler,
          ms?: number,
          ...args: unknown[]
        ) => {
          if (ms === 6000 && typeof handler === "function") {
            timers.push(() => handler(...args));
            return timeout(() => {}, 60_000);
          }
          return timeout(handler, ms, ...args);
        }) as typeof window.setTimeout;
        const sleep = () => new Promise((done) => timeout(done, 50));
        const drainUntil = async (condition: () => boolean) => {
          for (let n = 0; n < 100 && !condition(); n++) {
            played.filter((a) => !a.ended).forEach((a) => a.finish());
            await sleep();
          }
          if (!condition())
            throw new Error(
              "Missing quiet timer: " + document.body.textContent,
            );
        };
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
        try {
          requestLine({
            kind: "resume",
            cardId: "card",
            callId: "first",
            phoneExt: "201",
            saved: { lines: [], report: null, said: [], inbound: true },
          });
          await drainUntil(() => timers.length > 0);
          const stale = timers[0];
          const held = activeCall()?.hold?.();
          if (!held) throw new Error("Failed actual hold");
          await sleep();
          const id = kind === "same-call" ? "first" : "replacement";
          requestLine({
            kind: "resume",
            cardId: "card",
            callId: id,
            phoneExt: "201",
            saved: held.saved,
          });
          await drainUntil(() => timers.length > 1);
          stale();
          await sleep();
          return {
            active: activeCall() !== null,
            callId: activeCall()?.hold?.()?.callId,
            hangups: events.filter((e) => e.type === "call_hangup").length,
            expected: id,
          };
        } finally {
          component.unmount();
          client.clear();
          window.setTimeout = timeout;
        }
      }, kind);
      expect(result.active).toBe(true);
      expect(result.callId).toBe(result.expected);
      expect(result.hangups).toBe(0);
    } finally {
      await page.close();
    }
  },
  20_000,
);

it.each(["reject", "unmount", "replace", "same-id"])(
  "Ожидающий ответ изолирован при %s",
  async (action) => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}__inbound_ownership__`);
      const result = await page.evaluate(async (action) => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        window.fetch = async () => Response.json([]);
        const { mountHook, sessionHarness, audioHarness } = (await load(
          "/app/src/arm/softphone/hookHarness.tsx",
        )) as typeof import("./hookHarness");
        const { useSoftphone } = (await load(
          "/app/src/arm/softphone/useSoftphone.ts",
        )) as typeof import("./useSoftphone");
        const { Outbox, flushOutbox } = (await load(
          "/app/src/shared/ws/outbox.ts",
        )) as typeof import("../../shared/ws/outbox");
        const { Wrap, realtime, client } = sessionHarness();
        const outbox = new Outbox(crypto.randomUUID());
        type Outcome = import("../../shared/ws/outbox").OutboxOutcome;
        const listeners = new Set<(o: Outcome) => void>();
        const publish = (o: Outcome) => {
          for (const listener of listeners) listener(o);
        };
        realtime.subscribeOutcomes = (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        };
        realtime.pending = () => outbox.list("review");
        realtime.enqueue = async (cardId, event) => {
          await outbox.add("review", cardId, event);
        };
        const played = audioHarness();
        const hook = mountHook(() => useSoftphone("card", []), undefined, Wrap);
        const sleep = () => new Promise((done) => setTimeout(done, 50));
        let mounted = true;
        try {
          hook.current.pickup("original", "201");
          await sleep();
          const original = (await outbox.list("review"))[0];
          const before = {
            state: hook.current.model.state,
            speech: played.length,
          };
          let rejected: string | null = null;
          if (action === "reject") {
            await flushOutbox(
              outbox,
              "review",
              async () => ({ status: 409, code: "call_ended" }),
              publish,
            );
            await sleep();
            rejected = hook.current.model.state;
            hook.current.pickup("original", "201");
            await sleep();
          } else if (action === "unmount") {
            hook.unmount();
            mounted = false;
          } else {
            await hook.current.hangupNow();
            hook.current.pickup(
              action === "same-id" ? "original" : "replacement",
              "201",
            );
            await sleep();
            await outbox.remove(original.id);
          }
          // Поздняя квитанция отменённого ответа не должна захватывать новую линию.
          if (action !== "reject")
            publish({ item: original, status: "accepted" });
          await sleep();
          const stale = {
            state: hook.current.model.state,
            callId: hook.current.model.callId,
            speech: played.length,
          };
          await flushOutbox(
            outbox,
            "review",
            async () => ({ status: 200 }),
            publish,
          );
          await sleep();
          return {
            before,
            rejected,
            stale,
            final: hook.current.model.state,
            speech: played.length,
            queue: (await outbox.list("review")).length,
          };
        } finally {
          if (mounted) hook.unmount();
          client.clear();
          await outbox.close();
        }
      }, action);
      expect(result.before).toEqual({ state: "ringing", speech: 0 });
      expect(result.speech).toBe(0);
      expect(result.stale.state).toBe("ringing");
      expect(result.stale.speech).toBe(0);
      if (action === "reject") expect(result.rejected).toBe("ended");
      expect(result.final).toBe(action === "unmount" ? "ringing" : "talking");
      expect(result.queue).toBe(0);
    } finally {
      await page.close();
    }
  },
  15_000,
);

it.each(["hold", "resume", "repeat", "replacement", "new-delivery"])(
  "Принятое подтверждение доклада снимает ожидание после %s",
  async (action) => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${origin}__inbound_ownership__`);
      const result = await page.evaluate(async (action) => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        let training: unknown = [];
        window.fetch = async (input) =>
          Response.json(
            (input as Request).url.endsWith("/training") ? training : [],
          );
        const { mountComponent, sessionHarness, audioHarness } = (await load(
          "/app/src/arm/softphone/hookHarness.tsx",
        )) as typeof import("./hookHarness");
        const { Softphone } = (await load(
          "/app/src/arm/softphone/Softphone.tsx",
        )) as typeof import("./Softphone");
        const { requestPickup } = (await load(
          "/app/src/arm/pickup.ts",
        )) as typeof import("../pickup");
        const { activeCall } = (await load(
          "/app/src/arm/callGuard.ts",
        )) as typeof import("../callGuard");
        const { Outbox, flushOutbox } = (await load(
          "/app/src/shared/ws/outbox.ts",
        )) as typeof import("../../shared/ws/outbox");
        const { Wrap, client, realtime } = sessionHarness();
        const outbox = new Outbox(crypto.randomUUID());
        type Outcome = import("../../shared/ws/outbox").OutboxOutcome;
        const listeners = new Set<(o: Outcome) => void>();
        const publish = (o: Outcome) => {
          for (const listener of listeners) listener(o);
        };
        realtime.subscribeOutcomes = (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        };
        realtime.pending = () => outbox.list("review");
        realtime.enqueue = async (cardId, event) => {
          await outbox.add("review", cardId, event);
        };
        const sleep = (ms = 50) => new Promise((done) => setTimeout(done, ms));
        const until = async (condition: () => boolean) => {
          for (let n = 0; n < 100 && !condition(); n++) await sleep();
          if (!condition())
            throw new Error("Timed out: " + document.body.textContent);
        };
        const played = audioHarness();
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

        training = client.getQueryData(["card-training", "card"]);
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
        const ack = () =>
          component.container.querySelector<HTMLButtonElement>(
            '[data-reply="ack"]',
          );
        try {
          requestPickup("card", "incoming");
          await sleep(100);
          await sleep(200);
          const pendingAnswer = {
            report: played.some((a) => a.src === "/report.ogg"),
            ack: !!ack(),
            talking:
              component.container.textContent?.includes("Разговор") === true,
          };
          if (pendingAnswer.report || pendingAnswer.talking)
            throw new Error(
              "Inbound answer started conversation/media before acceptance",
            );
          const answer = (await outbox.list("review")).find(
            (i) => i.event.type === "call_answer",
          )!;
          if (!answer) throw new Error("No call_answer");
          // Квитанции чужой карточки, события и звонка не дают владения линией.
          for (const item of [
            { ...answer, cardId: "other" },
            { ...answer, id: "other" },
            {
              ...answer,
              event: {
                ...answer.event,
                type: "call_answer" as const,
                payload: { call_id: "other" },
              },
            },
          ])
            publish({ item, status: "accepted" });
          await sleep();
          const afterForeignAnswer = played.length;
          await flushOutbox(
            outbox,
            "review",
            async () => ({ status: 200 }),
            publish,
          );
          await until(() => {
            played
              .filter((a) => !a.ended && a.src !== "/report.ogg")
              .forEach((a) => a.finish());
            return played.some((a) => a.src === "/report.ogg");
          });
          for (let n = 0; n < 10; n++) {
            played.filter((a) => !a.ended).forEach((a) => a.finish());
            await sleep();
          }
          await until(() => !!ack());
          ack()!.click();
          await sleep(100);
          const pendingAck = (await outbox.list("review")).find(
            (item) => item.event.type === "report_confirmed",
          );
          if (!pendingAck)
            throw new Error("Нет ожидающего подтверждения доклада");
          const before = { ack: !!ack(), active: activeCall() !== null };
          const { requestLine } = (await load(
            "/app/src/arm/pickup.ts",
          )) as typeof import("../pickup");
          const accept = () =>
            flushOutbox(
              outbox,
              "review",
              async () => ({ status: 200 }),
              publish,
            );
          const drain = async () => {
            for (let n = 0; n < 20; n++) {
              played
                .filter((audio) => !audio.ended)
                .forEach((audio) => audio.finish());
              await sleep();
            }
          };
          if (action === "new-delivery") {
            const snapshot = training as {
              messages: Array<{
                delivery: { delivery_id: string; message: { id: string } };
              }>;
            };
            const previous = snapshot.messages[0];
            training = {
              ...snapshot,
              messages: [
                {
                  ...previous,
                  delivery: {
                    ...previous.delivery,
                    delivery_id: "next-report",
                    message: {
                      ...previous.delivery.message,
                      id: "next-message",
                    },
                  },
                },
              ],
            };
            client.setQueryData(["card-training", "card"], training);
            await drain();
            if (!ack())
              throw new Error("Новый доклад должен ждать своего подтверждения");
            await accept();
          } else if (action === "repeat") {
            const repeat = component.container.querySelector<HTMLButtonElement>(
              '[data-reply="repeat"]',
            );
            if (!repeat || repeat.disabled)
              throw new Error(
                "Повтор должен быть доступен при ожидающем подтверждении",
              );
            repeat.click();
            await sleep(200);
            await drain();
            await accept();
          } else {
            const held = activeCall()?.hold?.();
            if (!held) throw new Error("Не удалось удержать настоящий звонок");
            await sleep(100);
            if (action === "hold") await accept();
            requestLine({
              kind: "resume",
              cardId: "card",
              callId: action === "replacement" ? "replacement" : "incoming",
              phoneExt: "201",
              saved: held.saved,
            });
            await drain();
            if (action === "resume" || action === "replacement") await accept();
          }
          await sleep(100);
          const accepted = {
            ack: !!ack(),
            queue: (await outbox.list("review")).filter(
              (item) => item.event.type === "report_confirmed",
            ).length,
          };
          if (action === "replacement") {
            return {
              before,
              afterForeignAnswer,
              accepted,
              replacement: activeCall()?.hold?.()?.callId,
              ended: null,
            };
          }
          await sleep(6500);
          return {
            before,
            afterForeignAnswer,
            accepted,
            replacement: null,
            ended: {
              active: activeCall() !== null,
              hangups: (await outbox.list("review")).filter(
                (item) => item.event.type === "call_hangup",
              ).length,
            },
          };
        } finally {
          component.unmount();
          client.clear();
          await outbox.close();
        }
      }, action);
      expect(errors).toEqual([]);
      expect(result.afterForeignAnswer).toBe(0);
      expect(result.before).toEqual({ ack: true, active: true });
      expect(result.accepted).toEqual({
        ack: action === "new-delivery",
        queue: 0,
      });
      if (action === "replacement") {
        expect(result.replacement).toBe("replacement");
      } else {
        expect(result.ended).toEqual(
          action === "new-delivery"
            ? { active: true, hangups: 0 }
            : { active: false, hangups: 1 },
        );
      }
    } finally {
      await page.close();
    }
  },
  30_000,
);
