// Проверяем настоящее воспроизведение в Firefox до длинного e2e-прогона.
// При неработающем аудиовыходе CI завершается сразу; события и Audio не подменяются.
import { readFile } from "node:fs/promises";
import { expect, firefox } from "@playwright/test";

const sample = await readFile(
  new URL("../../data/voices/ruslan/listen.ogg", import.meta.url),
);
const browser = await firefox.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<button type="button">Прослушать</button>');
  await page.evaluate((base64) => {
    const audio = new Audio("data:audio/ogg;base64," + base64);
    window.audioCheck = { ended: false, error: null };
    audio.addEventListener("ended", () => {
      window.audioCheck.ended = true;
    });
    audio.addEventListener("error", () => {
      window.audioCheck.error = "Ошибка аудиоустройства или декодирования";
    });
    document.querySelector("button").onclick = () => {
      audio.play().catch((error) => {
        window.audioCheck.error = String(error);
      });
    };
  }, sample.toString("base64"));
  await page.getByRole("button", { name: "Прослушать", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.audioCheck), { timeout: 15_000 })
    .toEqual({ ended: true, error: null });
  console.log("Firefox: реплика воспроизведена, событие ended получено.");
} finally {
  await browser.close();
}
