import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Реальные React/TanStack Query/Chromium; подменена только HTTP-граница.
// CAPABILITIES_EVIDENCE подключает проекции, сохранённые API-тестом с PostgreSQL.
const evidence = process.env.CAPABILITIES_EVIDENCE;
let server: ViteDevServer;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  const html = `<!doctype html><html><body><div id="root"></div>
    <script type="module">
      import React from 'react';
      import '/src/shared/tokens.css';
      import { createRoot } from 'react-dom/client';
      import { QueryClient, QueryClientProvider, useIsFetching } from '@tanstack/react-query';
      import { CorrectionPanel } from '/src/teacher/studio/CorrectionPanel.tsx';
      import { PacksPanel } from '/src/teacher/studio/PacksPanel.tsx';
      const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      window.__queries = client;
      function App() {
        const fetching = useIsFetching();
        return React.createElement(React.Fragment, null,
          React.createElement('output', { id: 'settled' }, String(fetching)),
          new URLSearchParams(location.search).has('packs')
            ? React.createElement(PacksPanel, { services: [{ id: '101', name: 'Пожарная охрана', is_active: true }], onOpenScenario: () => {} })
            : React.createElement(CorrectionPanel, { scenarioId: 'scenario', disabled: false, onBusy: () => {}, onReplaced: async () => {} }));
      }
      createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider, { client }, React.createElement(App)));
    </script></body></html>`;
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    cacheDir: resolve(
      evidence ?? "node_modules/.cache",
      "vite-ultrareview-capabilities",
    ),
    plugins: [
      react(),
      {
        name: "ultrareview-capabilities-harness",
        configureServer(instance) {
          instance.middlewares.use(
            "/ultrareview",
            async (_request, response) => {
              response.setHeader("Content-Type", "text/html");
              response.end(
                await instance.transformIndexHtml("/ultrareview", html),
              );
            },
          );
        },
      },
    ],
    optimizeDeps: {
      include: [
        "react",
        "react-dom/client",
        "react/jsx-runtime",
        "@tanstack/react-query",
        "openapi-fetch",
      ],
      noDiscovery: true,
    },
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0];
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

for (const provider of ["off", "mock", "local"] as const) {
  test(`G09: correction controls respect ${provider} API projection`, async () => {
    const page = await browser.newPage();
    try {
      const content = evidence
        ? JSON.parse(
            readFileSync(resolve(evidence, `content-${provider}.json`), "utf8"),
          )
        : { can_regenerate: provider === "local" };
      await page.route("**/api/scenarios/scenario/content", (route) =>
        route.fulfill({ json: content }),
      );
      await page.goto(`${origin}ultrareview`);
      await page.waitForFunction(
        `window.__queries?.getQueryState(['scenario-content', 'scenario'])?.status === 'success'`,
      );
      await expect.poll(() => page.locator("#settled").textContent()).toBe("0");
      const button = page.getByRole("button", {
        name: "Пересоздать",
        exact: true,
      });
      if (provider === "local") {
        await page.getByLabel("Замечание для ИИ").fill("Вопрос бригады позже");
        expect(await button.isEnabled()).toBe(true);
      } else {
        expect(await button.count()).toBe(0);
        expect(await page.getByLabel("Замечание для ИИ").count()).toBe(0);
      }
      if (evidence)
        await page.screenshot({
          path: resolve(evidence, `g09-ui-${provider}.png`),
        });
    } finally {
      await page.close();
    }
  }, 20_000);
}

test("G10: studio restores the pack job and Stop targets that pack", async () => {
  const page = await browser.newPage();
  try {
    const progress = evidence
      ? JSON.parse(
          readFileSync(resolve(evidence, "pack-progress.json"), "utf8"),
        )
      : {
          job: {
            id: "pack-job",
            kind: "generate",
            status: "pending",
            error: null,
          },
          completed: 0,
          total: 2,
          scenario_ids: [],
          pack_id: "pack",
          warnings: [],
          generation_state: "queued",
        };
    const listing = evidence
      ? JSON.parse(readFileSync(resolve(evidence, "jobs-list.json"), "utf8"))
      : [progress];
    const stopped = evidence
      ? JSON.parse(readFileSync(resolve(evidence, "pack-stopped.json"), "utf8"))
      : { ...progress, generation_state: "stopping" };
    const readJobs: string[] = [];
    const stopJobs: string[] = [];
    let current = progress;
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const job = url.pathname.match(/\/jobs\/([^/]+)\/(progress|stop)$/);
      if (job?.[2] === "progress") {
        readJobs.push(job[1]);
        return route.fulfill({ json: current });
      }
      if (job?.[2] === "stop") {
        stopJobs.push(job[1]);
        current = stopped;
        return route.fulfill({ json: stopped });
      }
      const value = url.pathname.endsWith("generation-jobs")
        ? listing
        : url.pathname.endsWith("generation-variety")
          ? { count: 2, variants_total: 2, variants_left: 2 }
          : url.pathname.endsWith("generation-categories")
            ? {}
            : [];
      return route.fulfill({ json: value });
    });
    await page.goto(`${origin}ultrareview?packs`);
    const stop = page.getByRole("button", { name: "Остановить", exact: true });
    await stop.waitFor({ state: "visible" });
    expect(readJobs[0]).toBe(progress.job.id);
    await stop.click();
    await page
      .getByRole("button", { name: "Останавливаем…", exact: true })
      .waitFor({ state: "visible" });
    expect(stopJobs).toEqual([progress.job.id]);
    expect(
      await page
        .getByRole("button", { name: "Останавливаем…", exact: true })
        .isDisabled(),
    ).toBe(true);
    expect(await page.getByRole("alert").count()).toBe(0);
    if (evidence)
      await page.screenshot({ path: resolve(evidence, "g10-ui-stop.png") });
  } finally {
    await page.close();
  }
}, 20_000);
