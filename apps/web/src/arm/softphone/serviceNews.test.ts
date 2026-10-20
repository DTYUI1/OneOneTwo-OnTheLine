import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, firefox, type Browser } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
let server: ViteDevServer;
let browser: Browser;
let origin: string;
const evidence = process.env.SERVICE_NEWS_EVIDENCE;
beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    base: "/app/",
    cacheDir:
      process.env.SERVICE_NEWS_CACHE ?? "node_modules/.vite-service-news",
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
        name: "service-news-harness",
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (!request.url?.includes("__service_news__")) return next();
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
});
interface EventFixture {
  key: string;
  kind: string;
  line: { text: string };
  expect: { action: string; phone_exts?: string[] }[];
}
const scenarioDir = new URL("../../../../../data/scenarios/", import.meta.url);
const catalog = readdirSync(scenarioDir)
  .filter((name) => name.endsWith(".json"))
  .flatMap((name) => {
    const scenario = JSON.parse(
      readFileSync(new URL(name, scenarioDir), "utf8"),
    ) as { events?: EventFixture[] };
    return (scenario.events ?? [])
      .filter((event) =>
        event.expect.some((item) => item.action === "call_service"),
      )
      .map((event) => ({ name, event }));
  });
const extId = (ext: string) =>
  (({ "105": "GKH", "106": "MOSLIFT" }) as Record<string, string>)[ext] ?? ext;
const asks = (event: EventFixture) =>
  event.expect
    .filter((item) => item.action === "call_service")
    .map((item) => item.phone_exts ?? []);
const needs = (event: EventFixture) =>
  asks(event)
    .flat()
    .find((ext) => ext !== "112");
const original = catalog.find(
  ({ name, event }) =>
    name === "fight-street-102-1.json" && event.key === "ambulance",
)!;
interface Setup {
  service: string;
  ext: string;
  text: string;
  called?: boolean;
  expired?: boolean;
  noDeadline?: boolean;
  options?: boolean;
  voiceOnly?: boolean;
  otherBrigade?: boolean;
  briefing?: boolean;
  newsMode?:
    | "enqueue-fail"
    | "rejected"
    | "late-rejected"
    | "pending"
    | "ambiguous";
  projectedNews?: { called_at: string; by?: string; told_at?: string } | null;
  pendingReadFails?: number;
  noScalar?: boolean;
  clockAt?: number;
}
async function mount(input: Setup) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}__service_news__`);
  const handle = await page.evaluateHandle(async (input) => {
    const load = new Function("url", "return import(url)") as (
      url: string,
    ) => Promise<unknown>;
    // Подменены HTTP/outbox и устройства; React, Softphone, обе машины и UI настоящие.
    window.fetch = async () => Response.json(training);
    const {
      mountComponent,
      sessionHarness,
      audioHarness,
      createElement: el,
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
    const { useHold } = (await load(
      "/app/src/arm/phone/useHold.ts",
    )) as typeof import("../phone/useHold");
    const { holdMark } = (await load(
      "/app/src/arm/phone/hold.ts",
    )) as typeof import("../phone/hold");
    const { PhoneContext, PhoneWindow, usePhoneState } = (await load(
      "/app/src/arm/phone/PhoneWindow.tsx",
    )) as typeof import("../phone/PhoneWindow");
    const { noteServiceDial } = (await load(
      "/app/src/arm/softphone/brigade/dials.ts",
    )) as typeof import("./brigade/dials");
    const h = sessionHarness();
    const audio = audioHarness();
    if (input.clockAt)
      Object.defineProperty(h.realtime, "clockOffsetMs", {
        get: () => input.clockAt! - Date.now(),
      });
    const outcomes = new Set<
      Parameters<typeof h.realtime.subscribeOutcomes>[0]
    >();
    h.realtime.subscribeOutcomes = (listener) => {
      outcomes.add(listener);
      return () => {
        outcomes.delete(listener);
      };
    };
    let newsMode = input.newsMode;
    let pendingNews: import("../../shared/ws/outbox").PendingEvent[] = [];
    let committedAt: string | null = null;
    const commitNews = () => {
      const at = committedAt ?? new Date().toISOString();
      for (const message of training.messages) {
        const delivery = message.delivery;
        const window =
          delivery.service_news ??
          (delivery.service_called_at
            ? {
                called_at: delivery.service_called_at,
                by: delivery.news_by ?? undefined,
              }
            : null);
        if (
          window &&
          Date.parse(at) >= Date.parse(window.called_at) &&
          (!window.by || Date.parse(at) <= Date.parse(window.by))
        )
          delivery.service_news = { ...window, told_at: at };
      }
    };
    const settleNews = (status: "accepted" | "rejected") => {
      if (status === "accepted") commitNews();
      newsMode = undefined;
      const items = pendingNews;
      pendingNews = [];
      for (const item of items)
        for (const listener of outcomes) listener({ status, item });
    };
    let pendingReadFails = input.pendingReadFails ?? 0;
    h.realtime.pending = async () => {
      if (pendingReadFails-- > 0) throw new Error("read unavailable");
      return pendingNews;
    };
    h.realtime.enqueue = async (cardId, event) => {
      if (event.type === "brigade_said" && newsMode === "enqueue-fail") {
        newsMode = undefined;
        throw new Error("storage unavailable");
      }
      h.events.push(event);
      const item = {
        id: event.client_event_id,
        cardId,
        event,
        userId: "review",
        queuedAt: Date.now(),
        sequence: h.events.length,
      };
      if (event.type === "brigade_said" && newsMode) {
        pendingNews.push(item);
        if (newsMode === "rejected") {
          newsMode = undefined;
          settleNews("rejected");
        } else if (newsMode === "ambiguous") throw new Error("lost response");
        return;
      }
      if (event.type === "brigade_said") commitNews();
      for (const listener of outcomes) listener({ status: "accepted", item });
    };
    h.client.setQueryData(
      ["services"],
      [
        {
          id: input.service,
          name: "Учебная служба",
          phone_ext: input.ext,
          voice_profile: "denis",
          is_active: true,
        },
      ],
    );
    h.client.setQueryData(["brigades", "102"], []);
    h.client.setQueryData(
      ["call-targets", "102"],
      [
        {
          id: "target",
          brigade_id: "brigade",
          service_id: "102",
          name: "Наряд",
          phone_ext: "201",
          voice_profile: "denis",
          is_active: true,
        },
      ],
    );
    const now = Date.now();
    const training = {
      card_id: "card",
      revision: 1,
      selected_brigade_ids: input.briefing ? [] : ["brigade"],
      messages: [
        {
          state: "presented",
          presented_at: new Date(now - 1000).toISOString(),
          reply_key: null,
          delivery: {
            delivery_id: crypto.randomUUID(),
            call_id: "original-call",
            brigade_id: input.otherBrigade ? "another-brigade" : "brigade",
            call_target_id: "target",
            delivered_at: new Date(now - 1000).toISOString(),
            needs_service: input.noScalar ? undefined : input.service,
            ...(input.projectedNews !== undefined
              ? { service_news: input.projectedNews }
              : {}),
            service_called_at: input.called
              ? new Date(now - 500).toISOString()
              : null,
            news_by:
              input.called && !input.noDeadline
                ? new Date(now + (input.expired ? -100 : 20000)).toISOString()
                : null,
            message: {
              id: crypto.randomUUID(),
              version: 1,
              text: input.text,
              audio: null,
            },
            reply_options: input.options
              ? [{ key: "ordinary", label: "Обычный ответ" }]
              : [],
            reply_by: null,
          },
        },
      ],
    };
    h.client.setQueryData(["card-training", "card"], structuredClone(training));
    h.client.setQueryData(
      ["cards"],
      [
        {
          id: "card",
          session_id: "session",
          source: {
            number: "100",
            incident_class: "Драка",
            description: "Учебное происшествие",
            address: {
              house: "1",
              building: "",
              apartment: "2",
              street: "Учебная",
            },
            service_ids: ["102"],
          },
        },
      ],
    );
    h.client.setQueryData(["session", "session"], {
      settings_snapshot: { voice_only: input.voiceOnly === true },
    });
    let hold!: ReturnType<typeof useHold>;
    let phone!: ReturnType<typeof usePhoneState>;
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
          cardId: "card",
          ownServiceId: "102",
          cardState: "accepted",
        }),
      );
    }
    let component = mountComponent(Harness, {}, h.Wrap);
    phone.show();
    requestLine({
      kind: "resume",
      cardId: "card",
      callId: "original-call",
      phoneExt: "201",
      saved: { lines: [], report: null, said: [], inbound: true },
    });
    return {
      ...h,
      component,
      audio,
      activeCall,
      requestLine,
      settleNews,
      remount() {
        component.unmount();
        component = mountComponent(Harness, {}, h.Wrap);
        phone.show();
        requestLine({
          kind: "resume",
          cardId: "card",
          callId: "replacement-call",
          phoneExt: "201",
          saved: { lines: [], report: null, said: [], inbound: true },
        });
      },
      commitAt(at: string) {
        committedAt = at;
      },
      setClock(at: number) {
        Object.defineProperty(h.realtime, "clockOffsetMs", {
          configurable: true,
          get: () => at - Date.now(),
        });
      },
      localDial() {
        noteServiceDial("card", input.service, Date.now());
        component.render({});
      },
      update(change: "called" | "expired" | "renew" | "other" | "multi") {
        const delivery = training.messages[0].delivery;
        if (change === "called") {
          delivery.service_called_at = new Date().toISOString();
          delivery.news_by = new Date(Date.now() + 20000).toISOString();
        }
        if (change === "expired")
          delivery.news_by = new Date(Date.now() - 1).toISOString();
        if (change === "renew") {
          const next = structuredClone(training.messages[0]);
          Object.assign(next.delivery, {
            delivery_id: crypto.randomUUID(),
            news_by: new Date(Date.now() + 20000).toISOString(),
            service_news: undefined,
          });
          training.messages.push(next);
        }
        if (change === "other")
          Object.assign(delivery, { brigade_id: "another-brigade" });
        if (change === "multi") {
          const next = structuredClone(training.messages[0]);
          Object.assign(next.delivery, {
            delivery_id: crypto.randomUUID(),
            needs_service: "104",
          });
          training.messages.push(next);
        }
        h.client.setQueryData(
          ["card-training", "card"],
          structuredClone(training),
        );
      },
    };
  }, input);
  await page.waitForFunction((r) => !!r.activeCall()?.hold, handle);
  return { page, handle, errors };
}
const generic = {
  service: "103",
  ext: "103",
  text: "Нужна помощь другой службы.",
};
it.each([
  { ...generic, text: original.event.line.text },
  { ...generic, ext: "112" },
])(
  "UI: hold → dial $ext → hangup → resume → manual news",
  async (input) => {
    const { page, handle, errors } = await mount(input);
    try {
      expect(
        await page
          .getByRole("button", { name: "По частям", exact: true })
          .isEnabled(),
      ).toBe(false);
      await page.getByRole("button", { name: "Удержать", exact: true }).click();
      await page
        .getByRole("button", { name: "К контактам", exact: true })
        .click();
      await page.getByRole("tab", { name: "Набор", exact: true }).click();
      await page
        .getByRole("textbox", { name: "Номер", exact: true })
        .fill(input.ext);
      await page
        .getByRole("button", { name: "Позвонить", exact: true })
        .click();
      await page.waitForFunction(
        (r) => r.events.some((event) => event.type === "call_answer"),
        handle,
        { timeout: 20000 },
      );
      await page
        .getByRole("button", { name: "Положить трубку", exact: true })
        .click();
      await page.evaluate((r) => r.update("called"), handle);
      await page.getByTitle(/^Снять с удержания:/).click();
      await page
        .getByRole("button", { name: "По частям", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Служба вызвана", exact: true })
        .click();
      await page.waitForFunction(
        (r) => r.events.some((event) => event.type === "brigade_said"),
        handle,
      );
      await expect
        .poll(() =>
          page
            .getByText("Вы сказали: Служба вызвана.", { exact: false })
            .count(),
        )
        .toBe(1);
      const result = await page.evaluate(
        (r) => ({ events: r.events, transcript: document.body.innerText }),
        handle,
      );
      expect(
        result.events
          .filter((event) => event.type === "brigade_said")
          .map((event) => event.payload),
      ).toEqual([{ call_id: "original-call", text: "Служба вызвана." }]);
      expect(
        result.events.some((event) => event.type === "brigade_reply"),
      ).toBe(false);
      expect(
        result.events
          .filter((event) => ["call_hold", "call_resume"].includes(event.type))
          .map((event) => event.payload),
      ).toEqual([{ call_id: "original-call" }, { call_id: "original-call" }]);
      expect(result.transcript).toContain("Вы сказали: Служба вызвана.");
      expect(result.transcript).toMatch(/Наряд: .*жд[её]м/i);
      expect(
        await page
          .getByRole("button", { name: "Служба вызвана", exact: true })
          .count(),
      ).toBe(0);
      expect(errors).toEqual([]);
      if (evidence) {
        writeFileSync(
          `${evidence}/ui-${input.ext}.json`,
          JSON.stringify(result, null, 2),
        );
        await page.screenshot({ path: `${evidence}/ui-${input.ext}.png` });
      }
    } finally {
      await page.close();
    }
  },
  30000,
);
it.each(catalog)(
  "catalog: $name / $event.key ($event.kind)",
  async ({ event }) => {
    const ext = needs(event);
    expect(ext, "в текущем каталоге есть проецируемая служба").toBeTruthy();
    expect(asks(event)).toHaveLength(1);
    const { page, errors } = await mount({
      service: extId(ext!),
      ext: ext!,
      text: event.line.text,
      called: true,
    });
    try {
      await page
        .getByRole("button", { name: "По частям", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Служба вызвана", exact: true })
        .click();
      await expect
        .poll(() =>
          page
            .getByText("Вы сказали: Служба вызвана.", { exact: false })
            .count(),
        )
        .toBe(1);
      expect(
        await page
          .getByText("Вы сказали: Служба вызвана.", { exact: false })
          .count(),
      ).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  },
  15000,
);
it.each(["101", "102", "103", "104", "105", "106"])(
  "generated IDs, no scenario options, service %s",
  async (ext) => {
    const { page, handle } = await mount({
      service: extId(ext),
      ext,
      text: "Запрошена дополнительная служба.",
      called: true,
      noDeadline: true,
    });
    try {
      await page
        .getByRole("button", { name: "По частям", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Служба вызвана", exact: true })
        .click();
      expect(
        await page.evaluate(
          (r) =>
            r.events.filter((event) => event.type === "brigade_said").length,
          handle,
        ),
      ).toBe(1);
    } finally {
      await page.close();
    }
  },
);
it.each([
  { name: "before call", input: {} },
  { name: "expired", input: { called: true, expired: true } },
  { name: "other brigade", input: { called: true, otherBrigade: true } },
  { name: "voice only", input: { called: true, voiceOnly: true } },
])("not offered: $name", async ({ input }) => {
  const { page, handle } = await mount({ ...generic, ...input });
  try {
    expect(
      await page
        .getByRole("button", { name: "По частям", exact: true })
        .isEnabled(),
    ).toBe(false);
    expect(
      await page
        .getByRole("button", { name: "Служба вызвана", exact: true })
        .count(),
    ).toBe(0);
    expect(
      await page.evaluate(
        (r) => r.events.filter((event) => event.type === "brigade_said").length,
        handle,
      ),
    ).toBe(0);
  } finally {
    await page.close();
  }
});
it("an unconfirmed local dial must not offer manual news", async () => {
  const { page, handle } = await mount(generic);
  try {
    await page.evaluate((r) => r.localDial(), handle);
    expect(
      await page
        .getByRole("button", { name: "По частям", exact: true })
        .isEnabled(),
    ).toBe(false);
  } finally {
    await page.close();
  }
});
it.each(["expired", "other"] as const)(
  "stale visible button rechecks %s before React commits",
  async (change) => {
    const { page, handle } = await mount({ ...generic, called: true });
    try {
      await page
        .getByRole("button", { name: "По частям", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Служба вызвана", exact: true })
        .waitFor();
      await page.evaluate(
        ({ r, change }) => {
          const button = document.querySelector<HTMLButtonElement>(
            '[data-reply="service-news"]',
          )!;
          r.update(change);
          button.click();
        },
        { r: handle, change },
      );
      expect(
        await page.evaluate(
          (r) =>
            r.events.filter((event) => event.type === "brigade_said").length,
          handle,
        ),
      ).toBe(0);
    } finally {
      await page.close();
    }
  },
);
it.each([false, true])("same-tick stale clicks, hold=%s", async (hold) => {
  const { page, handle } = await mount({ ...generic, called: true });
  try {
    await page.getByRole("button", { name: "По частям", exact: true }).click();
    await page
      .getByRole("button", { name: "Служба вызвана", exact: true })
      .waitFor();
    await page.evaluate(
      ({ r, hold }) => {
        const button = document.querySelector<HTMLButtonElement>(
          '[data-reply="service-news"]',
        )!;
        if (hold) r.activeCall()?.hold?.();
        button.click();
        button.click();
      },
      { r: handle, hold },
    );
    expect(
      await page.evaluate(
        (r) => r.events.filter((event) => event.type === "brigade_said").length,
        handle,
      ),
    ).toBe(hold ? 0 : 1);
  } finally {
    await page.close();
  }
});
it("briefing parts remain available and take precedence over service news", async () => {
  const { page } = await mount({ ...generic, called: true, briefing: true });
  try {
    await page.getByRole("button", { name: "По частям", exact: true }).click();
    expect(await page.locator('[data-reply="brief"]').count()).toBeGreaterThan(
      0,
    );
    expect(
      await page
        .getByRole("button", { name: "Служба вызвана", exact: true })
        .count(),
    ).toBe(0);
  } finally {
    await page.close();
  }
});
it("ordinary question keeps its original brigade_reply", async () => {
  const { page, handle } = await mount({ ...generic, options: true });
  try {
    await page.getByRole("button", { name: "По частям", exact: true }).click();
    await page
      .getByRole("button", { name: "Обычный ответ", exact: true })
      .click();
    const events = await page.evaluate((r) => r.events, handle);
    expect(
      events.filter((event) => event.type === "brigade_reply"),
    ).toHaveLength(1);
    expect(events.some((event) => event.type === "brigade_said")).toBe(false);
  } finally {
    await page.close();
  }
});
it("open parts tracks expiry and a fresh repeated request", async () => {
  const { page, handle } = await mount({ ...generic, called: true });
  try {
    await page.getByRole("button", { name: "По частям", exact: true }).click();
    const button = page.getByRole("button", {
      name: "Служба вызвана",
      exact: true,
    });
    await button.waitFor();
    await page.evaluate((r) => r.update("expired"), handle);
    await expect.poll(() => button.count()).toBe(0);
    await page.evaluate((r) => r.update("renew"), handle);
    await button.click();
    await expect.poll(() => button.count()).toBe(0);
    await page.evaluate((r) => r.update("renew"), handle);
    await button.click();
    await page.waitForFunction(
      (r) => r.events.some((event) => event.type === "brigade_said"),
      handle,
    );
    expect(
      await page.evaluate(
        (r) => r.events.filter((event) => event.type === "brigade_said").length,
        handle,
      ),
    ).toBe(2);
  } finally {
    await page.close();
  }
});
it("separate open service requests produce one generic brigade_said", async () => {
  const { page, handle } = await mount({ ...generic, called: true });
  try {
    await page.evaluate((r) => r.update("multi"), handle);
    await page.getByRole("button", { name: "По частям", exact: true }).click();
    await page
      .getByRole("button", { name: "Служба вызвана", exact: true })
      .click();
    await page.waitForFunction(
      (r) => r.events.some((event) => event.type === "brigade_said"),
      handle,
    );
    expect(
      await page.evaluate(
        (r) => r.events.filter((event) => event.type === "brigade_said").length,
        handle,
      ),
    ).toBe(1);
    expect(
      await page
        .getByRole("button", { name: "Служба вызвана", exact: true })
        .count(),
    ).toBe(0);
  } finally {
    await page.close();
  }
});

it.each([
  "enqueue-fail",
  "rejected",
  "late-rejected",
  "pending",
  "ambiguous",
] as const)("outcome correctness: %s", async (newsMode) => {
  const { page, handle, errors } = await mount({
    ...generic,
    called: true,
    newsMode,
  });
  try {
    await page.getByRole("button", { name: "По частям", exact: true }).click();
    const button = page.getByRole("button", {
      name: "Служба вызвана",
      exact: true,
    });
    await button.click();
    expect(
      await page
        .getByText("Вы сказали: Служба вызвана.", { exact: false })
        .count(),
    ).toBe(0);
    if (newsMode !== "enqueue-fail")
      await page.waitForFunction(
        (r) => r.events.some((event) => event.type === "brigade_said"),
        handle,
      );
    if (newsMode === "late-rejected")
      await page.evaluate((r) => r.settleNews("rejected"), handle);
    if (
      newsMode === "enqueue-fail" ||
      newsMode === "rejected" ||
      newsMode === "late-rejected"
    ) {
      await button.click();
    } else {
      await expect.poll(() => button.count()).toBe(0);
      await page.evaluate((r) => r.settleNews("accepted"), handle);
    }
    await expect
      .poll(() =>
        page.getByText("Вы сказали: Служба вызвана.", { exact: false }).count(),
      )
      .toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});
it.each(["112", "999"])(
  "server eligibility without scalar needs_service: %s",
  async (ext) => {
    const { page } = await mount({
      ...generic,
      ext,
      service: ext,
      noScalar: true,
      projectedNews: { called_at: new Date(Date.now() - 1000).toISOString() },
    });
    try {
      await page
        .getByRole("button", { name: "По частям", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Служба вызвана", exact: true })
        .click();
      await expect
        .poll(() =>
          page
            .getByText("Вы сказали: Служба вызвана.", { exact: false })
            .count(),
        )
        .toBe(1);
      expect(
        await page
          .getByText("Вы сказали: Служба вызвана.", { exact: false })
          .count(),
      ).toBe(1);
      expect(await page.getByText(/Понял, ждём\./).count()).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  },
);
it("explicit unmet AND projection overrides legacy scalar news window", async () => {
  const { page } = await mount({
    ...generic,
    called: true,
    projectedNews: null,
  });
  try {
    expect(
      await page
        .getByRole("button", { name: "По частям", exact: true })
        .isEnabled(),
    ).toBe(false);
  } finally {
    await page.close();
  }
});

const projectionCases = process.env.SERVICE_NEWS_PROJECTION_FIXTURE
  ? readFileSync(process.env.SERVICE_NEWS_PROJECTION_FIXTURE, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            kind: string;
            groups: string[][];
            eligible: boolean;
            delivery: {
              needs_service?: string;
              service_news: { called_at: string; by?: string } | null;
            };
          },
      )
  : [];
it.each(projectionCases)(
  "actual training_projection → UI: $kind / $groups / eligible=$eligible",
  async (row) => {
    const { page, handle } = await mount({
      ...generic,
      called: true,
      clockAt: Date.parse("2026-10-19T00:00:10Z"),
      noScalar: !row.delivery.needs_service,
      service: row.delivery.needs_service ?? "112",
      projectedNews: row.delivery.service_news,
    });
    try {
      const parts = page.getByRole("button", {
        name: "По частям",
        exact: true,
      });
      expect(await parts.isEnabled()).toBe(row.eligible);
      if (row.eligible) {
        await parts.click();
        await page
          .getByRole("button", { name: "Служба вызвана", exact: true })
          .click();
        await expect
          .poll(() =>
            page.evaluate(
              (r) => r.events.filter((e) => e.type === "brigade_said").length,
              handle,
            ),
          )
          .toBe(1);
      }
    } finally {
      await page.close();
    }
  },
);

it("late accepted news does not append an optimistic reply after real hold", async () => {
  const { page, handle } = await mount({
    ...generic,
    called: true,
    newsMode: "pending",
  });
  try {
    await page.getByRole("button", { name: "По частям", exact: true }).click();
    await page
      .getByRole("button", { name: "Служба вызвана", exact: true })
      .click();
    await page.getByRole("button", { name: "Удержать", exact: true }).click();
    await page.evaluate((r) => r.settleNews("accepted"), handle);
    expect(
      await page
        .getByText("Вы сказали: Служба вызвана.", { exact: false })
        .count(),
    ).toBe(0);
    expect(
      await page.evaluate(
        (r) => r.events.filter((e) => e.type === "brigade_said").length,
        handle,
      ),
    ).toBe(1);
  } finally {
    await page.close();
  }
});

it.each([0, 1])(
  "authoritative commit at deadline +%s ms survives late ACK without a false positive",
  async (late) => {
    const by = Date.now() + 2000;
    const { page, handle } = await mount({
      ...generic,
      called: true,
      newsMode: "pending",
      projectedNews: {
        called_at: new Date(by - 5000).toISOString(),
        by: new Date(by).toISOString(),
      },
    });
    try {
      await page
        .getByRole("button", { name: "По частям", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Служба вызвана", exact: true })
        .click();
      await page.evaluate(
        ({ r, at, clock }) => {
          r.commitAt(at);
          r.setClock(clock);
          r.settleNews("accepted");
        },
        { r: handle, at: new Date(by + late).toISOString(), clock: by + 10000 },
      );
      if (late) {
        await page.waitForTimeout(150);
        expect(await page.getByText(/Наряд: .*жд[её]м/i).count()).toBe(0);
      } else {
        await expect
          .poll(() => page.getByText(/Наряд: .*жд[её]м/i).count())
          .toBe(1);
      }
    } finally {
      await page.close();
    }
  },
);

it.each(["pending", "ack-while-unmounted", "accepted"])(
  "real remount/new call keeps semantic news identity: %s",
  async (mode) => {
    const { page, handle } = await mount({
      ...generic,
      called: true,
      newsMode: "pending",
    });
    const parts = () =>
      page.getByRole("button", { name: "По частям", exact: true });
    const newsButton = () =>
      page.getByRole("button", { name: "Служба вызвана", exact: true });
    try {
      await parts().click();
      await newsButton().click();
      await page.waitForFunction(
        (r) => r.events.some((event) => event.type === "brigade_said"),
        handle,
      );
      if (mode === "accepted") {
        await page.evaluate((r) => r.settleNews("accepted"), handle);
        await expect
          .poll(() =>
            page
              .getByText("Вы сказали: Служба вызвана.", { exact: false })
              .count(),
          )
          .toBe(1);
      }
      await page.evaluate((r) => {
        r.component.unmount();
      }, handle);
      if (mode === "ack-while-unmounted")
        await page.evaluate((r) => r.settleNews("accepted"), handle);
      await page.evaluate((r) => r.remount(), handle);
      await page.waitForFunction((r) => !!r.activeCall()?.hold, handle);
      if (mode === "pending") {
        await parts().click();
        await newsButton().click();
        await page.evaluate((r) => r.settleNews("accepted"), handle);
      } else if (await parts().isEnabled()) {
        await parts().click();
        if (await newsButton().count()) await newsButton().click();
      }
      await expect
        .poll(() =>
          page.evaluate((r) => {
            const training = r.client.getQueryData([
              "card-training",
              "card",
            ]) as {
              messages: { delivery: { service_news?: { told_at?: string } } }[];
            };
            return !!training.messages[0].delivery.service_news?.told_at;
          }, handle),
        )
        .toBe(true);
      expect(await newsButton().count()).toBe(0);
      expect(
        await page.evaluate(
          (r) =>
            r.events.filter((event) => event.type === "brigade_said").length,
          handle,
        ),
      ).toBe(1);
    } finally {
      await page.close();
    }
  },
);

it("real UI recovers the first pending-store read failure", async () => {
  const { page, handle } = await mount({
    ...generic,
    called: true,
    pendingReadFails: 1,
  });
  try {
    await page.getByRole("button", { name: "По частям", exact: true }).click();
    await page
      .getByRole("button", { name: "Служба вызвана", exact: true })
      .click();
    await expect
      .poll(() =>
        page.getByText("Вы сказали: Служба вызвана.", { exact: false }).count(),
      )
      .toBe(1);
    await page.waitForFunction(
      (r) => r.events.some((event) => event.type === "brigade_said"),
      handle,
    );
    expect(
      await page.evaluate(
        (r) => r.events.filter((event) => event.type === "brigade_said").length,
        handle,
      ),
    ).toBe(1);
  } finally {
    await page.close();
  }
});
