import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

declare global {
  interface Window {
    finalReviewCleanup?: () => void;
  }
}
let server: ViteDevServer;
let browser: Browser;
let origin: string;
const browserName =
  process.env.FINAL_BROWSER === "firefox" ? "firefox" : "chromium";
const evidence = process.env.FINAL_BROWSER_ARTIFACTS;
async function capture(page: Page, name: string, result: unknown) {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await page.screenshot({
    path: resolve(evidence, `${browserName}-${name}.png`),
    fullPage: true,
  });
  await writeFile(
    resolve(evidence, `${browserName}-${name}.json`),
    JSON.stringify(result, null, 2),
  );
}
async function newPage() {
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}__final_voice__`);
  return { page, errors };
}
async function cleanup(page: Page) {
  await page.evaluate(() => window.finalReviewCleanup?.());
  await page.close();
}
beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    base: "/app/",
    // Собственный кеш: параллельные проверки софтфона/перехвата не перезагружают страницу.
    cacheDir: `node_modules/.vite-final-voice-${browserName}-${process.pid}`,
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
        name: "final-voice-review",
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url?.includes("__final_voice__")) {
              response.setHeader("Content-Type", "text/html");
              response.end(
                '<!doctype html><html lang="ru"><body></body></html>',
              );
            } else next();
          });
        },
      },
    ],
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0];
  browser =
    browserName === "firefox"
      ? await firefox.launch({
          headless: true,
          firefoxUserPrefs: {
            "media.navigator.streams.fake": true,
            "media.volume_scale": "0.0",
          },
        })
      : await chromium.launch({
          headless: true,
          args: ["--mute-audio", "--use-fake-device-for-media-stream"],
        });
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(
      resolve(evidence, `${browserName}-runtime.json`),
      JSON.stringify(
        {
          browser: browserName,
          version: browser.version(),
          executable: (browserName === "firefox"
            ? firefox
            : chromium
          ).executablePath(),
          cacheDir: server.config.cacheDir,
        },
        null,
        2,
      ),
    );
  }
}, 30_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe("финальная браузерная приёмка наставника и телефона", () => {
  it("настоящие TrainerCoach/Mascot: переключение голоса и выключение фигуры гасят устройство, Escape подсказку не прячет", async () => {
    const { page, errors } = await newPage();
    try {
      await page.route("**/api/**", (route) => route.fulfill({ json: [] }));
      const result = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const { deviceBoundary, mountMascotToggle } = (await load(
          "/app/src/arm/trainer/finalVoiceHarness.tsx",
        )) as typeof import("./finalVoiceHarness");
        const devices = deviceBoundary();
        const { mountTrainer, tick } = (await load(
          "/app/src/arm/trainer/takeOverHarness.tsx",
        )) as typeof import("./takeOverHarness");
        const { trainerStore } = (await load(
          "/app/src/arm/trainer/trainerStore.ts",
        )) as typeof import("./trainerStore");
        const { MENTOR_LINES, voiceUrl, resetSaid } = (await load(
          "/app/src/shared/mascot/mentorVoice.ts",
        )) as typeof import("../../shared/mascot/mentorVoice");
        const { setMascotShown, setMascotVoice } = (await load(
          "/app/src/shared/mascot/mascotModel.ts",
        )) as typeof import("../../shared/mascot/mascotModel");
        const app = mountTrainer("together");
        const unmountToggle = mountMascotToggle();
        window.finalReviewCleanup = () => {
          app.unmount();
          unmountToggle();
        };
        setMascotShown(true);
        setMascotVoice(true);
        resetSaid();
        const target = document.querySelector<HTMLElement>(
          '[data-help="card-action"]',
        )!;
        target.insertAdjacentHTML(
          "beforeend",
          "<select><option>Статус</option></select>",
        );
        const line = MENTOR_LINES.find((candidate) => voiceUrl(candidate.id));
        if (!line) throw new Error("Нет записанной реплики наставника");
        const base = trainerStore.get().card!;
        const publish = (step: typeof base.step) =>
          trainerStore.setCard(
            { ...base, step, tip: { target: "action", text: line.text } },
            { cardElement: () => target.parentElement },
          );
        const snapshot = () =>
          devices.map(({ played, pauses, src }) => ({ played, pauses, src }));
        publish("decide");
        await tick();
        const initial = {
          image: !!document.querySelector("[data-mascot]"),
          text: document.body.textContent?.includes(line.text),
          devices: snapshot(),
        };
        document
          .querySelector<HTMLInputElement>(
            '[data-coach] input[type="checkbox"]',
          )!
          .click();
        await tick();
        const muted = snapshot();
        // Новый шаг при выключенном голосе не создаёт аудио; это не только проверка pause().
        publish("arrive");
        await tick();
        const quiet = snapshot();
        document
          .querySelector<HTMLInputElement>(
            '[data-coach] input[type="checkbox"]',
          )!
          .click();
        publish("work");
        await tick();
        // Спрятать подсказку нельзя (капитан, 19.10): ни ✕, ни Escape.
        const stepped = {
          hide: !!document.querySelector(
            '[aria-label="Скрыть подсказку до следующего шага"]',
          ),
          devices: snapshot(),
        };
        document
          .querySelector("[data-coach]")!
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
          );
        await tick();
        const escaped = {
          coach: !!document.querySelector("[data-coach]"),
          devices: snapshot(),
        };
        publish("decide");
        await tick();
        // Шаг decide уже озвучивался: сброс только тестового реестра сказанных реплик.
        resetSaid();
        publish("arrive");
        await tick();
        document
          .querySelector<HTMLButtonElement>(
            '[aria-label="Николай Сергеевич в подсказках"]',
          )!
          .click();
        await tick();
        const hiddenMascot = {
          image: !!document.querySelector("[data-mascot]"),
          text: document.body.textContent?.includes(line.text),
          devices: snapshot(),
        };
        document
          .querySelector<HTMLButtonElement>(
            '[aria-label="Николай Сергеевич в подсказках"]',
          )!
          .click();
        resetSaid();
        publish("decide");
        await tick();
        return {
          initial,
          muted,
          quiet,
          stepped,
          escaped,
          hiddenMascot,
          reenabled: {
            image: !!document.querySelector("[data-mascot]"),
            devices: snapshot(),
          },
        };
      });
      await capture(page, "mentor-voice", result);
      expect(result.initial.image).toBe(true);
      expect(result.initial.text).toBe(true);
      expect(result.initial.devices).toHaveLength(1);
      expect(result.initial.devices[0].played).toBe(1);
      expect(result.muted[0].pauses).toBeGreaterThanOrEqual(1);
      expect(result.quiet).toHaveLength(1);
      expect(result.stepped.hide).toBe(false);
      expect(result.stepped.devices.length).toBeGreaterThan(
        result.quiet.length,
      );
      expect(result.stepped.devices.at(-1)?.played).toBe(1);
      // Escape не прячет подсказку и не обрывает реплику.
      expect(result.escaped.coach).toBe(true);
      expect(result.escaped.devices).toEqual(result.stepped.devices);
      expect(result.hiddenMascot.image).toBe(false);
      expect(result.hiddenMascot.text).toBe(true);
      expect(result.hiddenMascot.devices.length).toBeGreaterThan(
        result.escaped.devices.length,
      );
      expect(result.hiddenMascot.devices.at(-1)?.pauses).toBeGreaterThanOrEqual(
        1,
      );
      expect(result.reenabled.image).toBe(true);
      expect(result.reenabled.devices.length).toBeGreaterThan(
        result.hiddenMascot.devices.length,
      );
      expect(result.reenabled.devices.at(-1)).toMatchObject({
        played: 1,
        pauses: 0,
      });
      expect(errors).toEqual([]);
    } finally {
      await cleanup(page);
    }
  }, 30_000);

  it.each(["watch", "expert"] as const)(
    "%s: Escape не скрывает управление, реальная ошибка query убирает якорь, fallback доступен",
    async (mode) => {
      const { page, errors } = await newPage();
      try {
        await page.route("**/api/**", (route) =>
          route.fulfill({
            status: 503,
            json: { code: "unavailable", message: "Учебный обрыв связи" },
          }),
        );
        const result = await page.evaluate(async (mode) => {
          const load = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<unknown>;
          const { deviceBoundary } = (await load(
            "/app/src/arm/trainer/finalVoiceHarness.tsx",
          )) as typeof import("./finalVoiceHarness");
          deviceBoundary();
          const { mountIncident, tick } = (await load(
            "/app/src/arm/trainer/takeOverHarness.tsx",
          )) as typeof import("./takeOverHarness");
          const { trainerStore } = (await load(
            "/app/src/arm/trainer/trainerStore.ts",
          )) as typeof import("./trainerStore");
          const { setMascotShown } = (await load(
            "/app/src/shared/mascot/mascotModel.ts",
          )) as typeof import("../../shared/mascot/mascotModel");
          const app = mountIncident(mode);
          window.finalReviewCleanup = app.unmount;
          setMascotShown(true);
          await tick();
          const anchor = document.querySelector('[data-help="line-confirm"]')!;
          trainerStore.setAnchor(anchor);
          const button = (text: string) =>
            [
              ...document.querySelectorAll<HTMLButtonElement>(
                "[data-coach] button",
              ),
            ].find((item) => item.textContent === text)!;
          const controls = () =>
            [
              ...document.querySelectorAll<HTMLButtonElement>(
                "[data-coach] button",
              ),
            ].map((item) => {
              const rect = item.getBoundingClientRect();
              return {
                text: item.textContent,
                visible:
                  getComputedStyle(item).visibility === "visible" &&
                  rect.width > 0 &&
                  rect.height > 0,
                inViewport:
                  rect.left >= 0 &&
                  rect.top >= 0 &&
                  rect.right <= innerWidth &&
                  rect.bottom <= innerHeight,
              };
            });
          const image = !!document.querySelector("[data-mascot]");
          document
            .querySelector("[data-coach]")!
            .dispatchEvent(
              new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
            );
          await tick();
          const escaped = {
            controls: controls(),
            close: !!document.querySelector(
              '[aria-label="Скрыть подсказку до следующего шага"]',
            ),
          };
          button("Пауза").click();
          await tick();
          await app.client.refetchQueries({ queryKey: ["session", "session"] });
          await tick();
          const coach = document.querySelector<HTMLElement>("[data-coach]")!;
          const rect = coach.getBoundingClientRect();
          const missing = {
            status: app.client.getQueryState(["session", "session"])?.status,
            cached: !!app.client.getQueryData(["session", "session"]),
            canAct: app.snapshot().card?.canAct,
            anchorConnected: anchor.isConnected,
            form: !!document.querySelector('[data-help="card-action"]'),
            fallback: coach.dataset.fallback,
            visible: getComputedStyle(coach).visibility,
            inViewport:
              rect.left >= 0 &&
              rect.top >= 0 &&
              rect.right <= innerWidth &&
              rect.bottom <= innerHeight,
            controls: controls(),
          };
          button("Продолжить").click();
          await tick();
          const resumed = app.snapshot().demo?.paused;
          button("Пауза").click();
          await tick();
          const paused = app.snapshot().demo?.paused;
          setMascotShown(false);
          await tick();
          const withoutMascot = {
            image: !!document.querySelector("[data-mascot]"),
            controls: controls(),
          };
          return { image, escaped, missing, resumed, paused, withoutMascot };
        }, mode);
        await capture(page, `${mode}-fallback`, result);
        expect(result.image).toBe(true);
        expect(result.escaped.close).toBe(false);
        expect(
          result.escaped.controls.some((item) => item.text === "Пауза"),
        ).toBe(true);
        expect(
          result.escaped.controls.every(
            (item) => item.visible && item.inViewport,
          ),
        ).toBe(true);
        expect(result.missing).toMatchObject({
          status: "error",
          cached: true,
          canAct: false,
          anchorConnected: false,
          form: false,
          fallback: "true",
          visible: "visible",
          inViewport: true,
        });
        expect(result.missing.controls.length).toBeGreaterThan(0);
        expect(
          result.missing.controls.every(
            (item) => item.visible && item.inViewport,
          ),
        ).toBe(true);
        expect(result.resumed).toBe(false);
        expect(result.paused).toBe(true);
        expect(result.withoutMascot.image).toBe(false);
        expect(result.withoutMascot.controls.length).toBeGreaterThan(0);
        expect(
          result.withoutMascot.controls.every(
            (item) => item.visible && item.inViewport,
          ),
        ).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await cleanup(page);
      }
    },
    30_000,
  );

  it("PR3-01: финальная смена возвращается в реестр, ACK виден и адресован линии, а не открывавшейся карточке", async () => {
    const { page, errors } = await newPage();
    let releaseAck: (() => void) | undefined;
    const traffic: unknown[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/"))
        traffic.push({
          at: Date.now(),
          method: request.method(),
          url: request.url(),
          body: request.postData(),
        });
    });
    page.on("response", async (response) => {
      if (response.url().includes("/api/"))
        traffic.push({
          at: Date.now(),
          url: response.url(),
          status: response.status(),
          body: await response.text().catch(() => "unavailable"),
        });
    });
    try {
      const fixture = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const { phoneFixture, ids } = (await load(
          "/app/src/arm/trainer/finalVoiceHarness.tsx",
        )) as typeof import("./finalVoiceHarness");
        return { ...phoneFixture(), ids };
      });
      const sent: {
        path: string;
        body: {
          type: string;
          client_event_id: string;
          payload: Record<string, unknown>;
        };
      }[] = [];
      const requests: string[] = [];
      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        requests.push(`${request.method()} ${path}`);
        if (path.endsWith("/events") && request.method() === "POST") {
          const body = request.postDataJSON() as (typeof sent)[number]["body"];
          sent.push({ path, body });
          if (body.type === "call_answer") fixture.training.incoming = [];
          if (body.type.includes("presented"))
            fixture.training.messages[0].state = "presented";
          if (body.type === "report_confirmed")
            await new Promise<void>((done) => {
              releaseAck = done;
            });
          await route.fulfill({ json: {} });
          return;
        }
        let json: unknown = [];
        if (path === `/api/cards/${fixture.ids.card}/training`)
          json = fixture.training;
        else if (path === `/api/cards/${fixture.ids.other}/training`)
          json = {
            card_id: fixture.ids.other,
            revision: 1,
            selected_brigade_ids: [],
            messages: [],
            missing_report_states: [],
          };
        else if (path === `/api/sessions/${fixture.ids.session}`)
          json = fixture.session;
        else if (path === "/api/sessions") json = [fixture.session];
        else if (path === "/api/cards") json = [fixture.card, fixture.other];
        else if (path.endsWith("/call-targets")) json = [fixture.target];
        await route.fulfill({ json });
      });
      await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const { mountPhone } = (await load(
          "/app/src/arm/trainer/finalVoiceHarness.tsx",
        )) as typeof import("./finalVoiceHarness");
        const app = mountPhone();
        window.finalReviewCleanup = app.unmount;
        app.realtime.start();
      });
      await page.locator('[data-help="phone-icon"]').click();
      expect(await page.title()).toBe("Происшествие 200");
      const answered = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname ===
            `/api/cards/${fixture.ids.card}/events` &&
          response.request().postDataJSON().type === "call_answer",
      );
      await page
        .locator('[data-help="phone-incoming"] [data-line="ringing"]')
        .click();
      // Сначала настоящий ответ на вызов; только затем уход с другой открытой карточки.
      const answerResponse = await answered;
      expect(answerResponse.status()).toBe(200);
      expect(answerResponse.request().postDataJSON()).toMatchObject({
        type: "call_answer",
        payload: { call_id: fixture.ids.call },
      });
      expect(await page.title()).toBe("Происшествие 200");
      await page.waitForFunction(() =>
        document.querySelector(
          '[data-help="card-phone"] [aria-label="Положить трубку"]',
        ),
      );
      await page.locator('[data-help="arm-tabs"] button').first().click();
      await page.waitForFunction(() => document.title === "ГБУ Система 112");
      const devices = await page.evaluateHandle(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const { audioDevices } = (await load(
          "/app/src/arm/trainer/finalVoiceHarness.tsx",
        )) as typeof import("./finalVoiceHarness");
        return audioDevices;
      });
      // Playwright 1.55 принимает Promise как truthy: async predicate завершал
      // ожидание даже с false. Импорт отдельно; polling проверяет реальный boolean.
      const ready = await page.waitForFunction(
        (audioDevices) => {
          for (const audio of audioDevices)
            if (!audio.ended && !audio.paused) audio.finish();
          const ack = document.querySelector<HTMLElement>(
            '[data-help="card-phone"] [data-reply="ack"]',
          );
          return (
            audioDevices.some(
              (audio) => audio.src === "/final-report.ogg" && audio.ended,
            ) &&
            !!ack &&
            ack.getBoundingClientRect().width > 0
          );
        },
        devices,
        { timeout: 15_000 },
      );
      expect(await ready.jsonValue()).toBe(true);
      await devices.dispose();
      await ready.dispose();
      const ack = page.locator('[data-help="card-phone"] [data-reply="ack"]');
      expect(await ack.isVisible()).toBe(true);
      expect(await ack.isEnabled()).toBe(true);
      const geometry = await ack.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          visibility: getComputedStyle(element).visibility,
          inViewport:
            rect.left >= 0 &&
            rect.top >= 0 &&
            rect.right <= innerWidth &&
            rect.bottom <= innerHeight,
        };
      });
      expect(geometry).toEqual({ visibility: "visible", inViewport: true });
      const beforeAck = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const { phoneSnapshot } = (await load(
          "/app/src/arm/trainer/finalVoiceHarness.tsx",
        )) as typeof import("./finalVoiceHarness");
        return phoneSnapshot();
      });
      expect(beforeAck.title).toBe("ГБУ Система 112");
      expect(
        beforeAck.controls.find((control) => control.reply === "ack"),
      ).toMatchObject({ visible: true, disabled: false });
      const presentation = sent.filter(
        (item) => item.body.type === "message_presented",
      );
      expect(presentation).toHaveLength(1);
      expect(presentation[0]).toMatchObject({
        path: `/api/cards/${fixture.ids.card}/events`,
        body: { payload: { delivery_id: fixture.ids.delivery } },
      });
      await capture(page, "registry-controls", {
        geometry,
        requests,
        sent,
        beforeAck,
      });
      // Подписка до щелчка; не выдаём durable enqueue за подтверждение сервера.
      const ackResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname ===
            `/api/cards/${fixture.ids.card}/events` &&
          response.request().postDataJSON().type === "report_confirmed",
      );
      await ack.click();
      const pending = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const { phoneApp } = (await load(
          "/app/src/arm/trainer/finalVoiceHarness.tsx",
        )) as typeof import("./finalVoiceHarness");
        for (let n = 0; n < 100; n += 1) {
          const items = (await phoneApp!.realtime.pending()).filter(
            (item) => item.event.type === "report_confirmed",
          );
          if (items.length) return items;
          await new Promise((done) => setTimeout(done, 20));
        }
        return [];
      });
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        cardId: fixture.ids.card,
        userId: fixture.ids.user,
        event: {
          type: "report_confirmed",
          payload: {
            call_id: fixture.ids.call,
            delivery_id: fixture.ids.delivery,
          },
        },
      });
      expect(pending[0].id).toBe(pending[0].event.client_event_id);
      expect(pending[0].event.client_event_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      for (let n = 0; n < 100 && !releaseAck; n += 1)
        await new Promise((done) => setTimeout(done, 20));
      expect(releaseAck).toBeTypeOf("function");
      releaseAck!();
      const response = await ackResponse;
      expect(response.status()).toBe(200);
      const confirmed = sent.filter(
        (item) => item.body.type === "report_confirmed",
      );
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0].body).toEqual(pending[0].event);
      expect(confirmed[0].path).toBe(`/api/cards/${fixture.ids.card}/events`);
      const remaining = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const { phoneApp } = (await load(
          "/app/src/arm/trainer/finalVoiceHarness.tsx",
        )) as typeof import("./finalVoiceHarness");
        for (let n = 0; n < 100; n += 1) {
          const items = await phoneApp!.realtime.pending();
          if (!items.length) return items;
          await new Promise((done) => setTimeout(done, 20));
        }
        return phoneApp!.realtime.pending();
      });
      expect(remaining).toEqual([]);
      const diagnostic = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const { phoneTimeline, phoneSnapshot } = (await load(
          "/app/src/arm/trainer/finalVoiceHarness.tsx",
        )) as typeof import("./finalVoiceHarness");
        return { timeline: phoneTimeline, final: phoneSnapshot() };
      });
      expect(
        diagnostic.final.outcomes.filter(
          (outcome) => outcome.item.id === pending[0].id,
        ),
      ).toEqual([{ status: "accepted", item: pending[0], code: undefined }]);
      await capture(page, "registry-ack", {
        ids: fixture.ids,
        geometry,
        pending,
        confirmed,
        remaining,
        requests,
        traffic,
        diagnostic,
        errors,
        httpBoundary: "fixture; PostgreSQL не использован",
      });
      expect(errors).toEqual([]);
    } catch (error) {
      const diagnostic = await page.evaluate(async () => {
        const load = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<unknown>;
        const { phoneTimeline, phoneSnapshot } = (await load(
          "/app/src/arm/trainer/finalVoiceHarness.tsx",
        )) as typeof import("./finalVoiceHarness");
        return { timeline: phoneTimeline, final: phoneSnapshot() };
      });
      await capture(page, "registry-failure", {
        errors,
        traffic,
        diagnostic,
        text: await page.locator("body").innerText(),
        html: await page.locator("body").innerHTML(),
      });
      throw error;
    } finally {
      releaseAck?.();
      await cleanup(page);
    }
  }, 40_000);
});
