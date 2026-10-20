import { expect, type Locator } from "@playwright/test";
import { test, login } from "./captain-fixture";
import {
  callHead,
  contact,
  expectEnded,
  expectTalking,
  openPhone,
} from "./phone";

// Регрессии по снимкам капитана: запятая у даты, свой номер и кнопки телефона.
// Проверяется настоящий АРМ и звонок на отдельном стенде с PostgreSQL.
test.skip(process.env.E2E_DATABASE !== "1", "Нужен стенд с БД");

async function fullyVisible(target: Locator, container: Locator) {
  await expect(target).toBeVisible();
  const box = (await target.boundingBox())!;
  const outer = (await container.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(outer.x - 1);
  expect(box.y).toBeGreaterThanOrEqual(outer.y - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(outer.y + outer.height + 1);
  const clipped = await target.evaluate(
    (element) => element.scrollWidth > element.clientWidth + 1,
  );
  expect(clipped, "Элемент не должен обрезать свой текст").toBe(false);
}

test("Запятая остаётся у даты, а не начинает строку службы", async ({
  page,
}, testInfo) => {
  await page.clock.setFixedTime(new Date("2026-10-18T20:50:41Z"));
  await login(page, "trainee05");
  // Первый щелчок скрывает стартовую подсказку, иначе она перекрывает снимок часов.
  await page.getByRole("banner").click({ position: { x: 12, y: 12 } });
  const clock = page.locator('[data-help="arm-clock"]');
  const date = clock.locator("b");
  const service = date.locator("..").locator(":scope > span");
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1024, height: 600 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(clock).toBeVisible();
    await expect(service).not.toHaveText(/^\s*,/);
    await expect(date).toHaveText(/2026,$/);
    const commaSharesLine = await date.evaluate((element) => {
      const node = element.lastChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) return false;
      const text = node.textContent ?? "";
      const comma = document.createRange();
      comma.setStart(node, text.length - 1);
      comma.setEnd(node, text.length);
      const commaBox = comma.getBoundingClientRect();
      const year = document.createRange();
      if (text.length > 1) {
        year.setStart(node, text.length - 2);
        year.setEnd(node, text.length - 1);
      } else {
        const previous = node.previousSibling;
        if (!previous || previous.nodeType !== Node.TEXT_NODE) return false;
        const previousText = previous.textContent ?? "";
        year.setStart(previous, previousText.length - 1);
        year.setEnd(previous, previousText.length);
      }
      return Math.abs(commaBox.y - year.getBoundingClientRect().y) < 1;
    });
    expect(commaSharesLine).toBe(true);
    await clock.screenshot({
      path: testInfo.outputPath(`clock-${viewport.width}.png`),
    });
  }
});

test("Свой номер виден, звук переключается иконкой, завершение звонка справа снизу", async ({
  page,
  lesson,
}, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1366, height: 768 });
  await login(page, "trainee05");
  await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
  const win = await openPhone(page);
  const head = win.locator('[data-help="phone-frame"]');
  const own = head.locator('[title^="Ваш номер:"]');
  await fullyVisible(own, head);
  const ownNumber = (await own.innerText()).trim();
  expect(ownNumber).toMatch(/\+7/);
  await expect(
    win.getByRole("button", { name: "Объяснение телефона" }),
  ).toHaveCount(0);
  await expect(
    head.getByRole("button", { name: "?", exact: true }),
  ).toHaveCount(0);

  await contact(win, "Руководитель организации").click();
  await expectTalking(win);
  const hangup = win.getByRole("button", {
    name: "Положить трубку",
    exact: true,
  });
  const answer = win.getByRole("group", { name: "Ответ", exact: true });
  const mute = win.getByRole("button", {
    name: "Выключить звук разговора",
    exact: true,
  });
  await expect(hangup.locator("svg")).toHaveCount(1);
  await expect(hangup).toHaveText("");
  await expect(
    head.getByRole("button", { name: "Положить трубку", exact: true }),
  ).toHaveCount(0);
  await expect(mute.locator("svg")).toHaveCount(1);
  await expect(mute).toHaveText("");
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await mute.focus();
  // Пробел намеренно зарезервирован под push-to-talk даже при фокусе на кнопке.
  // Проверяем нативную активацию Enter, не меняя существующее управление разговором.
  await page.keyboard.press("Enter");
  const unmute = win.getByRole("button", {
    name: "Включить звук разговора",
    exact: true,
  });
  await expect(unmute).toHaveAttribute("aria-pressed", "false");
  await expect(unmute.locator("svg")).toHaveCount(1);
  await unmute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await expectTalking(win);

  // Узкое окно на обычном рабочем столе, затем низкий экран и узкий экран браузера.
  const grip = win.getByRole("button", {
    name: "Изменить размер окна телефона",
  });
  for (let count = 0; count < 8; count++) await grip.press("ArrowLeft");
  // Окно начинается с 600 px и сужается на 20 px за каждую стрелку.
  expect(Math.round((await win.boundingBox())!.width)).toBe(440);
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 744, height: 421 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(own).toHaveText(ownNumber);
    await fullyVisible(own, head);
    await fullyVisible(mute, head);
    await fullyVisible(hangup, win);
    const hangupBox = (await hangup.boundingBox())!;
    const winBox = (await win.boundingBox())!;
    const answerBox = (await answer.boundingBox())!;
    expect(hangupBox.x + hangupBox.width).toBeGreaterThan(
      winBox.x + winBox.width - 55,
    );
    expect(hangupBox.y + hangupBox.height).toBeGreaterThan(
      winBox.y + winBox.height - 65,
    );
    expect(hangupBox.y).toBeGreaterThanOrEqual(answerBox.y - 1);
    expect(hangupBox.y + hangupBox.height).toBeLessThanOrEqual(
      answerBox.y + answerBox.height + 1,
    );
    await win.screenshot({
      path: testInfo.outputPath(
        `phone-${viewport.width}x${viewport.height}.png`,
      ),
    });
  }
  // Свёрнутое окно сохраняет номер; разворачивание не обрывает разговор.
  await win.getByRole("button", { name: "Свернуть телефон" }).click();
  await fullyVisible(own, head);
  await win.getByRole("button", { name: "Развернуть телефон" }).click();
  await expect(callHead(win)).toHaveAttribute("data-call-state", "talking");
  await hangup.focus();
  await page.keyboard.press("Enter");
  await expectEnded(win);
  await expect(hangup).toHaveCount(0);
  await expect(own).toHaveText(ownNumber);
  expect(errors).toEqual([]);
});
