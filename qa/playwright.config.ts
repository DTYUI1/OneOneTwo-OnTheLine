import { defineConfig } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./results",
  fullyParallel: false,
  // Database-тесты делят учётки и список занятий преподавателя.
  workers: process.env.E2E_DATABASE === "1" ? 1 : undefined,
  use: { baseURL, ignoreHTTPSErrors: true, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          command: "uv run --package arm112-api python -m app.api",
          url: "http://127.0.0.1:8000/api/health",
          reuseExistingServer: !process.env.CI,
          cwd: "..",
          env: { COOKIE_SECURE: "false" },
        },
        {
          command: "pnpm dev",
          url: baseURL + "/app/login",
          reuseExistingServer: !process.env.CI,
          cwd: "..",
        },
      ],
});
