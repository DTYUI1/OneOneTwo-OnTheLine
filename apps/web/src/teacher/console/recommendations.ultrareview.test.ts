import { afterAll, beforeAll, expect, test } from "vitest";
import {
  chromium,
  type Browser,
  type Page,
  type Route,
} from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const evidence = process.env.CAPABILITIES_EVIDENCE;
const trainee = evidence
  ? JSON.parse(readFileSync(resolve(evidence, "trainee.json"), "utf8"))
  : {
      id: "test-trainee",
      login: "test-trainee",
      full_name: "Учебный участник",
      role: "trainee",
      is_active: true,
      workstation_number: null,
      dds_service_id: "102",
    };
const services = evidence
  ? JSON.parse(readFileSync(resolve(evidence, "services.json"), "utf8"))
  : ["102", "GKH", "103"].map((id) => ({ id, name: id, is_active: true }));
const settings = evidence
  ? JSON.parse(readFileSync(resolve(evidence, "settings.json"), "utf8"))
  : {
      reaction_normative_s: 30,
      handling_normative_s: 180,
      critical_cap: 0.5,
      weights: {
        call: 1,
        address: 1,
        routing: 1,
        spelling: 0.5,
        status_flow: 1,
        brigade_work: 1,
        handling_time: 1,
        reaction_time: 1,
        required_fields: 1,
        comment_keywords: 1,
      },
      parallel_cards: 1,
      hints_level: 0,
      phone_contacts: {},
    };
const recommendations: Record<string, unknown[]> = evidence
  ? JSON.parse(readFileSync(resolve(evidence, "recommendations.json"), "utf8"))
  : Object.fromEntries(
      Object.entries({ legacy: 2, "102": 2, GKH: 4, "103": 1 }).map(
        ([key, recommended_level]) => [
          key,
          [
            {
              id: trainee.id,
              login: trainee.login,
              full_name: trainee.full_name,
              dds_service_id: "102",
              recommended_level,
              explanation: "История выбранной службы",
            },
          ],
        ],
      ),
    );
let server: ViteDevServer;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  const html = `<!doctype html><html><body><div id="root"></div><script type="module">
    import React from 'react';
    import '/src/shared/tokens.css';
    import { createRoot } from 'react-dom/client';
    import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
    import { SessionForm } from '/src/teacher/console/SessionForm.tsx';
    import { PacksPanel } from '/src/teacher/studio/PacksPanel.tsx';
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    window.__queries = client;
    const component = location.search.includes('studio')
      ? React.createElement(PacksPanel, { services: ${JSON.stringify(services)}, onOpenScenario: () => {} })
      : React.createElement(SessionForm, { onCreated: () => {} });
    createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider, { client }, component));
  </script></body></html>`;
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    cacheDir: resolve(
      evidence ?? "node_modules/.cache",
      "vite-ultrareview-recommendations",
    ),
    plugins: [
      react(),
      {
        name: "ultrareview-recommendations-harness",
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
        "react-dom",
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

async function prepare(page: Page, studio: boolean) {
  const requests: string[] = [];
  const submitted: {
    participants: { level: number; dds_service_id: string }[];
  }[] = [];
  const generated: {
    service_id: string;
    level: number;
    trainee_login: string;
  }[] = [];
  let holdService: string | null = null;
  let held: Route | null = null;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("generation-trainees")) {
      const service = url.searchParams.get("service_id") ?? "legacy";
      requests.push(service);
      if (service === holdService) {
        held = route;
        return;
      }
      return route.fulfill({ json: recommendations[service] });
    }
    if (
      url.pathname === "/api/sessions" &&
      route.request().method() === "POST"
    ) {
      submitted.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: { id: "new-session" } });
    }
    if (url.pathname === "/api/packs/generate") {
      generated.push(route.request().postDataJSON());
      return route.fulfill({
        status: 202,
        json: {
          id: "generated",
          kind: "generate",
          status: "pending",
          error: null,
        },
      });
    }
    if (url.pathname === "/api/jobs/generated/progress") {
      return route.fulfill({
        json: {
          job: {
            id: "generated",
            kind: "generate",
            status: "pending",
            error: null,
          },
          completed: 0,
          total: 1,
          scenario_ids: [],
          pack_id: "pack",
          warnings: [],
          generation_state: "queued",
        },
      });
    }
    const data =
      url.pathname === "/api/users"
        ? [trainee]
        : url.pathname === "/api/settings"
          ? settings
          : url.pathname === "/api/services"
            ? services
            : url.pathname === "/api/health"
              ? { ai_provider: "off" }
              : url.pathname.endsWith("generation-variety")
                ? { count: 3, variants_total: 3, variants_left: 3 }
                : url.pathname.endsWith("generation-categories")
                  ? {}
                  : url.pathname === "/api/ai/resource"
                    ? {
                        local_ai: false,
                        lesson_running: false,
                        generation_running: false,
                      }
                    : [];
    return route.fulfill({ json: data });
  });
  await page.goto(`${origin}ultrareview${studio ? "?studio" : ""}`);
  if (studio) {
    await page.getByLabel("Служба", { exact: true }).selectOption("102");
    await page
      .getByLabel("Для обучаемого", { exact: true })
      .fill(trainee.login);
    await page
      .getByRole("button", {
        name: `${trainee.full_name} (${trainee.login})`,
        exact: true,
      })
      .click();
  } else {
    await page.getByRole("button", { name: "Добавить рабочее место" }).click();
    await page
      .getByRole("combobox", { name: "Обучаемый", exact: true })
      .fill(trainee.login);
    await page
      .getByRole("listbox", { name: "Обучаемые" })
      .getByRole("option")
      .click();
    await expect
      .poll(() =>
        page
          .getByLabel("Уровень сложности", { exact: true })
          .getAttribute("placeholder"),
      )
      .toBe("2");
  }
  return {
    requests,
    submitted,
    generated,
    hold(service: string) {
      holdService = service;
    },
    async release() {
      await expect.poll(() => Boolean(held), { timeout: 2000 }).toBe(true);
      await held!.fulfill({ json: recommendations[holdService!] });
      held = null;
      holdService = null;
      await page.waitForFunction("window.__queries.isFetching() === 0");
    },
  };
}

test("G08: choosing a trainee keeps the already selected non-profile service", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  try {
    await page.route("**/api/**", (route) => {
      const url = new URL(route.request().url());
      const data = url.pathname.endsWith("generation-trainees")
        ? recommendations[url.searchParams.get("service_id") ?? "legacy"]
        : url.pathname.endsWith("generation-variety")
          ? { count: 3, variants_total: 3, variants_left: 3 }
          : url.pathname.endsWith("generation-categories")
            ? {}
            : [];
      return route.fulfill({ json: data });
    });
    await page.goto(`${origin}ultrareview?studio`);
    await page.getByLabel("Служба", { exact: true }).selectOption("GKH");
    await page
      .getByLabel("Для обучаемого", { exact: true })
      .fill(trainee.login);
    await page
      .getByRole("button", {
        name: `${trainee.full_name} (${trainee.login})`,
        exact: true,
      })
      .click();
    expect(await page.getByLabel("Служба", { exact: true }).inputValue()).toBe(
      "GKH",
    );
    expect(await page.getByLabel("Уровень", { exact: true }).inputValue()).toBe(
      "4",
    );
  } finally {
    await page.close();
  }
}, 20_000);

for (const studio of [false, true]) {
  test(`G08: ${studio ? "studio" : "lesson"} uses selected service without overwriting manual level`, async () => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    try {
      const state = await prepare(page, studio);
      const service = page.getByLabel(studio ? "Служба" : "Служба ДДС", {
        exact: true,
      });
      const level = page.getByLabel(studio ? "Уровень" : "Уровень сложности", {
        exact: true,
      });
      await service.selectOption("GKH");
      await expect
        .poll(
          () =>
            studio ? level.inputValue() : level.getAttribute("placeholder"),
          { timeout: 2000 },
        )
        .toBe("4");
      expect(state.requests).toContain("GKH");
      if (studio) await level.selectOption("3");
      else await level.fill("3");
      await service.selectOption("102");
      await page.waitForFunction("window.__queries.isFetching() === 0");
      expect(await level.inputValue()).toBe("3");
      // После смены подписи указатель может остаться над подсказкой соседнего поля.
      await page.mouse.move(0, 0);
      await page.getByRole("tooltip").waitFor({ state: "hidden" });
      if (evidence)
        await page.screenshot({
          path: resolve(evidence, `g08-ui-${studio ? "studio" : "lesson"}.png`),
        });
      if (!studio) {
        await page
          .getByRole("button", { name: "Создать занятие", exact: true })
          .click();
        await expect.poll(() => state.submitted.length).toBe(1);
        expect(state.submitted[0].participants[0]).toMatchObject({
          level: 3,
          dds_service_id: "102",
        });
      } else {
        await page
          .getByRole("button", { name: "Сгенерировать", exact: true })
          .click();
        await expect.poll(() => state.generated.length).toBe(1);
        expect(state.generated[0]).toMatchObject({
          level: 3,
          service_id: "102",
          trainee_login: trainee.login,
        });
      }
    } finally {
      await page.close();
    }
  }, 20_000);

  test(`G08: ${studio ? "studio" : "lesson"} ignores a late recommendation for the previous service`, async () => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    try {
      const state = await prepare(page, studio);
      const service = page.getByLabel(studio ? "Служба" : "Служба ДДС", {
        exact: true,
      });
      const level = page.getByLabel(studio ? "Уровень" : "Уровень сложности", {
        exact: true,
      });
      state.hold("GKH");
      await service.selectOption("GKH");
      await expect
        .poll(() => state.requests.includes("GKH"), { timeout: 2000 })
        .toBe(true);
      expect(
        await page
          .getByRole("button", {
            name: studio ? "Сгенерировать" : "Создать занятие",
            exact: true,
          })
          .isDisabled(),
      ).toBe(true);
      await service.selectOption("103");
      await expect
        .poll(
          () =>
            studio ? level.inputValue() : level.getAttribute("placeholder"),
          { timeout: 2000 },
        )
        .toBe("1");
      await state.release();
      expect(await service.inputValue()).toBe("103");
      expect(
        studio
          ? await level.inputValue()
          : await level.getAttribute("placeholder"),
      ).toBe("1");
    } finally {
      await page.close();
    }
  }, 20_000);
}

test("перед генерацией во время занятия предупреждает и позволяет отменить без отправки задания", async () => {
  const page = await browser.newPage();
  try {
    const state = await prepare(page, true);
    await page.route("**/api/ai/resource", (route) =>
      route.fulfill({
        json: {
          local_ai: true,
          lesson_running: true,
          generation_running: false,
        },
      }),
    );
    await page
      .getByRole("button", { name: "Сгенерировать", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Сейчас идёт занятие" });
    await dialog.waitFor();
    expect(await dialog.textContent()).toContain(
      "генерация может помешать работе обучаемых",
    );
    expect(
      await dialog.getByRole("button", { name: /После занятия/ }).count(),
    ).toBe(0);
    expect(state.generated).toHaveLength(0);
    await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
    expect(state.generated).toHaveLength(0);
    expect(await dialog.count()).toBe(0);
    await page
      .getByRole("button", { name: "Сгенерировать", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Сгенерировать сейчас", exact: true })
      .click();
    await expect.poll(() => state.generated.length).toBe(1);
    expect(state.generated[0]).toMatchObject({ generation_policy: "now" });
  } finally {
    await page.close();
  }
}, 20_000);
