// Два окна браузера для показа и записи ролика (TC-14, GP-18): слева преподаватель,
// справа обучаемый, логины уже введены. Запускает scripts/demo/show.sh; отдельно:
//   node scripts/demo/show-windows.mjs --url https://localhost:8443 --password demo-local
// Параметры: --teacher teacher, --trainee trainee03, --width 960, --height 900,
// --headless (без окон — проверка), --hold (держать окна, пока не нажат Ctrl+C).
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const url = option("url", "https://localhost:8443").replace(/\/$/, "");
const password = option("password", "demo-local");
const width = Number(option("width", "960"));
const height = Number(option("height", "900"));
const headless = flag("headless");
const seats = [
  { login: option("teacher", "teacher"), left: 0, role: "преподаватель" },
  { login: option("trainee", "trainee03"), left: width, role: "обучаемый" },
];

const browser = await chromium.launch({ headless });
let failed = false;
for (const seat of seats) {
  // Отдельный контекст — отдельные куки: два пользователя в одном браузере не мешают друг другу.
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width, height: height - 90 },
  });
  const page = await context.newPage();
  await page.goto(`${url}/app/login`);
  await page.getByLabel("Логин", { exact: true }).fill(seat.login);
  await page.getByLabel("Пароль").fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  try {
    await page.waitForURL((address) => !address.pathname.endsWith("/login"), {
      timeout: 15000,
    });
    console.log(`окно «${seat.role}»: вошли как ${seat.login}, ${page.url()}`);
  } catch {
    failed = true;
    console.error(`окно «${seat.role}»: не вошли как ${seat.login}`);
  }
  if (!headless) {
    const session = await context.newCDPSession(page);
    const { windowId } = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { left: seat.left, top: 0, width, height },
    });
  }
}
if (failed || headless || !flag("hold")) {
  await browser.close();
  process.exit(failed ? 1 : 0);
}
console.log("Окна открыты. Закройте их или нажмите Ctrl+C.");
browser.on("disconnected", () => process.exit(0));
