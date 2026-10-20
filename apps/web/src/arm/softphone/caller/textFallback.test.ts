import type { OutboxOutcome } from "../../../shared/ws/outbox";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, firefox, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
let server: ViteDevServer;
let browser: Browser;
let origin: string;
const evidence = process.env.CALLER_FALLBACK_EVIDENCE;
const cacheDir = mkdtempSync(join(tmpdir(), "caller-voiced-tests-"));

declare global {
  interface Window {
    __callerAudio: { src: string; finish: () => void }[];
  }
}

// Native media elements and real event listeners; only device playback is controlled.
async function nativeMediaAPIspy(page: Page) {
  await page.addInitScript(() => {
    window.__callerAudio = [];
    HTMLMediaElement.prototype.play = function () {
      Object.defineProperties(this, {
        paused: { configurable: true, value: false },
        duration: { configurable: true, value: 10 },
        ended: { configurable: true, value: false },
      });
      window.__callerAudio.push({
        src: this.getAttribute("src") ?? "",
        finish: () => {
          Object.defineProperty(this, "ended", {
            configurable: true,
            value: true,
          });
          this.dispatchEvent(new Event("ended"));
        },
      });
      this.dispatchEvent(new Event("playing"));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {
      Object.defineProperty(this, "paused", {
        configurable: true,
        value: true,
      });
    };
    HTMLMediaElement.prototype.load = function () {};
  });
}
beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    base: "/app/",
    cacheDir,
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
        name: "caller-fallback-harness",
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (!request.url?.includes("__caller_fallback__")) return next();
            response.setHeader("Content-Type", "text/html");
            response.end("<!doctype html><html><body></body></html>");
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
  if (evidence) mkdirSync(evidence, { recursive: true });
}, 30000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(cacheDir, { recursive: true, force: true });
});

// Only external HTTP/outbox and audio devices are replaced. Hooks, React and machines are real.
it.each([
  { character: "calm", missing: false },
  { character: "confused", missing: false },
  { character: "confused", missing: true },
] as const)(
  "$character greeting, controlled missing asset=$missing: exact text, audio and journal",
  async (setup) => {
    const page = await browser.newPage();
    try {
      await nativeMediaAPIspy(page);
      await page.goto(`${origin}__caller_fallback__`);
      const handle = await page.evaluateHandle(
        async ({ character, missing }) => {
          const load = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<unknown>;
          window.fetch = async () => Response.json([]);
          const {
            mountComponent,
            sessionHarness,
            createElement: el,
          } = (await load(
            "/app/src/arm/softphone/hookHarness.tsx",
          )) as typeof import("../hookHarness");
          const { useSoftphone } = (await load(
            "/app/src/arm/softphone/useSoftphone.ts",
          )) as typeof import("../useSoftphone");
          const { callerBook, callerAudio } = (await load(
            "/app/src/arm/softphone/caller/book.ts",
          )) as typeof import("./book");
          const h = sessionHarness();
          const outcomes = new Set<(outcome: OutboxOutcome) => void>();
          h.realtime.subscribeOutcomes = (listener) => {
            outcomes.add(listener);
            return () => outcomes.delete(listener);
          };
          h.realtime.enqueue = async (cardId, event) => {
            h.events.push(event);
            const item = {
              id: event.client_event_id,
              cardId,
              event,
              userId: "review",
              queuedAt: Date.now(),
              sequence: h.events.length,
            };
            for (const listener of outcomes)
              listener({ status: "accepted", item });
          };

          const audio = window.__callerAudio;
          const candidateBook = callerBook(character, "pipe_access");
          if (!candidateBook)
            throw new Error("Нет книги выбранного сюжета заявителя");
          // Deliberately missing test fixture, not a production plot without audio.
          const book = missing
            ? {
                ...candidateBook,
                slot: (slot: string) =>
                  candidateBook
                    .slot(slot)
                    .map((line) =>
                      slot === "answer"
                        ? { ...line, id: "CALLER_FIXTURE.answer.missing.1" }
                        : line,
                    ),
              }
            : candidateBook;
          const greeting = book.slot("answer")[0];
          const services = [
            {
              id: "GKH",
              name: "ДДС",
              phone_ext: "105",
              voice_profile: "denis",
              is_active: true,
            },
          ];
          h.client.setQueryData(["services"], services);
          let phone!: ReturnType<typeof useSoftphone>;
          function Probe() {
            phone = useSoftphone("greeting-card", ["GKH"], false, {
              targets: [],
              selectedBrigadeIds: [],
              ownServiceId: "GKH",
              contacts: [{ role: "caller", name: "Заявитель", number: "458" }],
              caller: { number: "458", book },
            });
            return el(
              "output",
              { "data-phase": phone.model.phase },
              phone.spoken?.text ?? "",
            );
          }
          const component = mountComponent(Probe, {}, h.Wrap);
          phone.dial("458");
          return {
            ...h,
            component,
            audio,
            greeting,
            hasAudio: callerAudio(greeting),
            get current() {
              return phone;
            },
          };
        },
        setup,
      );
      await page.waitForFunction((r) => r.current.speaking, handle, {
        timeout: 15000,
      });
      const before = await page.evaluate(
        (r) => ({
          phase: r.current.model.phase,
          text: r.greeting.text,
          audio: r.hasAudio,
          id: r.greeting.id,
          callId: r.current.model.callId,
          left: r.current.speechLeftMs(),
          played: r.audio.map((a) => a.src),
        }),
        handle,
      );
      expect(before.phase).toBe("reporting");
      expect(before.left).toBeGreaterThan(0);
      if (setup.missing) {
        expect(before.audio).toBeNull();
        expect(before.played).toEqual([]);
      } else {
        expect(before.audio).toContain(`/bank/${before.id}.ogg`);
        expect(before.played).toEqual([before.audio]);
      }
      expect(
        await page.getByText(before.text, { exact: true }).isVisible(),
      ).toBe(true);
      if (!setup.missing)
        await page.evaluate((r) => r.audio.at(-1)!.finish(), handle);
      await page.waitForFunction(
        (r) => r.current.model.phase === "reporting" && !r.current.speaking,
        handle,
      );
      expect(
        await page.evaluate(
          (r) =>
            r.events
              .filter((e) => e.type === "caller_said")
              .map((e) => e.payload.phrase_id),
          handle,
        ),
      ).toEqual([await page.evaluate((r) => r.greeting.id, handle)]);
      expect(
        await page.evaluate(
          (r) =>
            r.events
              .filter((e) => e.type === "caller_said")
              .map((e) => e.payload),
          handle,
        ),
      ).toEqual([{ call_id: before.callId, phrase_id: before.id }]);
      expect(
        await page.evaluate((r) => r.current.voiceNote, handle),
      ).toBeNull();
      await page.evaluate((r) => r.component.unmount(), handle);
    } finally {
      await page.close();
    }
  },
  25000,
);

it.each([
  { plot: "pipe_access", character: "calm" },
  { plot: "pipe_access", character: "confused" },
  { plot: "lift_location", character: "calm" },
  { plot: "lift_location", character: "confused" },
  { plot: "animal_shaft", character: "calm" },
  { plot: "animal_shaft", character: "confused" },
] as const)(
  "Softphone $plot/$character: controlled playback of exact visible phrase and its journal event",
  async (setup) => {
    const { plot, character } = setup;
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await nativeMediaAPIspy(page);
      await page.goto(`${origin}__caller_fallback__`);
      const handle = await page.evaluateHandle(async ({ plot, character }) => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const training = {
          card_id: "card",
          revision: 1,
          selected_brigade_ids: [],
          messages: [],
          caller: { plot, character },
        };
        window.fetch = async () => Response.json(training);
        const {
          mountComponent,
          sessionHarness,
          createElement: el,
        } = (await load(
          "/app/src/arm/softphone/hookHarness.tsx",
        )) as typeof import("../hookHarness");
        const { Softphone } = (await load(
          "/app/src/arm/softphone/Softphone.tsx",
        )) as typeof import("../Softphone");
        const { PhoneContext, PhoneWindow, usePhoneState } = (await load(
          "/app/src/arm/phone/PhoneWindow.tsx",
        )) as typeof import("../../phone/PhoneWindow");
        const { callerBook, callerAudio } = (await load(
          "/app/src/arm/softphone/caller/book.ts",
        )) as typeof import("./book");
        const h = sessionHarness();
        const outcomes = new Set<(outcome: OutboxOutcome) => void>();
        h.realtime.subscribeOutcomes = (listener) => {
          outcomes.add(listener);
          return () => outcomes.delete(listener);
        };
        h.realtime.enqueue = async (cardId, event) => {
          h.events.push(event);
          const item = {
            id: event.client_event_id,
            cardId,
            event,
            userId: "review",
            queuedAt: Date.now(),
            sequence: h.events.length,
          };
          for (const listener of outcomes)
            listener({ status: "accepted", item });
        };
        const audio = window.__callerAudio;
        const candidateBook = callerBook(character, plot);
        if (!candidateBook)
          throw new Error("Нет книги выбранного сюжета заявителя");
        const book = candidateBook;
        const answer = book.slot("tell_where")[0];
        const greeting = book.slot("answer")[0];
        const answers =
          answer.on === "first" ? book.slot("tell_where") : [answer];
        h.client.setQueryData(
          ["services"],
          [
            {
              id: "GKH",
              name: "Диспетчер",
              phone_ext: "105",
              voice_profile: "denis",
              is_active: true,
            },
          ],
        );
        h.client.setQueryData(["brigades", "GKH"], []);
        h.client.setQueryData(["call-targets", "GKH"], []);
        h.client.setQueryData(["card-training", "card"], training);
        h.client.setQueryData(["session", "session"], {
          settings_snapshot: {
            voice_only: false,
            phone_contacts: {
              GKH: [
                {
                  role: "caller",
                  name: "Заявитель",
                  number: "458",
                  character,
                },
              ],
            },
          },
        });
        h.client.setQueryData(
          ["cards"],
          [
            {
              id: "card",
              session_id: "session",
              source: {
                number: "100",
                incident_class: "Учебное происшествие",
                description: "Заявка",
                address: {
                  street:
                    plot === "pipe_access"
                      ? "улица Пришвина"
                      : plot === "lift_location"
                        ? "Профсоюзная улица"
                        : "Кировоградская улица",
                  house:
                    plot === "pipe_access"
                      ? "17"
                      : plot === "lift_location"
                        ? "98"
                        : "22",
                  building: "",
                  apartment: "",
                },
                service_ids: ["GKH"],
              },
            },
          ],
        );
        let phone!: ReturnType<typeof usePhoneState>;
        function Harness() {
          phone = usePhoneState([]);
          return el(
            PhoneContext.Provider,
            { value: phone },
            el(PhoneWindow, {
              title: "Телефон",
              idle: null,
              onAnswer: () => {},
            }),
            el(Softphone, {
              cardId: "card",
              ownServiceId: "GKH",
              cardState: "accepted",
            }),
          );
        }
        const component = mountComponent(Harness, {}, h.Wrap);
        phone.show();
        return {
          ...h,
          component,
          audio,
          answer,
          answers: answers.map((line) => ({
            ...line,
            audio: callerAudio(line),
          })),
          greeting: { ...greeting, audio: callerAudio(greeting) },
          hasAudio: callerAudio(answer),
        };
      }, setup);
      await page.getByText("Заявитель", { exact: true }).click();
      await page.waitForFunction(
        (r) => r.events.some((e) => e.type === "caller_said"),
        handle,
        { timeout: 15000 },
      );
      const greeting = await page.evaluate((r) => r.greeting, handle);
      expect(greeting.audio).toContain(`/bank/${greeting.id}.ogg`);
      expect(
        await page
          .getByText(greeting.text, { exact: true })
          .first()
          .isVisible(),
      ).toBe(true);
      expect(
        await page.evaluate((r) => r.audio.map((a) => a.src), handle),
      ).toContain(greeting.audio);
      await page.evaluate(
        (r) =>
          r.audio
            .filter((a) => a.src === r.greeting.audio)
            .forEach((a) => a.finish()),
        handle,
      );
      const parts = page.getByRole("button", {
        name: "По частям",
        exact: true,
      });
      await parts.click();
      await page.locator('[data-caller="intro"]').click();
      const answers = await page.evaluate((r) => r.answers, handle);
      for (const answer of answers) {
        await page.locator('[data-caller="where"]').click();
        await page.waitForFunction(
          (r) =>
            r.h.events.some(
              (e) => e.type === "caller_said" && e.payload.phrase_id === r.id,
            ),
          { h: handle, id: answer.id },
        );
        expect(answer.audio).toContain(`/bank/${answer.id}.ogg`);
        expect(
          await page
            .getByText(answer.text, { exact: true })
            .first()
            .isVisible(),
        ).toBe(true);
        expect(
          await page.evaluate(
            (r) => r.h.audio.map((a) => a.src).includes(r.url!),
            { h: handle, url: answer.audio },
          ),
        ).toBe(true);
        await page.evaluate(
          (r) =>
            r.h.audio.filter((a) => a.src === r.url).forEach((a) => a.finish()),
          { h: handle, url: answer.audio },
        );
      }
      const result = await page.evaluate(
        (r) => ({
          id: r.answer.id,
          text: r.answer.text,
          audio: r.hasAudio,
          said: r.events
            .filter((e) => e.type === "caller_said")
            .map((e) => e.payload.phrase_id),
          saidCalls: r.events
            .filter((e) => e.type === "caller_said")
            .map((e) => e.payload.call_id),
          dialCalls: r.events
            .filter((e) => e.type === "call_dial")
            .map((e) => e.payload.call_id),
          played: r.audio.map((a) => a.src),
        }),
        handle,
      );
      expect(result.audio).toContain(`/bank/${result.id}.ogg`);
      expect(result.said).toContain(result.id);
      expect(result.id).toContain(
        `CALLER_${character.toUpperCase()}.tell_where.`,
      );
      expect(
        await page.getByText(result.text, { exact: true }).first().isVisible(),
      ).toBe(true);
      const speech = result.played.filter((src: string) =>
        /bank\/|OFFICIAL|CALLER_|piper/i.test(src),
      );
      expect(speech).toEqual([
        greeting.audio,
        ...answers.map((answer) => answer.audio),
      ]);
      expect(result.said).toEqual([
        greeting.id,
        ...answers.map((answer) => answer.id),
      ]);
      expect(result.dialCalls).toHaveLength(1);
      expect(result.saidCalls).toEqual(
        result.said.map(() => result.dialCalls[0]),
      );
      expect(errors).toEqual([]);
      if (evidence)
        await page.screenshot({ path: `${evidence}/${plot}-${character}.png` });
      await page.evaluate((r) => r.component.unmount(), handle);
    } finally {
      await page.close();
    }
  },
  25000,
);
