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
const cacheDir = mkdtempSync(join(tmpdir(), "caller-prerequisite-tests-"));

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
            if (!request.url?.includes("__caller_prerequisites__"))
              return next();
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

it.each([
  { plot: "pipe_access", character: "calm" },
  { plot: "pipe_access", character: "confused" },
  { plot: "lift_location", character: "calm" },
  { plot: "lift_location", character: "confused" },
] as const)(
  "Softphone $plot/$character: prerequisites, тихий отбой, перезвон и согласие",
  async (setup) => {
    const { plot, character } = setup;
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await nativeMediaAPIspy(page);
      await page.goto(`${origin}__caller_prerequisites__`);
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
      expect(
        await page
          .getByRole("status", { name: "Подсказка разговора с заявителем" })
          .isVisible(),
      ).toBe(true);
      await parts.click();
      await page.locator('[data-caller="intro"]').click();
      // Подсказка видна до включения частей; раннее прощание не озвучивает обещание.
      const status = page
        .getByRole("status")
        .filter({ hasText: "Сначала уточните" });
      await expect.poll(() => status.count()).toBe(1);
      expect(await page.locator('[data-caller="come"]').count()).toBe(0);
      // Раннее прощание в настоящем компоненте заканчивается ровно одним отбоем.
      const beforeBye = await page.evaluate(
        (r) => r.events.filter((e) => e.type === "caller_said").length,
        handle,
      );
      await page.locator('[data-caller="bye"]').click();
      await page.waitForFunction(
        (r) => r.events.some((e) => e.type === "call_hangup"),
        handle,
        { timeout: 5000 },
      );
      expect(
        await page.evaluate(
          (r) => r.events.filter((e) => e.type === "caller_said").length,
          handle,
        ),
      ).toBe(beforeBye);
      expect(
        await page.evaluate(
          (r) => r.events.filter((e) => e.type === "call_hangup").length,
          handle,
        ),
      ).toBe(1);
      // Перезвон сохраняет память и не обходит prerequisites.
      await page
        .getByRole("button", { name: "Перезвонить", exact: true })
        .click();
      await page.waitForFunction(
        (r) => r.events.filter((e) => e.type === "caller_said").length > 1,
        handle,
        { timeout: 15000 },
      );
      await page.evaluate((r) => r.audio.forEach((a) => a.finish()), handle);
      await page.evaluate((r) => {
        const timer = setInterval(() => r.audio.forEach((a) => a.finish()), 50);
        Object.assign(r, { playbackTimer: timer });
      }, handle);
      expect(await page.locator('[data-caller="come"]').count()).toBe(0);
      const required =
        plot === "pipe_access" ? ["where", "eta", "box"] : ["where", "box"];
      for (const fact of required) {
        await page.locator(`[data-caller="${fact}"]`).click();
        await page.evaluate((r) => r.audio.forEach((a) => a.finish()), handle);
        if (await page.locator(`[data-caller="${fact}"]`).count()) {
          expect(await page.locator('[data-caller="come"]').count()).toBe(0);
          await page.locator(`[data-caller="${fact}"]`).click();
          await page.evaluate(
            (r) => r.audio.forEach((a) => a.finish()),
            handle,
          );
        }
      }
      expect(await page.locator('[data-caller="come"]').isVisible()).toBe(true);
      expect(
        await page
          .getByRole("status", { name: "Подсказка разговора с заявителем" })
          .textContent(),
      ).toContain("Теперь попросите");
      await page.locator('[data-caller="come"]').click();
      await page.waitForFunction(
        (r) =>
          r.events.some(
            (e) =>
              e.type === "caller_said" &&
              e.payload.phrase_id.includes(".agree."),
          ),
        handle,
      );
      expect(
        await page
          .getByRole("status", { name: "Подсказка разговора с заявителем" })
          .textContent(),
      ).toContain("передайте полученные сведения");
      expect(
        await page.evaluate(
          (r) =>
            r.events.filter(
              (e) =>
                e.type === "caller_said" &&
                e.payload.phrase_id.includes(".agree."),
            ).length,
          handle,
        ),
      ).toBe(1);
      await page.evaluate((r) => {
        clearInterval(
          (r as typeof r & { playbackTimer: number }).playbackTimer,
        );
        r.component.unmount();
      }, handle);
      expect(errors).toEqual([]);
      if (evidence)
        await page.screenshot({ path: `${evidence}/${plot}-${character}.png` });
    } catch (error) {
      console.error(await page.locator("body").innerText());
      throw error;
    } finally {
      await page.close();
    }
  },
  25000,
);
