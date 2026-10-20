import { expect, type Locator, type Page } from "@playwright/test";
import { test, login } from "./captain-fixture";
import {
  answer,
  backToContacts,
  expectTalking,
  openPhone,
  peerDone,
} from "./phone";

// TC-04 (docs/competitors/touches.md, п. 12, 16, «Клавиши и ввод»): в окне телефона пробел —
// начало и конец ответа (вне полей ввода, по коду клавиши), статус микрофона словами, а
// фраза, распознанная неуверенно, сначала показывается в поле «Проверьте адрес и нажмите
// Enter»; переспрос не штрафуется. Микрофон — поддельное устройство Chromium. Распознавание
// на стенде выключено, поэтому ответ сервера на звук подменяется (page.route), а поправленный
// текст идёт на настоящий сервер: он принимает текст и без распознавания.
test.skip(process.env.E2E_DATABASE !== "1", "Нужен стенд с базой данных");

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
  permissions: ["microphone"],
});

const CHECK = "Проверьте адрес и нажмите Enter";

interface Heard {
  text: string;
  confidence: number | null;
  choice: string | null;
  parts: string[];
  loudness: string | null;
  spell_street: string | null;
}

/** Ответ на звук: подменяется; ответ на текст — настоящий сервер. */
async function stubRecognition(
  page: Page,
  answerFor: () => Heard,
  delayMs = 0,
): Promise<{ audio: () => number; texts: string[] }> {
  let audio = 0;
  const texts: string[] = [];
  await page.route("**/api/calls/*/voice-report", async (route) => {
    const body = route.request().postData() ?? "";
    const typed = /name="text"\r\n\r\n([\s\S]*?)\r\n--/.exec(body);
    if (typed) {
      texts.push(typed[1]);
      await route.continue();
      return;
    }
    audio += 1;
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({ json: answerFor() });
  });
  return { audio: () => audio, texts };
}

const UNSURE: Heard = {
  text: "Дубнинская 12",
  confidence: 0.3,
  choice: null,
  parts: [],
  loudness: null,
  spell_street: null,
};

async function callService(page: Page) {
  const win = await openPhone(page);
  await win.getByRole("textbox", { name: "Номер" }).fill("102");
  await win.getByRole("button", { name: "Позвонить", exact: true }).click();
  await expectTalking(win);
  // Дежурный договорил (полудуплекс): нажатие начинает запись сразу.
  await expect(
    answer(win).getByRole("button", { name: "Говорить", exact: true }),
  ).toBeEnabled({ timeout: 20_000 });
  await peerDone(win);
  return win;
}

/** Тишина в WAV (8 кГц, 16 бит, моно) длиной `seconds`. */
function silentWav(seconds: number): Buffer {
  const rate = 8000;
  const data = rate * 2 * seconds;
  const wav = Buffer.alloc(44 + data);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + data, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(data, 40);
  return wav;
}

/** Фокус не в поле и не на кнопке: пробел достаётся окну телефона. */
async function focusAway(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
}

test("Пробел вне полей: зажат — запись, отпущен — ответ закончен; в поле — печатает; статус словами", async ({
  page,
  lesson,
}) => {
  test.setTimeout(120_000);
  // Ответ на звук задержан: «распознаю…» успевает показаться.
  const stub = await stubRecognition(
    page,
    () => ({ ...UNSURE, text: "", choice: null }),
    1500,
  );
  await login(page, "trainee05");
  await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
  const card = page.getByRole("region", {
    name: `Происшествие ${lesson.card.source.number}`,
    exact: true,
  });
  // Поле комментария открыто ещё до звонка: пробел в нём — печать.
  await card
    .getByRole("button", { name: "Изменить статус", exact: true })
    .click();
  const comment = card.getByLabel("Комментарий", { exact: true });
  await expect(comment).toBeVisible();
  const win = await callService(page);
  const finish = win.getByRole("button", {
    name: "Закончить ответ",
    exact: true,
  });

  // В поле ввода пробел печатает и запись не начинает.
  await comment.focus();
  await page.keyboard.press("Space");
  await expect(comment).toHaveValue(" ");
  await expect(finish).toHaveCount(0);

  // Вне полей: пробел зажат — запись, статус «слушаю».
  await focusAway(page);
  await page.keyboard.down("Space");
  await expect(finish).toBeVisible();
  await expect(
    win.getByRole("status").filter({ hasText: /^слушаю/ }),
  ).toBeVisible();

  // Отпущенный пробел заканчивает ответ: «распознаю…», потом снова можно говорить.
  // Клавиша — по коду: символ «Пробел» русской раскладки роли не играет.
  await page.evaluate(() =>
    window.dispatchEvent(
      new KeyboardEvent("keyup", {
        code: "Space",
        key: "Unidentified",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await expect(win.getByText("распознаю…")).toBeVisible();
  await expect(finish).toHaveCount(0);
  await expect(
    answer(win).getByRole("button", { name: "Говорить", exact: true }),
  ).toBeEnabled({ timeout: 10_000 });
  expect(stub.audio()).toBe(1);

  // Фокус на кнопке карточки (после щелчка он там и остаётся): во время разговора пробел
  // говорит, а кнопку не нажимает (проверка 17.10).
  const history = card.getByRole("button", {
    name: "История статусов",
    exact: true,
  });
  const expanded = await history.getAttribute("aria-expanded");
  // Playwright помнит пробел зажатым (отпускали событием выше): иначе нажатие — автоповтор.
  await page.keyboard.up("Space");
  await history.focus();
  await page.keyboard.down("Space");
  await expect(finish).toBeVisible();
  await expect(
    win.getByRole("status").filter({ hasText: /^слушаю/ }),
  ).toBeVisible();
  await page.keyboard.up("Space");
  await expect(finish).toHaveCount(0);
  await expect.poll(() => stub.audio(), { timeout: 10_000 }).toBe(2);
  await expect(history).toHaveAttribute("aria-expanded", expanded ?? "");
});

test("Низкая уверенность: фраза в поле правки, Enter отправляет, переспрос не штрафуется", async ({
  page,
  lesson,
}) => {
  test.setTimeout(120_000);
  const stub = await stubRecognition(page, () => UNSURE);
  await login(page, "trainee05");
  await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
  const win = await callService(page);

  // Пробел зажат — ответ идёт, отпущен — закончен.
  await focusAway(page);
  await page.keyboard.down("Space");
  await expect(
    win.getByRole("button", { name: "Закончить ответ", exact: true }),
  ).toBeVisible();
  await page.keyboard.up("Space");

  // Распознано неуверенно: не «не расслышал», а поле с подсказкой.
  const field = win.getByRole("textbox", { name: CHECK });
  await expect(field).toHaveValue("Дубнинская 12");
  await expect(win.getByText(CHECK, { exact: true })).toBeVisible();
  await expect(
    answer(win).getByRole("button", { name: "Говорить", exact: true }),
  ).toHaveCount(0);
  await expect(win.getByText(/Не расслышал|Повторите доклад/)).toHaveCount(0);

  // «Сказать заново» убирает поле и сразу включает запись; Escape в поле — то же без записи.
  await win
    .getByRole("button", { name: "Сказать заново", exact: true })
    .click();
  await expect(
    win.getByRole("button", { name: "Закончить ответ", exact: true }),
  ).toBeVisible();
  // Запись начата кнопкой — пробел её заканчивает.
  await page.keyboard.press("Space");
  await expect(field).toBeVisible();
  await field.press("Escape");
  await expect(field).toHaveCount(0);
  expect(stub.audio()).toBe(2);

  // В третий раз: правим текст — пробел в поле печатает — и отправляем клавишей Enter.
  await win.getByRole("button", { name: "Говорить", exact: true }).click();
  await win
    .getByRole("button", { name: "Закончить ответ", exact: true })
    .click();
  await expect(field).toBeVisible();
  const source = lesson.card.source;
  const phrase =
    `Диспетчер ДДС Иванов. ${source.address.street}, дом ${source.address.house}, ` +
    `${source.incident_class}. Работаем по карточке ${source.number}. ` +
    "Ситуация изменилась, бригада направлена";
  await field.fill(phrase.slice(0, 9));
  await field.press("End");
  await field.pressSequentially(phrase.slice(9));
  await expect(field).toHaveValue(phrase);
  await field.press("Enter");

  // Текст ушёл на сервер вместо звука и засчитан как сказанный голосом.
  await expect(field).toHaveCount(0);
  await expect(
    win.locator("[data-line-text]").filter({ hasText: phrase }),
  ).toBeVisible();
  expect(stub.texts).toEqual([phrase]);
  expect(stub.audio()).toBe(3);

  // В отбое: доклад голосом, и ни одной «не распознанной» фразы.
  await win
    .getByRole("button", { name: "Положить трубку", exact: true })
    .click();
  await expect
    .poll(async () => {
      const events = (await (
        await page.request.get(`/api/cards/${lesson.card.id}/events`)
      ).json()) as {
        type: string;
        payload: { report_modes?: string[]; voice_failures?: number };
      }[];
      const hangup = events.find((event) => event.type === "call_hangup");
      return hangup
        ? [hangup.payload.report_modes, hangup.payload.voice_failures]
        : null;
    })
    .toEqual([["voice"], 0]);
});

test("Пробел, зажатый во время реплики, начинает запись по её концу; отпущенный раньше — ничего (HQ-052)", async ({
  page,
  lesson,
}) => {
  test.setTimeout(120_000);
  const stub = await stubRecognition(page, () => ({
    ...UNSURE,
    text: "",
    choice: null,
  }));
  // Реплики банка — 4 с тишины: реплика заведомо дольше раннего окна (секунда до конца).
  await page.route("**/*.ogg", (route) =>
    route.fulfill({ contentType: "audio/wav", body: silentWav(4) }),
  );
  await login(page, "trainee05");
  await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
  const finish = (win: Locator) =>
    win.getByRole("button", { name: "Закончить ответ", exact: true });
  const waiting = (win: Locator) =>
    win
      .getByRole("status")
      .filter({ hasText: "запись начнётся после реплики" });
  const voice = (win: Locator) => win.locator("[data-speaking]");

  /** Звонок дежурному 102: он представляется — реплика звучит. */
  async function dial(): Promise<Locator> {
    const win = await openPhone(page);
    await win.getByRole("textbox", { name: "Номер" }).fill("102");
    await win.getByRole("button", { name: "Позвонить", exact: true }).click();
    await expectTalking(win);
    await expect(voice(win)).toHaveAttribute("data-speaking", "true", {
      timeout: 20_000,
    });
    await focusAway(page);
    return win;
  }

  // Нажал и отпустил, пока дежурный говорит: нажатие принято, но запись не начинается.
  let win = await dial();
  await page.keyboard.down("Space");
  await expect(waiting(win)).toBeVisible();
  await page.keyboard.up("Space");
  await expect(waiting(win)).toHaveCount(0);
  await peerDone(win);
  await page.waitForTimeout(500);
  await expect(finish(win)).toHaveCount(0);
  expect(stub.audio()).toBe(0);
  await win
    .getByRole("button", { name: "Положить трубку", exact: true })
    .click();
  await backToContacts(win);

  // Зажал заранее и держит: запись начинается сама к концу реплики (за секунду до него).
  win = await dial();
  await page.keyboard.down("Space");
  await expect(waiting(win)).toBeVisible();
  // Запись уже идёт, а дежурный ещё договаривает: остаток реплики доигрывает, запись не гаснет.
  // Остатку — секунда, а ожидание Playwright к этому времени опрашивает раз в секунду: голос
  // в миг появления «Закончить ответ» снимаем в браузере, по кадрам.
  const phone = await win.elementHandle();
  const overlap = await page.waitForFunction(
    (root) => {
      const recording = [...(root?.querySelectorAll("button") ?? [])].some(
        (button) => button.textContent?.trim() === "Закончить ответ",
      );
      return recording
        ? (root
            ?.querySelector("[data-speaking]")
            ?.getAttribute("data-speaking") ?? "none")
        : null;
    },
    phone,
    { timeout: 20_000, polling: "raf" },
  );
  expect(await overlap.jsonValue()).toBe("true");
  await expect(finish(win)).toBeVisible();
  await expect(
    win.getByRole("status").filter({ hasText: /^слушаю/ }),
  ).toBeVisible();
  await peerDone(win);
  await expect(finish(win)).toBeVisible();
  await page.keyboard.up("Space");
  await expect(finish(win)).toHaveCount(0);
  await expect.poll(() => stub.audio(), { timeout: 10_000 }).toBe(1);
});

test("«Говорить» во время реплики взводит запись по её концу; повторный щелчок — отмена (HQ-052)", async ({
  page,
  lesson,
}) => {
  test.setTimeout(120_000);
  const stub = await stubRecognition(page, () => ({
    ...UNSURE,
    text: "",
    choice: null,
  }));
  // Реплики банка — 4 с тишины: реплика заведомо дольше раннего окна (секунда до конца).
  await page.route("**/*.ogg", (route) =>
    route.fulfill({ contentType: "audio/wav", body: silentWav(4) }),
  );
  await login(page, "trainee05");
  await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
  const finish = (win: Locator) =>
    win.getByRole("button", { name: "Закончить ответ", exact: true });
  const waiting = (win: Locator) =>
    win
      .getByRole("status")
      .filter({ hasText: "запись начнётся после реплики" });
  const voice = (win: Locator) => win.locator("[data-speaking]");
  const talk = (win: Locator) =>
    answer(win).getByRole("button", { name: "Говорить", exact: true });

  async function dial(): Promise<Locator> {
    const win = await openPhone(page);
    await win.getByRole("textbox", { name: "Номер" }).fill("102");
    await win.getByRole("button", { name: "Позвонить", exact: true }).click();
    await expectTalking(win);
    await expect(voice(win)).toHaveAttribute("data-speaking", "true", {
      timeout: 20_000,
    });
    return win;
  }

  // Щелчок во время реплики взводит (кнопка — нажатый переключатель), повторный — отмена.
  let win = await dial();
  await expect(talk(win)).toHaveAttribute("aria-pressed", "false");
  await talk(win).click();
  await expect(talk(win)).toHaveAttribute("aria-pressed", "true");
  await expect(waiting(win)).toBeVisible();
  await talk(win).click();
  await expect(talk(win)).toHaveAttribute("aria-pressed", "false");
  await expect(waiting(win)).toHaveCount(0);
  await peerDone(win);
  await page.waitForTimeout(500);
  await expect(finish(win)).toHaveCount(0);
  expect(stub.audio()).toBe(0);
  await win
    .getByRole("button", { name: "Положить трубку", exact: true })
    .click();
  await backToContacts(win);

  // Щелчок во время реплики и всё: запись начинается сама к её концу, кончается щелчком.
  win = await dial();
  await talk(win).click();
  await expect(waiting(win)).toBeVisible();
  await expect(finish(win)).toBeVisible({ timeout: 20_000 });
  await expect(
    win.getByRole("status").filter({ hasText: /^слушаю/ }),
  ).toBeVisible();
  await peerDone(win);
  await finish(win).click();
  await expect(finish(win)).toHaveCount(0);
  await expect.poll(() => stub.audio(), { timeout: 10_000 }).toBe(1);
});
