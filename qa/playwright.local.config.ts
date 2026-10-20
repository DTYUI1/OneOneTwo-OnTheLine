// Временный локальный конфиг: системный Chrome и Firefox без звука. Не коммитить.
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  outputDir: "/tmp/claude-1000/-home-kirill-----------VSCode-Xakaton-OneOneTwoInTouch/8c65b4eb-a05d-403d-bd2b-a2ae9fc3393a/scratchpad/e2e-results",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: process.env.E2E_BASE_URL, ignoreHTTPSErrors: true, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { browserName: "chromium", channel: "chrome", launchOptions: { args: ["--mute-audio"] } } },
    { name: "firefox", use: { browserName: "firefox", launchOptions: { firefoxUserPrefs: { "media.volume_scale": "0.0" } } } },
  ],
});
