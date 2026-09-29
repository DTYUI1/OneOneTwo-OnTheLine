import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  hold,
  moveTalkAside,
  openCall,
  questions,
  talk,
} from "./operator-call";

test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");
test.use({ viewport: { width: 1366, height: 650 } });

async function bounds(element: Locator) {
  const box = await element.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function dragTalk(page: Page, dx: number, dy: number) {
  const head = await bounds(talk(page).getByRole("heading"));
  const x = head.x + head.width / 2,
    y = head.y + head.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

async function inScreen(page: Page) {
  // setViewportSize завершается раньше события resize и ResizeObserver в странице.
  await expect(async () => {
    const rect = await bounds(talk(page));
    const viewport = page.viewportSize()!;
    expect(rect.x).toBeGreaterThanOrEqual(8);
    expect(rect.y).toBeGreaterThanOrEqual(8);
    expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width - 7);
    expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height - 7);
  }).toPass({ timeout: 3000 });
}

async function scrollSettled(column: Locator) {
  // Firefox продолжает плавный Page Down после первого изменения scrollTop.
  await column.evaluate(
    (el) =>
      new Promise<void>((resolve) => {
        let previous = el.scrollTop,
          stableFrames = 0;
        const check = () => {
          const current = el.scrollTop;
          stableFrames = current === previous ? stableFrames + 1 : 0;
          previous = current;
          if (stableFrames >= 4) resolve();
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }),
  );
}

test("длинный разбор: обе колонки листаются колесом и клавиатурой, кнопки остаются на виду", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openCall(page, "dtp_victims_fuel");
  for (let i = 0; i < 15; i++) await hold(page);
  await page.getByRole("button", { name: "сохранить", exact: true }).click();
  const result = page.getByRole("dialog", { name: "Результат попытки" });
  await expect(result).toBeVisible();
  const rect = await bounds(result);
  expect(rect.y).toBeGreaterThanOrEqual(15);
  expect(rect.y + rect.height).toBeLessThanOrEqual(635);
  const score = result.getByRole("region", { name: "Результат попытки" });
  const review = result.getByRole("region", { name: "Разбор звонка" });
  const close = result.getByRole("button", { name: "Закрыть", exact: true });
  const closeBox = await bounds(close);
  expect(closeBox.y + closeBox.height).toBeLessThan((await bounds(review)).y);
  expect(closeBox.y + closeBox.height).toBeLessThan((await bounds(score)).y);
  expect(
    await review
      .getByRole("list", { name: "Лента разговора" })
      .getByRole("listitem")
      .count(),
  ).toBeGreaterThanOrEqual(17);
  for (const column of [review, score]) {
    const other = column === score ? review : score;
    const otherBefore = await other.evaluate((el) => el.scrollTop);
    await column.hover();
    await page.mouse.wheel(0, 350);
    await expect
      .poll(() => column.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    await scrollSettled(column);
    expect(await other.evaluate((el) => el.scrollTop)).toBe(otherBefore);
    expect(await bounds(close)).toEqual(closeBox);
    await column.evaluate((el) => {
      el.scrollTo({ top: 0, behavior: "instant" });
    });
    await column.focus();
    await page.keyboard.press("PageDown");
    await expect
      .poll(() => column.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    await scrollSettled(column);
    expect(await other.evaluate((el) => el.scrollTop)).toBe(otherBefore);
    for (const name of ["Пройти заново", "Закрыть разбор"]) {
      await expect(result.getByRole("button", { name })).toBeInViewport({
        ratio: 1,
      });
    }
  }
  // При одной колонке прокручивается общее содержимое, шапка и кнопки остаются на виду.
  await page.setViewportSize({ width: 900, height: 650 });
  const stackedScore = await bounds(score);
  expect((await bounds(review)).y).toBeGreaterThanOrEqual(
    stackedScore.y + stackedScore.height,
  );
  const body = score.locator("..");
  await body.hover();
  await page.mouse.wheel(0, 400);
  await expect
    .poll(() => body.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  expect((await bounds(close)).y + closeBox.height).toBeLessThan(
    (await bounds(body)).y,
  );
  await close.click();
  await expect(result).toHaveCount(0);
});

test("повтор адреса появляется только после улицы, ребёнок в лифте получает полный балл за тип", async ({
  page,
}) => {
  await openCall(page, "elevator_stuck");
  await expect(questions(page).getByRole("button")).toHaveCount(3);
  await expect(
    questions(page).getByRole("button", { name: /^Проверю адрес/ }),
  ).toHaveCount(0);
  await page
    .getByLabel("Улица:", { exact: true })
    .fill("Новочерёмушкинская улица");
  await expect(questions(page).getByRole("button")).toHaveCount(4);
  await expect(
    questions(page).getByRole("button", {
      name: /^Проверю адрес: Новочерёмушкинская улица/,
    }),
  ).toBeVisible();
  await page
    .getByLabel("Тип происшествия", { exact: true })
    .fill("Застревание в лифте");
  // Проверяем и уточнение типа через признак, как в опросной карте АРМ.
  await page
    .getByRole("button", { name: "Застревание в лифте ЛИФТ", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Дети до 10 лет без сопровождения взрослых",
      exact: true,
    })
    .click();
  const services = page.getByRole("list", { name: "Службы", exact: true });
  await expect(services.getByRole("listitem")).toHaveCount(2);
  await expect(services).toContainText("Служба 101");
  await expect(services).toContainText("Мослифт");
  await expect(
    page.getByRole("button", { name: "Прокрутить службы" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "сохранить", exact: true }).click();
  const criterion = page
    .getByRole("dialog", { name: "Результат попытки" })
    .getByRole("listitem")
    .filter({ hasText: "Тип происшествия определён верно" });
  await expect(criterion).toContainText("15 / 15");
  await expect(criterion).toContainText("ребенок без взрослых");
});

test("дубль типа из группы «Ребенок в опасности» засчитан, «Пострадавшие» до выбора типа остаются", async ({
  page,
}) => {
  await openCall(page, "elevator_stuck");
  // Разбор капитана 29.09: отметка справа, нажатая до выбора типа, пропадала молча.
  const victims = page.getByRole("button", {
    name: "Пострадавшие",
    exact: true,
  });
  await victims.click();
  await page
    .getByLabel("Тип происшествия", { exact: true })
    .fill("Ребенок застрял в лифте");
  await page
    .getByRole("button", {
      name: "Ребенок застрял в лифте Ребенок в опасности",
      exact: true,
    })
    .click();
  await expect(victims).toHaveAttribute("aria-pressed", "true");
  // Мальчик не пострадал — снимаем отметку, службы как у эталона: 101 и Мослифт.
  await victims.click();
  const services = page.getByRole("list", { name: "Службы", exact: true });
  await expect(services.getByRole("listitem")).toHaveCount(2);
  await page.getByRole("button", { name: "сохранить", exact: true }).click();
  const criterion = page
    .getByRole("dialog", { name: "Результат попытки" })
    .getByRole("listitem")
    .filter({ hasText: "Тип происшествия определён верно" });
  await expect(criterion).toContainText("15 / 15");
  await expect(criterion).toContainText(
    "то же, что «Застревание в лифте (ребенок без взрослых)»",
  );
});

test("окно перемещается мышью и стрелками, остаётся в экране и помнит место; новый звонок — развёрнут", async ({
  page,
}) => {
  const panel = await openCall(page, "dtp_victims_fuel", { moveAside: false });
  const before = await bounds(panel);
  expect(before.x + before.width / 2).toBeCloseTo(1366 / 2, 0);
  expect(before.y + before.height / 2).toBeCloseTo(650 / 2, 0);
  await dragTalk(page, -160, -90);
  let moved = await bounds(panel);
  expect(moved.x).toBeCloseTo(before.x - 160, 0);
  expect(moved.y).toBeCloseTo(before.y - 90, 0);
  const grip = panel.getByRole("button", {
    name: "Переместить окно разговора",
    exact: true,
  });
  await grip.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  moved = await bounds(panel);
  expect(moved.x).toBeCloseTo(before.x - 180, 0);
  expect(moved.y).toBeCloseTo(before.y - 110, 0);
  await panel.getByRole("button", { name: "Слышу, записываю" }).click();
  expect(await bounds(panel)).toEqual(moved);
  await page.reload();
  await page
    .getByRole("button", { name: "Принять вызов", exact: true })
    .click();
  await expect
    .poll(async () => (await bounds(panel)).x)
    .toBeCloseTo(moved.x, 0);
  await expect
    .poll(async () => (await bounds(panel)).y)
    .toBeCloseTo(moved.y, 0);
  await dragTalk(page, -2000, -1500);
  await inScreen(page);
  expect((await bounds(panel)).x).toBe(8);
  expect((await bounds(panel)).y).toBe(8);
  await dragTalk(page, 2600, 1700);
  await inScreen(page);
  await page.setViewportSize({ width: 1100, height: 600 });
  await inScreen(page);
  await panel
    .getByRole("button", { name: "Свернуть разговор", exact: true })
    .click();
  await expect(panel.getByRole("heading")).toBeVisible();
  await expect(questions(page)).toBeHidden();
  // Замечание капитана 29.09: свёрнутость не переносится на новый звонок — иначе новичок
  // не видит вопросов и подсказок. Место окна при этом помнится.
  const placed = await bounds(panel);
  await page.reload();
  await page
    .getByRole("button", { name: "Принять вызов", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Свернуть разговор", exact: true }),
  ).toBeVisible();
  await expect(questions(page)).toBeVisible();
  await expect
    .poll(async () => (await bounds(panel)).x)
    .toBeCloseTo(placed.x, 0);
  await panel
    .getByRole("button", { name: "Свернуть разговор", exact: true })
    .click();
  await page.getByRole("button", { name: "сохранить", exact: true }).click();
  await page
    .getByRole("button", { name: "Пройти заново", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Принять вызов", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Свернуть разговор", exact: true }),
  ).toBeVisible();
  await inScreen(page);
});

test("свёрнутый разговор: проводник просит развернуть, подсказки по карточке остаются", async ({
  page,
}) => {
  const panel = await openCall(page, "fire_apartment_smoke", { guide: true });
  const tip = page.getByRole("status", { name: "Проводник" });
  await expect(tip).toContainText("Заявитель кричит и не слышит вопросов");
  await panel
    .getByRole("button", { name: "Свернуть разговор", exact: true })
    .click();
  // «Успокоить» — в разговоре, его не видно: проводник ведёт к кнопке «Развернуть».
  await expect(tip).toContainText("Проводник · Разговор свёрнут");
  await panel
    .getByRole("button", { name: "Развернуть разговор", exact: true })
    .click();
  await expect(tip).toContainText("Заявитель кричит и не слышит вопросов");
});

test("карточка заполняет колонку без запаса под разговор и прокручивается до последней отметки", async ({
  page,
}) => {
  await openCall(page, "dtp_victims_fuel");
  await page
    .getByLabel("Тип происшествия", { exact: true })
    .fill("задымление квартира");
  await page.getByRole("button", { name: /^задымление: квартира/ }).click();
  const column = page.locator('[data-help="operator-quick"]').locator("..");
  const card = page
    .getByRole("heading", { name: "Происшествие 101" })
    .locator("..")
    .locator("..");
  const columnBox = await bounds(column);
  const cardBox = await bounds(card);
  expect(cardBox.y + cardBox.height).toBeCloseTo(
    columnBox.y + columnBox.height,
    0,
  );
  expect(
    await column.evaluate((el) => getComputedStyle(el, "::after").content),
  ).toBe("none");
  const target = page
    .getByRole("group", { name: "Проведена ли газификация" })
    .getByRole("button", { name: "Да", exact: true });
  await page.mouse.move(cardBox.x + cardBox.width - 40, cardBox.y + 50);
  await page.mouse.wheel(0, 1400);
  await expect
    .poll(() => card.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await target.click();
  await expect(target).toHaveAttribute("aria-pressed", "true");
  await talk(page)
    .getByRole("button", { name: "Свернуть разговор", exact: true })
    .click();
  expect(await bounds(card)).toEqual(cardBox);
});

test("размер меняется за любой край и угол, противоположный край на месте, есть подсказка", async ({
  page,
}) => {
  const panel = await openCall(page, "dtp_victims_fuel", { moveAside: false });
  await expect(panel).toContainText(
    "Размер окна разговора — потяните за любой край или угол",
  );
  const drag = async (edge: string, dx: number, dy: number) => {
    const box = await bounds(panel.locator(`[data-edge="${edge}"]`));
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 6 });
    await page.mouse.up();
  };
  const before = await bounds(panel);
  // Левый край влево: окно шире, правый край на месте.
  await drag("w", -60, 0);
  const wider = await bounds(panel);
  expect(wider.x).toBeCloseTo(before.x - 60, 0);
  expect(wider.x + wider.width).toBeCloseTo(before.x + before.width, 0);
  expect(wider.height).toBeCloseTo(before.height, 0);
  // Верхний правый угол вверх и вправо: низ и левый край на месте.
  await drag("ne", 40, -30);
  const taller = await bounds(panel);
  expect(taller.x).toBeCloseTo(wider.x, 0);
  expect(taller.y).toBeCloseTo(wider.y - 30, 0);
  expect(taller.width).toBeCloseTo(wider.width + 40, 0);
  expect(taller.y + taller.height).toBeCloseTo(wider.y + wider.height, 0);
  // Нижний край вверх: окно ниже, верх на месте.
  await drag("s", 0, -20);
  const shorter = await bounds(panel);
  expect(shorter.y).toBeCloseTo(taller.y, 0);
  expect(shorter.height).toBeCloseTo(taller.height - 20, 0);
});

test("размер меняется за угол и стрелками, сохраняется и возвращается в центр", async ({
  page,
}) => {
  const panel = await openCall(page, "dtp_victims_fuel", { moveAside: false });
  const before = await bounds(panel);
  const handle = panel.getByRole("button", {
    name: "Изменить размер окна разговора",
  });
  const corner = await bounds(handle);
  const x = corner.x + corner.width / 2,
    y = corner.y + corner.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 80, { steps: 6 });
  await page.mouse.up();
  const resized = await bounds(panel);
  expect(resized.x).toBeCloseTo(before.x, 0);
  expect(resized.y).toBeCloseTo(before.y, 0);
  expect(resized.width).toBeCloseTo(before.width + 120, 0);
  expect(resized.height).toBeCloseTo(before.height + 80, 0);
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  const remembered = await bounds(panel);
  expect(remembered.width).toBeCloseTo(resized.width - 20, 0);
  expect(remembered.height).toBeCloseTo(resized.height - 20, 0);
  await page.reload();
  await page
    .getByRole("button", { name: "Принять вызов", exact: true })
    .click();
  expect(await bounds(panel)).toEqual(remembered);
  await panel
    .getByRole("button", { name: "Свернуть разговор", exact: true })
    .click();
  await expect(handle).toBeHidden();
  await panel
    .getByRole("button", { name: "Развернуть разговор", exact: true })
    .click();
  expect(await bounds(panel)).toEqual(remembered);
  await panel.getByRole("button", { name: "Вернуть окно в центр" }).click();
  const centered = await bounds(panel);
  expect(centered.x + centered.width / 2).toBeCloseTo(683, 0);
  expect(centered.y + centered.height / 2).toBeCloseTo(325, 0);
  await page.getByLabel("Улица:", { exact: true }).fill("Дубнинская улица");
  await handle.focus();
  for (let step = 0; step < 13; step++) await page.keyboard.press("ArrowLeft");
  for (let step = 0; step < 4; step++) await page.keyboard.press("ArrowUp");
  const smallest = await bounds(panel);
  expect(smallest.width).toBe(600);
  expect(smallest.height).toBe(320);
  const resizeBox = await bounds(handle);
  expect(resizeBox.y + resizeBox.height).toBeLessThanOrEqual(
    smallest.y + smallest.height,
  );
  const lastQuestion = questions(page).getByRole("button").last();
  await lastQuestion.scrollIntoViewIfNeeded();
  await expect(lastQuestion).toBeInViewport({ ratio: 1 });
  await page.setViewportSize({ width: 720, height: 480 });
  await inScreen(page);
});

test("меню и проводник доступны у обоих краёв, модальные окна выше разговора", async ({
  page,
}) => {
  await openCall(page, "fire_apartment_smoke", { guide: true });
  const panel = talk(page);
  await dragTalk(page, -500, -1000);
  await inScreen(page);
  const guide = page.getByRole("status", { name: "Проводник" });
  await expect
    .poll(async () => (await bounds(guide)).y)
    .toBeGreaterThan((await bounds(panel)).y + (await bounds(panel)).height);
  await panel.getByRole("button", { name: /^Успокоить/ }).click();
  let menu = panel.getByRole("list", { name: "Успокоить", exact: true });
  expect((await bounds(menu)).y).toBeGreaterThan(
    (await bounds(panel.getByRole("heading"))).y,
  );
  await panel.getByRole("button", { name: /^Успокоить/ }).click();
  await dragTalk(page, 0, 2000);
  await panel.getByRole("button", { name: /^Советы/ }).click();
  menu = panel.getByRole("list", { name: "Советы", exact: true });
  const menuBox = await bounds(menu);
  expect(menuBox.y).toBeGreaterThanOrEqual(8);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(642);
  await panel.getByRole("button", { name: /^Советы/ }).click();
  await moveTalkAside(page);
  await page
    .getByRole("button", { name: "Добавить службы", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Добавьте службы" })
    .getByRole("button", { name: "Сохранить и закрыть" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Добавьте службы" }),
  ).toHaveCount(0);
});

test("переполнение служб включает шевроны, прокрутку и фокус только с клавиатуры", async ({
  page,
}) => {
  await openCall(page, "dtp_victims_fuel");
  await page
    .getByRole("button", { name: "Добавить службы", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Добавьте службы" });
  for (const button of await dialog
    .getByRole("list")
    .getByRole("button")
    .all()) {
    if ((await button.getAttribute("aria-pressed")) !== "true")
      await button.click();
  }
  await dialog.getByRole("button", { name: "Сохранить и закрыть" }).click();
  const scroll = page.getByRole("button", {
    name: "Прокрутить службы",
    exact: true,
  });
  const strip = page.getByRole("list", { name: "Службы", exact: true });
  await expect(scroll).toBeVisible();
  await expect(scroll.locator("svg")).toHaveCount(1);
  await scroll.click();
  await expect
    .poll(() => strip.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  expect(await scroll.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
    "none",
  );
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(scroll).toBeFocused();
  expect(await scroll.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
    "solid",
  );
});

for (const id of [
  "fire_apartment_smoke",
  "dtp_victims_fuel",
  "heart_attack_home",
  "elevator_stuck",
]) {
  test(`обычный набор служб без прокрутки: ${id}`, async ({ page }) => {
    await openCall(page, id);
    const type =
      id === "fire_apartment_smoke"
        ? "задымление: квартира"
        : id === "dtp_victims_fuel"
          ? "ДТП с пострадавшими - разлитие горючих жидкостей"
          : id === "heart_attack_home"
            ? "Плохо с сердцем"
            : "Застревание в лифте (ребенок без взрослых)";
    await page.getByLabel("Тип происшествия", { exact: true }).fill(type);
    const candidates = page.getByRole("list", { name: "Найденные типы" });
    if (id === "fire_apartment_smoke")
      await page.getByRole("button", { name: /^задымление: квартира/ }).click();
    else
      await candidates
        .getByRole("button")
        .filter({ hasText: type })
        .first()
        .click();
    await expect(
      page.getByRole("button", { name: "Прокрутить службы" }),
    ).toHaveCount(0);
  });
}
