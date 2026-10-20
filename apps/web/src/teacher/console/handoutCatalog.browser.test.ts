import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type { QueryClient } from "@tanstack/react-query";
import type { Scenario, Session } from "./model";
import {
  catalog,
  history,
  lesson,
  scenarios,
} from "./handoutCatalog.testFixtures";

declare global {
  interface Window {
    __mountHandout: (legacy: boolean, session: Session) => void;
    __handoutQueries: QueryClient;
  }
}
let server: ViteDevServer;
let browser: Browser;
let origin: string;
const evidence = process.env.HANDOUT_CATALOG_EVIDENCE;
const cacheDir = mkdtempSync(join(tmpdir(), "handout-catalog-"));
const html = `<!doctype html><html lang="ru"><body><div id="root"></div>
<script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AddressedHandout } from '/src/teacher/console/AddressedHandout.tsx';
import { HandoutTab } from '/src/teacher/console/HandoutTab.tsx';
import '/src/shared/tokens.css';
const client = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Infinity}}});
const root = createRoot(document.getElementById('root'));
window.__handoutQueries = client;
window.__mountHandout = (legacy, session) => root.render(React.createElement(QueryClientProvider, {client}, React.createElement(legacy ? HandoutTab : AddressedHandout, {session})));
</script></body></html>`;
beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    base: "/app/",
    cacheDir,
    esbuild: { jsx: "automatic" },
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
        name: "handout-catalog-harness",
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (!request.url?.endsWith("__handout__")) return next();
            void vite.transformIndexHtml(request.url, html).then((body) => {
              response.setHeader("Content-Type", "text/html");
              response.end(body);
            });
          });
        },
      },
    ],
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0];
  browser = await chromium.launch({ headless: true });
  if (evidence) mkdirSync(evidence, { recursive: true });
}, 30000);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await server?.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

// Контролируем только HTTP: настоящие компоненты, React, QueryClient и generated API.
async function mount(
  page: Page,
  legacy: boolean,
  options: {
    failed?: string;
    held?: string;
    scenarioOrigin?: Scenario["origin"];
  } = {},
) {
  const boundary = {
    requests: [] as string[],
    failed: options.failed ?? "",
    catalog: [...catalog],
    scenarios: scenarios.map((item) => ({
      ...item,
      origin: options.scenarioOrigin ?? item.origin,
    })),
    posts: [] as { path: string; body: unknown }[],
  };
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    boundary.requests.push(path);
    if (route.request().method() === "POST") {
      boundary.posts.push({ path, body: route.request().postDataJSON() });
      await route.fulfill({
        status: 503,
        json: { code: "unavailable", message: "Тестовая граница записи" },
      });
      return;
    }
    if (path === options.held) await held;
    if (path === boundary.failed) {
      await route.fulfill({
        status: 503,
        json: { code: "unavailable", message: "Каталог временно недоступен" },
      });
      return;
    }
    if (path.endsWith("/assignment-batches") && legacy) {
      await route.fulfill({
        status: 501,
        json: { code: "not_implemented", message: "Пачки недоступны" },
      });
      return;
    }
    const data: Record<string, unknown> = {
      "/scenarios": boundary.scenarios,
      "/scenarios/playable": { scenario_ids: scenarios.map((item) => item.id) },
      "/practice/catalog": boundary.catalog,
      "/sessions/lesson/assignments": history,
      "/sessions/lesson/assignment-batches": [],
      "/users": [],
      "/services": [],
      "/materials": [],
      "/materials/by-session": [],
    };
    if (!(path in data)) throw new Error(`Неожиданный HTTP: ${path}`);
    await route.fulfill({ json: data[path] });
  });
  await page.goto(`${origin}__handout__`);
  await page.waitForFunction(() => typeof window.__mountHandout === "function");
  await page.evaluate(
    ({ legacy, lesson }) => window.__mountHandout(legacy, lesson),
    { legacy, lesson },
  );
  return { boundary, release };
}

const scenarioPicker = (page: Page) =>
  page.getByRole("combobox", { name: "Добавить задание", exact: true });
async function openPicker(page: Page) {
  await scenarioPicker(page).click();
}
async function chooseScenario(page: Page, id: string) {
  await openPicker(page);
  await page.locator(`[role="option"][value="${id}"]`).click();
}
it.each([false, true])(
  "новая ИИ-карточка первая в своей категории после обновления (legacy=%s)",
  async (legacy) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    try {
      const { boundary } = await mount(page, legacy);
      if (!legacy) await openPicker(page);
      await page
        .locator(
          legacy ? "#pick-lift-first" : "[role=option][value='lift-first']",
        )
        .waitFor({ state: "attached" });
      boundary.scenarios = boundary.scenarios.map((row) => ({
        ...row,
        is_manual: true,
      }));
      const additions = [
        {
          id: "ai-old",
          source: "lift-first",
          created_at: "2026-10-20T09:00:00Z",
        },
        {
          id: "ai-new",
          source: "lift-first",
          created_at: "2026-10-20T10:00:00Z",
        },
        {
          id: "ai-foreign",
          source: "foreign",
          created_at: "2026-10-20T11:00:00Z",
        },
      ];
      for (const item of additions) {
        const full = boundary.scenarios.find((row) => row.id === item.source)!;
        const entry = boundary.catalog.find((row) => row.id === item.source)!;
        boundary.scenarios.push({
          ...full,
          id: item.id,
          origin: "llm",
          is_manual: false,
          level: item.id === "ai-new" ? 4 : full.level,
          created_at: item.created_at,
        });
        boundary.catalog.push({
          ...entry,
          id: item.id,
          level: item.id === "ai-new" ? 4 : entry.level,
        });
      }
      await page.evaluate(() =>
        window.__handoutQueries.invalidateQueries({ queryKey: ["scenarios"] }),
      );
      if (!legacy) await openPicker(page);
      await page
        .locator(legacy ? "#pick-ai-new" : "[role=option][value='ai-new']")
        .waitFor({ state: "attached" });
      if (legacy) {
        expect(
          await page
            .locator('input[id^="pick-"]')
            .evaluateAll((nodes) => nodes.map((node) => node.id)),
        ).toEqual([
          "pick-ai-foreign",
          "pick-ai-new",
          "pick-ai-old",
          "pick-foreign",
          "pick-lift-first",
          "pick-lift-second",
        ]);
      } else {
        expect(
          await page
            .locator('[role="listbox"] [role="group"]')
            .evaluateAll((groups) =>
              groups.map((group) => ({
                label: group.getAttribute("aria-label"),
                ids: Array.from(
                  group.querySelectorAll<HTMLButtonElement>('[role="option"]'),
                ).map((option) => option.value),
              })),
            ),
        ).toEqual([
          {
            label: "Своя служба",
            ids: ["ai-new", "ai-old", "lift-first", "lift-second"],
          },
          {
            label: "Чужая служба — упражнение на неверную доставку",
            ids: ["ai-foreign", "foreign"],
          },
        ]);
        await page.getByLabel("Сортировка внутри служб").selectOption("manual");
        expect(
          await page
            .locator('[role="listbox"] [role="group"]')
            .evaluateAll((groups) =>
              groups.map((group) =>
                Array.from(
                  group.querySelectorAll<HTMLButtonElement>('[role="option"]'),
                ).map((option) => option.value),
              ),
            ),
        ).toEqual([
          ["lift-first", "lift-second", "ai-new", "ai-old"],
          ["foreign", "ai-foreign"],
        ]);
        await page
          .getByLabel("Сортировка внутри служб")
          .selectOption("level-asc");
        expect(
          await page
            .locator('[role="group"][aria-label="Своя служба"] [role="option"]')
            .evaluateAll((nodes) =>
              nodes.map((node) => (node as HTMLButtonElement).value),
            ),
        ).toEqual(["ai-old", "lift-first", "lift-second", "ai-new"]);
        await page
          .getByLabel("Сортировка внутри служб")
          .selectOption("catalog");
        expect(
          await page
            .locator('[role="group"][aria-label="Своя служба"] [role="option"]')
            .first()
            .getAttribute("value"),
        ).toBe("ai-new");
        await chooseScenario(page, "ai-new");
        expect(await page.locator("tbody tr").textContent()).toContain(
          `№ 70008602 · ${catalog[1].title} · ИИ`,
        );
      }
    } finally {
      await page.close();
    }
  },
);

it.each([
  { legacy: false, scenarioOrigin: "template" as const, label: "Шаблон" },
  { legacy: false, scenarioOrigin: "llm" as const, label: "ИИ" },
  { legacy: true, scenarioOrigin: "template" as const, label: "Шаблон" },
  { legacy: true, scenarioOrigin: "llm" as const, label: "ИИ" },
])(
  "номер и источник в выборе и плане: $legacy/$scenarioOrigin",
  async ({ legacy, scenarioOrigin, label }) => {
    const page = await browser.newPage();
    try {
      await mount(page, legacy, { scenarioOrigin });
      const title = `№ 70008602 · ${catalog[1].title} · ${label}`;
      if (!legacy) await openPicker(page);
      const picker = page.locator(
        legacy
          ? 'label[for="pick-lift-first"]'
          : "[role=option][value='lift-first']",
      );
      await picker.waitFor({ state: "attached" });
      expect(await picker.textContent()).toContain(title);
      if (!legacy) {
        await chooseScenario(page, "lift-first");
        expect(await page.locator("tbody tr").textContent()).toContain(title);
        expect(await page.locator("tbody tr").textContent()).toContain(
          "звонок заявителю, уточнение",
        );
      }
    } finally {
      await page.close();
    }
  },
);

it.each([false, true])(
  "общий ассортимент, точные названия и порядок (legacy=%s)",
  async (legacy) => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(5000);
    try {
      const { boundary } = await mount(page, legacy);
      if (legacy) {
        await page.locator('input[id^="pick-"]').first().waitFor();
        expect(
          await page
            .locator('input[id^="pick-"]')
            .evaluateAll((nodes) => nodes.map((node) => node.id)),
        ).toEqual(catalog.map((item) => `pick-${item.id}`));
        expect(
          await page.locator('label[for="pick-lift-first"]').textContent(),
        ).toBe(`№ 70008602 · ${catalog[1].title} · Шаблон`);
        expect(
          await page
            .locator("tr", { has: page.locator("#pick-lift-first") })
            .textContent(),
        ).toContain("звонок заявителю, уточнение");
        expect(
          await page
            .locator("tr", { has: page.locator("#pick-foreign") })
            .textContent(),
        ).toContain(
          "ловушка повтора адреса, просьба вызвать службу, молчание бригады, тревога",
        );
      } else {
        await openPicker(page);
        await page
          .locator("[role=option][value='lift-first']")
          .waitFor({ state: "attached" });
        expect(
          await page
            .locator('[role="listbox"] [role="group"]')
            .evaluateAll((groups) =>
              groups.map((group) =>
                Array.from(
                  group.querySelectorAll<HTMLButtonElement>('[role="option"]'),
                ).map((option) => option.value),
              ),
            ),
        ).toEqual([["lift-first", "lift-second"], ["foreign"]]);
        expect(
          await page.locator("[role=option][value='lift-first']").textContent(),
        ).toContain(catalog[1].title);
        expect(
          await page.locator("[role=option][value='lift-first']").textContent(),
        ).toContain("звонок заявителю, уточнение");
        expect(
          await page.locator("[role=option][value='foreign']").textContent(),
        ).toContain(
          "ловушка повтора адреса, просьба вызвать службу, молчание бригады, тревога",
        );
        await page
          .getByRole("button", { name: "Подобрать по службе и уровню" })
          .click();
        const rows = await page.locator("tbody tr").allTextContents();
        expect(rows).toHaveLength(2);
        expect(rows[0]).toContain(catalog[1].title);
        expect(rows[0]).toContain("звонок заявителю, уточнение");
        expect(rows[1]).toContain(catalog[2].title);
      }
      expect(boundary.requests).toContain("/practice/catalog");
      if (evidence)
        await page.screenshot({
          path: join(
            evidence,
            `assortment-${legacy ? "legacy" : "addressed"}.png`,
          ),
          fullPage: true,
        });
    } finally {
      await page.close();
    }
  },
  30000,
);

it.each(["/practice/catalog", "/scenarios"])(
  "ждёт обе проекции и не разрешает пустой подбор: %s",
  async (held) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    let release = () => {};
    try {
      ({ release } = await mount(page, false, { held }));
      await page
        .getByRole("heading", { name: "Задания по рабочим местам" })
        .waitFor();
      expect(
        await page
          .getByRole("button", { name: "Подобрать по службе и уровню" })
          .isDisabled(),
      ).toBe(true);
      expect(await scenarioPicker(page).isDisabled()).toBe(true);
      expect(await page.locator("body").textContent()).toContain(
        "Загружаем сценарии",
      );
      release();
      await openPicker(page);
      await page
        .locator("[role=option][value='lift-first']")
        .waitFor({ state: "attached" });
      expect(await scenarioPicker(page).isDisabled()).toBe(false);
    } finally {
      release();
      await page.close();
    }
  },
);

it.each([false, true])(
  "ошибка общего каталога не подменяет ассортимент полным списком (legacy=%s)",
  async (legacy) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    try {
      await mount(page, legacy, { failed: "/practice/catalog" });
      await page
        .getByRole("alert")
        .filter({ hasText: "Каталог временно недоступен" })
        .waitFor();
      expect(
        await page
          .locator("[role=option][value='hidden'], #pick-hidden")
          .count(),
      ).toBe(0);
      expect(
        await page
          .getByRole("button", {
            name: legacy ? "Раздать отмеченные" : "Выдать задания (0)",
          })
          .isDisabled(),
      ).toBe(true);
      expect(
        await page
          .getByRole("button", { name: "Повторить загрузку сценариев" })
          .count(),
      ).toBe(1);
    } finally {
      await page.close();
    }
  },
);

it.each([
  { legacy: false, failed: "/practice/catalog" },
  { legacy: true, failed: "/practice/catalog" },
  { legacy: false, failed: "/scenarios" },
  { legacy: true, failed: "/scenarios" },
])(
  "ошибка обновления сохраняет выбор и блокирует выдачу: $legacy/$failed",
  async ({ legacy, failed }) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    try {
      const { boundary } = await mount(page, legacy);
      if (legacy) await page.locator("#pick-lift-first").check();
      else await chooseScenario(page, "lift-first");
      const send = page.getByRole("button", {
        name: legacy ? "Раздать отмеченные" : "Выдать задания (1)",
      });
      expect(await send.isEnabled()).toBe(true);
      boundary.failed = failed;
      await page.evaluate(() =>
        window.__handoutQueries.invalidateQueries({ queryKey: ["scenarios"] }),
      );
      await page
        .getByRole("alert")
        .filter({ hasText: "Каталог временно недоступен" })
        .waitFor();
      expect(await send.isDisabled()).toBe(true);
      expect(
        await page
          .locator(legacy ? "#pick-lift-first" : 'input[role="combobox"]')
          .isDisabled(),
      ).toBe(true);
      if (legacy)
        expect(await page.locator("#pick-lift-first").isChecked()).toBe(true);
      else
        expect(await page.locator("tbody tr").textContent()).toContain(
          catalog[1].title,
        );
      boundary.failed = "";
      await page
        .getByRole("button", { name: "Повторить загрузку сценариев" })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Каталог временно недоступен" })
        .waitFor({ state: "hidden" });
      expect(await send.isEnabled()).toBe(true);
      if (legacy)
        expect(await page.locator("#pick-lift-first").isChecked()).toBe(true);
      else
        expect(await page.locator("tbody tr").textContent()).toContain(
          "звонок заявителю",
        );
      expect(boundary.posts).toEqual([]);
    } finally {
      await page.close();
    }
  },
);

it.each([false, true])(
  "исчезновение выбранного ID не удаляет задание молча (legacy=%s)",
  async (legacy) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    try {
      const { boundary } = await mount(page, legacy);
      if (legacy) {
        await page.locator("#pick-lift-first").check();
        await page.locator("#pick-lift-second").check();
      } else {
        await chooseScenario(page, "lift-first");
        await chooseScenario(page, "lift-second");
      }
      boundary.catalog = catalog.filter((item) => item.id !== "lift-first");
      await page.evaluate(() =>
        window.__handoutQueries.invalidateQueries({ queryKey: ["scenarios"] }),
      );
      if (!legacy) await openPicker(page);
      await page
        .locator(
          legacy ? "#pick-lift-first" : "[role=option][value='lift-first']",
        )
        .waitFor({ state: "detached" });
      expect(
        await page
          .getByRole("button", {
            name: legacy ? "Раздать отмеченные" : "Выдать задания (2)",
          })
          .isDisabled(),
      ).toBe(true);
      expect(
        await page
          .getByRole("alert")
          .filter({ hasText: /недоступ/ })
          .count(),
      ).toBeGreaterThan(0);
      if (!legacy) expect(await page.locator("tbody tr").count()).toBe(2);
      boundary.catalog = [...catalog];
      await page.evaluate(() =>
        window.__handoutQueries.invalidateQueries({ queryKey: ["scenarios"] }),
      );
      if (!legacy) await openPicker(page);
      await page
        .locator(
          legacy ? "#pick-lift-first" : "[role=option][value='lift-first']",
        )
        .waitFor({ state: "attached" });
      if (legacy)
        expect(await page.locator("#pick-lift-first").isChecked()).toBe(true);
      expect(
        await page
          .getByRole("button", {
            name: legacy ? "Раздать отмеченные" : "Выдать задания (2)",
          })
          .isEnabled(),
      ).toBe(true);
    } finally {
      await page.close();
    }
  },
);

it("ошибка playable не стирает ручной план автоматическим подбором", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  try {
    await mount(page, false, { failed: "/scenarios/playable" });
    await chooseScenario(page, "lift-first");
    expect(
      await page
        .getByRole("button", { name: "Подобрать по службе и уровню" })
        .isDisabled(),
    ).toBe(true);
    expect(
      await page
        .getByRole("button", { name: "Выдать задания (1)" })
        .isEnabled(),
    ).toBe(true);
    expect(await page.locator("tbody tr").textContent()).toContain(
      catalog[1].title,
    );
  } finally {
    await page.close();
  }
});

it("выданное вне каталога остаётся в истории полного списка", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  try {
    await mount(page, true, { failed: "/practice/catalog" });
    await page.evaluate((session) => window.__mountHandout(true, session), {
      ...lesson,
      status: "running",
    } satisfies Session);
    await page.getByRole("heading", { name: "Выданные задания" }).waitFor();
    await page.getByText("ждёт своего времени", { exact: true }).waitFor();
    expect(
      await page.getByText("Застревание в лифте", { exact: true }).count(),
    ).toBe(1);
    expect(
      await page.getByText("сценарий недоступен", { exact: true }).count(),
    ).toBe(0);
  } finally {
    await page.close();
  }
});

it.each([false, true])(
  "выдача сохраняет точные ID, версию и продолжение очереди (legacy=%s)",
  async (legacy) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    try {
      const { boundary } = await mount(page, legacy);
      if (legacy) await page.locator("#pick-lift-first").check();
      else await chooseScenario(page, "lift-first");
      const send = page.getByRole("button", {
        name: legacy ? "Раздать отмеченные" : "Выдать задания (1)",
      });
      await send.click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Тестовая граница записи" })
        .waitFor();
      expect(boundary.posts).toHaveLength(1);
      if (legacy) {
        expect(boundary.posts[0]).toMatchObject({
          path: "/sessions/lesson/assignments",
          body: {
            participant_id: "trainee",
            scenario_id: "lift-first",
            order: 2,
          },
        });
        expect(await page.locator("#pick-lift-first").isChecked()).toBe(true);
      } else {
        expect(boundary.posts[0]).toMatchObject({
          path: "/sessions/lesson/assignments/batch",
          body: {
            items: [
              {
                participant_id: "trainee",
                scenario_id: "lift-first",
                scenario_version: 2,
                order: 2,
                delay_from_start_s: 10,
                delivery_mode: "profile",
              },
            ],
          },
        });
        const retry = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().endsWith("/assignments/batch"),
        );
        await send.click();
        await retry;
        expect(boundary.posts).toHaveLength(2);
        expect(boundary.posts[1]).toEqual(boundary.posts[0]);
      }
    } finally {
      await page.close();
    }
  },
);

it.each([
  { legacy: false, catalogVersion: 2, scenarioVersion: 3 },
  { legacy: true, catalogVersion: 2, scenarioVersion: 3 },
  { legacy: false, catalogVersion: 3, scenarioVersion: 2 },
  { legacy: true, catalogVersion: 3, scenarioVersion: 2 },
])(
  "version mismatch blocks selected issuance after refetch: $legacy/$catalogVersion/$scenarioVersion",
  async ({ legacy, catalogVersion, scenarioVersion }) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    try {
      const { boundary } = await mount(page, legacy);
      if (legacy) {
        await page.locator("#pick-lift-first").check();
        await page.locator("#pick-lift-second").check();
      } else {
        await chooseScenario(page, "lift-first");
        await chooseScenario(page, "lift-second");
      }
      const send = page.getByRole("button", {
        name: legacy ? "Раздать отмеченные" : "Выдать задания (2)",
      });
      expect(await send.isEnabled()).toBe(true);
      boundary.catalog = catalog.map((item) =>
        item.id === "lift-first" ? { ...item, version: catalogVersion } : item,
      );
      boundary.scenarios = scenarios.map((item) =>
        item.id === "lift-first" ? { ...item, version: scenarioVersion } : item,
      );
      await page.evaluate(async () => {
        await window.__handoutQueries.invalidateQueries({
          queryKey: ["scenarios"],
        });
      });
      await page.waitForFunction(
        () =>
          window.__handoutQueries.isFetching({ queryKey: ["scenarios"] }) === 0,
      );
      // A valid selected item remains; the stale one must block the whole write.
      if (!legacy) await openPicker(page);
      await page
        .locator(
          legacy ? "#pick-lift-second" : "[role=option][value='lift-second']",
        )
        .waitFor({ state: "attached" });
      expect(await send.isDisabled()).toBe(true);
      expect(
        await page
          .locator(
            legacy ? "#pick-lift-first" : "[role=option][value='lift-first']",
          )
          .count(),
      ).toBe(0);
      await page
        .getByRole("alert")
        .filter({ hasText: /недоступ/ })
        .waitFor();
      if (!legacy) expect(await page.locator("tbody tr").count()).toBe(2);
      // Native disabled buttons must not dispatch even a partial assignment.
      await send.evaluate((button: HTMLButtonElement) => button.click());
      expect(boundary.posts).toEqual([]);
      boundary.catalog = [...catalog];
      boundary.scenarios = [...scenarios];
      await page.evaluate(async () => {
        await window.__handoutQueries.invalidateQueries({
          queryKey: ["scenarios"],
        });
      });
      if (!legacy) await openPicker(page);
      await page
        .locator(
          legacy ? "#pick-lift-first" : "[role=option][value='lift-first']",
        )
        .waitFor({ state: "attached" });
      expect(await send.isEnabled()).toBe(true);
      if (legacy)
        expect(await page.locator("#pick-lift-first").isChecked()).toBe(true);
      await send.click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Тестовая граница записи" })
        .waitFor();
      expect(boundary.posts).toHaveLength(1);
      expect(boundary.posts[0]).toMatchObject(
        legacy
          ? {
              path: "/sessions/lesson/assignments",
              body: { scenario_id: "lift-first" },
            }
          : {
              path: "/sessions/lesson/assignments/batch",
              body: {
                items: [
                  { scenario_id: "lift-first", scenario_version: 2 },
                  { scenario_id: "lift-second", scenario_version: 2 },
                ],
              },
            },
      );
    } finally {
      await page.close();
    }
  },
);
