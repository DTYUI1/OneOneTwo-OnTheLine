import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { login } from "./captain-fixture";

// TC-14: проверка гарнитуры из панели действий АРМ. Микрофон в Chromium подменён файлом с
// настоящей русской речью (голос бригады из data/voices), распознаёт стенд с `--stt local`.
const SPEECH = join(tmpdir(), "headset-check-speech.wav");
const SOURCE = join(__dirname, "../../data/voices/brigade/104/departure.ogg");
let canRecord = true;
try {
  if (!existsSync(SPEECH))
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      SOURCE,
      "-ar",
      "16000",
      "-ac",
      "1",
      SPEECH,
    ]);
} catch {
  canRecord = false;
}

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${SPEECH}`,
    ],
  },
});

test("Проверка гарнитуры показывает распознанную фразу", async ({ page }) => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");
  test.skip(!canRecord, "Нужен ffmpeg для речи в поддельном микрофоне");
  test.setTimeout(120_000);
  await login(page, "trainee03");
  await page.getByRole("button", { name: "Проверка гарнитуры" }).click();
  const panel = page.locator("[data-headset-check]");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Проверка гарнитуры");
  await panel.getByRole("button", { name: "Проверить наушники" }).click();
  await panel.getByRole("button", { name: "Проверить микрофон" }).click();
  await expect(panel.getByRole("meter")).toBeVisible();
  await page.waitForTimeout(3000);
  await panel.getByRole("button", { name: "Готово" }).click();
  const said = panel.locator("[data-headset-said]");
  await expect(said).toHaveText(/^Вы сказали: «.+»$/, { timeout: 90_000 });
  console.log(`HEADSET ${await said.textContent()}`);
});

test("Узкий экран: «Рабочее место — для большого экрана» и «Открыть всё равно»", async ({
  page,
}) => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");
  await page.setViewportSize({ width: 390, height: 844 });
  // login() открывает узкий экран сразу; здесь нужен именно щит, поэтому входим вручную.
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill("trainee03");
  await page
    .getByLabel("Пароль")
    .fill(process.env.DEMO_PASSWORD ?? "demo-local");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page
    .getByRole("button", { name: "Диспетчер служб" })
    .or(page.getByRole("button", { name: "Перейти в тренажёр" }))
    .click({ timeout: 5000 })
    .catch(() => undefined);
  await page
    .getByRole("button", { name: "Начать работу" })
    .click({ timeout: 3000 })
    .catch(() => undefined);
  await expect(
    page.getByRole("heading", { name: "Рабочее место — для большого экрана" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Открыть всё равно" }).click();
  await expect(
    page.getByRole("heading", { name: "Рабочее место — для большого экрана" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Проверка гарнитуры" }),
  ).toBeVisible();
});

test("Пустой кабинет преподавателя объясняет, что будет дальше", async ({
  page,
}) => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");
  await login(page, "teacher");
  await expect(
    page.getByRole("heading", { name: "Занятие не выбрано" }),
  ).toBeVisible();
  await expect(
    page.getByText("Выберите занятие слева или создайте новое"),
  ).toBeVisible();
});
