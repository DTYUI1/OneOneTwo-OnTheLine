import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { LEARNED_AFTER } from "../../apps/web/src/arm/phone/learned";
import { test, login } from "./captain-fixture";
import {
  backToContacts,
  callHead,
  closePhone,
  contact,
  expectEnded,
  expectTalking,
  lineTab,
  openDial,
  phoneButton,
  phoneWindow,
} from "./phone";

type Card = components["schemas"]["Card"];
type Scenario = components["schemas"]["Scenario"];
type Session = components["schemas"]["Session"];
type User = components["schemas"]["User"];

// GP-09 (рекомендации организаторов 16.10, п. 8): значок IP-телефона на панели ДДС открывает
// окно телефона (макет docs/dds_training_review/phone/index.html). Абонентов ДДС задаёт
// преподаватель — не больше 10 на одну ДДС; номер вне списка не отвечает, заявитель доступен,
// только если он в списке. Окно не меняет ни места, ни размера при смене состояния звонка.

test.skip(process.env.E2E_DATABASE !== "1", "Нужен стенд с БД");

const UNKNOWN = "Номер недоступен.";

/** Набрать номер вручную: поле «Номер» и кнопка «Позвонить». */
async function typed(win: Locator, number: string) {
  await (await openDial(win)).fill(number);
  await win.getByRole("button", { name: "Позвонить", exact: true }).click();
}

/** Место и размер окна телефона. */
async function frame(win: Locator) {
  const box = await win.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

/** Положить трубку и вернуться к контактам; рамка окна та же, что у контактов. */
async function hangUp(win: Locator, box: Awaited<ReturnType<typeof frame>>) {
  await win
    .getByRole("button", { name: "Положить трубку", exact: true })
    .click();
  await expectEnded(win);
  await expect(
    win.getByRole("button", { name: "Перезвонить", exact: true }),
  ).toBeVisible();
  expect(await frame(win)).toEqual(box);
  await backToContacts(win);
  expect(await frame(win)).toEqual(box);
}

async function csrf(page: Page) {
  return {
    "X-CSRF-Token": (await page.context().cookies()).find(
      (cookie) => cookie.name === "csrf",
    )!.value,
  };
}

test("Преподаватель задаёт абонентов (не больше 10, 11-й не сохраняется); обучаемый звонит из списка и вручную", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  await login(page, "teacher");
  const headers = await csrf(page);
  const users: User[] = await (await page.request.get("/api/users")).json();
  const trainee = users.find((user) => user.login === "trainee02")!;
  const settings = await (await page.request.get("/api/settings")).json();
  const title = `Телефон ДДС ${Date.now()}`;

  // 11 абонентов одной ДДС сервер не сохраняет: занятия нет.
  const eleven = Array.from({ length: 11 }, (_, index) => ({
    role: "caller",
    name: `Абонент ${index + 1}`,
    number: String(401 + index),
  }));
  const rejected = await page.request.post("/api/sessions", {
    headers,
    data: {
      title: `${title} лишний`,
      participants: [
        {
          user_id: trainee.id,
          workstation_number: 22,
          dds_service_id: "102",
          level: 4,
        },
      ],
      settings_snapshot: { ...settings, phone_contacts: { "102": eleven } },
    },
  });
  expect(rejected.status()).toBe(422);
  const listed: Session[] = await (
    await page.request.get("/api/sessions")
  ).json();
  expect(listed.some((item) => item.title === `${title} лишний`)).toBe(false);

  // Кабинет преподавателя: список абонентов ДДС рабочего места — 4 по умолчанию, добавить
  // можно до 10, дальше кнопка недоступна.
  await page
    .getByRole("button", { name: "+ Новое занятие", exact: true })
    .click();
  await page.getByLabel("Название", { exact: true }).fill(title);
  await page.getByRole("button", { name: "Добавить рабочее место" }).click();
  await page.getByLabel("Обучаемый", { exact: true }).fill(trainee.login);
  await page.getByLabel("Номер АРМ", { exact: true }).fill("22");
  await page.getByLabel("Служба ДДС", { exact: true }).selectOption("102");
  await page.getByText(/^Телефон ДДС · абоненты · по умолчанию/).click();
  const list = page.getByRole("region", { name: "Абоненты телефона ДДС 102" });
  await expect(list.getByText("Служба 102 · 4 из 10")).toBeVisible();
  const add = list.getByRole("button", { name: "Добавить абонента" });
  for (let count = 5; count <= 10; count++) {
    await add.click();
    await expect(list.getByText(`Служба 102 · ${count} из 10`)).toBeVisible();
  }
  await expect(add).toBeDisabled();
  await expect(list.getByLabel("Номер", { exact: true })).toHaveCount(10);
  // Остаются 4 по умолчанию и заявитель (405): его теперь можно набрать.
  const remove = list.getByRole("button", { name: "Убрать", exact: true });
  for (let count = 9; count >= 5; count--) {
    await remove.last().click();
    await expect(list.getByText(`Служба 102 · ${count} из 10`)).toBeVisible();
  }
  await expect(add).toBeEnabled();
  await expect(list.getByLabel("Кто", { exact: true }).last()).toHaveValue(
    "caller",
  );
  await expect(list.getByLabel("Номер", { exact: true }).last()).toHaveValue(
    "405",
  );
  const creation = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/sessions") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Создать занятие", exact: true })
    .click();
  const created = await creation;
  expect(created.status(), await created.text()).toBe(201);
  const lesson: Session = await created.json();
  const saved = (
    lesson.settings_snapshot as unknown as {
      phone_contacts: Record<string, { role: string; number: string }[]>;
    }
  ).phone_contacts["102"];
  expect(saved.map((item) => item.number)).toEqual([
    "401",
    "402",
    "403",
    "404",
    "405",
  ]);
  expect(saved.at(-1)!.role).toBe("caller");

  const traineeContext = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    ignoreHTTPSErrors: true,
  });
  try {
    const sources: Scenario[] = await (
      await page.request.get("/api/scenarios")
    ).json();
    const source = sources.find(
      (item) => item.id === "00000000-0000-4000-8000-000000000100",
    )!;
    const scenario = {
      ...source,
      id: randomUUID(),
      card: { ...source.card, number: `6${Date.now().toString().slice(-7)}` },
    };
    expect(
      (
        await page.request.post("/api/scenarios", { headers, data: scenario })
      ).status(),
    ).toBe(201);
    const assigned = await page.request.post(
      `/api/sessions/${lesson.id}/assignments`,
      {
        headers,
        data: {
          participant_id: trainee.id,
          scenario_id: scenario.id,
          order: 1,
          planned_at: new Date().toISOString(),
        },
      },
    );
    expect(assigned.status(), await assigned.text()).toBe(201);
    expect(
      (
        await page.request.post(`/api/sessions/${lesson.id}/start`, { headers })
      ).ok(),
    ).toBeTruthy();

    const arm = await traineeContext.newPage();
    arm.setDefaultTimeout(15_000);
    await arm.addLocatorHandler(
      arm.getByRole("dialog", { name: "Параллельная работа" }),
      async (dialog) => {
        await dialog.getByRole("button", { name: "Понятно" }).click();
      },
    );
    await login(arm, trainee.login);
    let card: Card | undefined;
    await expect
      .poll(async () => {
        const cards: Card[] = await (
          await arm.request.get("/api/cards")
        ).json();
        card = cards.find((item) => item.session_id === lesson.id);
        return card?.id ?? "";
      })
      .not.toBe("");
    await arm.locator(`[data-card-id="${card!.id}"]`).click();
    await expect(
      arm.getByRole("region", {
        name: `Происшествие ${scenario.card.number}`,
        exact: true,
      }),
    ).toBeVisible();

    // Значок с трубкой на панели карточки открывает окно телефона.
    const win = phoneWindow(arm);
    await expect(win).toBeHidden();
    await phoneButton(arm).click();
    await expect(win).toBeVisible();
    const box = await frame(win);
    expect(box.width).toBeGreaterThanOrEqual(600);
    expect(box.height).toBeGreaterThanOrEqual(320);

    // Контакты группами, как в макете: силы службы, руководство и аварийная бригада,
    // службы (своей нет — её набирают номером), заявитель от преподавателя.
    const contacts = win.getByRole("list", { name: "Контакты" });
    for (const group of [
      "Силы службы",
      "Руководство и аварийная бригада",
      "Службы",
      "По карточке — добавил преподаватель",
    ])
      await expect(contacts.getByText(group, { exact: true })).toBeVisible();
    for (const name of [
      "Руководитель организации",
      "Начальник отдела реагирования",
      "Начальник аварийной бригады",
      "Специалист аварийной бригады",
      "Заявитель",
      "Скорая помощь",
    ])
      await expect(contact(win, name)).toBeEnabled();
    await expect(contact(win, "Служба 102")).toHaveCount(0);
    await expect(win.getByText("Выберите, кому позвонить.")).toBeVisible();

    // Звонок из списка: гудки, разговор и итог — в том же окне того же размера.
    await contact(win, "Руководитель организации").click();
    await expect(callHead(win)).toHaveAttribute(
      "data-call-state",
      /^(dialing|ringing)$/,
    );
    await expect(callHead(win)).toContainText("Руководитель организации");
    expect(await frame(win)).toEqual(box);
    await expectTalking(win);
    await expect(callHead(win)).toContainText(
      "Разговор: Руководитель организации",
    );
    // Ответ — фраза банка, выбранная по звонку: проверяется сама реплика абонента.
    await expect(
      win.getByText("Руководитель организации:", { exact: true }).first(),
    ).toBeVisible();
    expect(await frame(win)).toEqual(box);
    await hangUp(win, box);

    // Набор вручную: номер из списка преподавателя отвечает.
    await typed(win, "402");
    await expectTalking(win);
    await expect(callHead(win)).toContainText("Начальник отдела реагирования");
    await hangUp(win, box);

    // Номер вне списка не отвечает: звонка нет, в окне — «Номер недоступен.».
    await typed(win, "499");
    await expect(win.getByText(UNKNOWN, { exact: true })).toBeVisible();
    await expect(callHead(win)).toHaveCount(0);

    // Набор кнопками (HQ-023): набор с клавиатурой — левая треть окна, контакты — правее.
    const pad = win.getByRole("form", { name: "Набор номера", exact: true });
    const padBox = await frame(pad);
    const listBox = await frame(contacts);
    expect(padBox.x).toBeLessThan(box.x + 2);
    expect(padBox.x + padBox.width).toBeLessThanOrEqual(listBox.x + 1);
    expect(padBox.width / box.width).toBeGreaterThan(0.3);
    expect(padBox.width / box.width).toBeLessThan(0.37);
    // Кнопки дописывают в то же поле «Номер»: мышью, Enter и пробелом; «стереть» — кнопка
    // в сетке клавиатуры (нижний ряд: пусто, «0», «стереть»), «*» и «#» нет (решение 18.10).
    const field = win.getByRole("textbox", { name: "Номер" });
    const keys = win.getByRole("group", { name: "Клавиатура", exact: true });
    const key = (name: string) =>
      keys.getByRole("button", { name, exact: true });
    // Новый набор гасит прежний отказ: «Номер недоступен.» уже не о набираемом номере.
    await expect(win.getByText(UNKNOWN, { exact: true })).toBeVisible();
    await key("1").click();
    await expect(win.getByText(UNKNOWN, { exact: true })).toHaveCount(0);
    await expect(keys.getByRole("button")).toHaveCount(11);
    await expect(keys.getByRole("button", { name: "*" })).toHaveCount(0);
    await expect(keys.getByRole("button", { name: "#" })).toHaveCount(0);
    const erase = keys.getByRole("button", {
      name: "Стереть последнюю цифру",
      exact: true,
    });
    await expect(
      win.getByRole("button", { name: "Стереть последнюю цифру", exact: true }),
    ).toHaveCount(1);
    const zeroBox = await frame(key("0"));
    const eraseBox = await frame(erase);
    expect(Math.abs(eraseBox.y - zeroBox.y)).toBeLessThan(2);
    expect(eraseBox.x).toBeGreaterThan(zeroBox.x);
    await field.fill("");
    await key("1").click();
    await key("0").focus();
    await arm.keyboard.press("Enter");
    await key("3").focus();
    await arm.keyboard.press("Space");
    await key("9").click();
    await expect(field).toHaveValue("1039");
    await erase.click();
    await expect(field).toHaveValue("103");
    await win.getByRole("button", { name: "Позвонить", exact: true }).click();
    await expectTalking(win);
    await expect(callHead(win)).toContainText("Скорая помощь");
    await hangUp(win, box);

    // Заявитель в списке: номер из карточки набирается и попадает к нему.
    await typed(win, card!.source.phone_aon);
    await expectTalking(win);
    await expect(callHead(win)).toContainText("Заявитель");
    await hangUp(win, box);
    await closePhone(arm);
  } finally {
    await page.request.post(`/api/sessions/${lesson.id}/finish`, { headers });
    await traineeContext.close();
  }
});

test("Список по умолчанию: заявителя нет — его номер недоступен; без карточки телефона нет", async ({
  page,
  lesson,
}) => {
  await login(page, "trainee05");
  // Без открытой карточки ни значка, ни окна телефона: звонят только из карточки
  // (docs/decisions.md, «Телефон — только в открытой карточке», стенд 18.10).
  const win = phoneWindow(page);
  const row = page.locator(`[data-card-id="${lesson.card.id}"]`);
  await expect(row).toBeVisible();
  await expect(phoneButton(page)).toHaveCount(0);
  await expect(win).toBeHidden();

  await row.click();
  await phoneButton(page).click();
  await expect(win).toBeVisible();
  await expect(contact(win, "Руководитель организации")).toBeEnabled();
  await expect(contact(win, "Заявитель")).toHaveCount(0);
  await expect(
    win.getByText("По карточке — добавил преподаватель", { exact: true }),
  ).toHaveCount(0);

  // Номер заявителя из карточки и чужой условный номер — недоступны, звонка нет.
  for (const number of [lesson.card.source.phone_aon, "405"]) {
    await typed(win, number);
    await expect(win.getByText(UNKNOWN, { exact: true })).toBeVisible();
    await expect(callHead(win)).toHaveCount(0);
  }
  // Абонент из списка по умолчанию отвечает.
  const box = await frame(win);
  await typed(win, "401");
  await expectTalking(win);
  await expect(callHead(win)).toContainText("Руководитель организации");
  // Вкладки линий (проверка 17.10): разговор с абонентом удерживается, второй звонок — своей
  // вкладкой; щелчок по удержанной снимает её, а идущий встаёт на удержание. Рамка та же.
  const boss = "Руководитель организации";
  await expect(lineTab(win, "active", boss)).toContainText("говорит");
  await win.getByRole("button", { name: "Удержать", exact: true }).click();
  await expect(lineTab(win, "held", boss)).toContainText("на удержании 0:0");
  expect(await frame(win)).toEqual(box);
  await backToContacts(win);
  await typed(win, "402");
  await expectTalking(win);
  await expect(lineTab(win, "active", boss)).toHaveCount(0);
  await expect(lineTab(win, "active")).toHaveCount(1);
  await lineTab(win, "held", boss).click();
  await expectTalking(win);
  await expect(callHead(win)).toContainText(boss);
  await expect(
    win.getByText(`Снят с удержания: ${boss}`, { exact: true }),
  ).toBeVisible();
  await expect(lineTab(win, "held")).toHaveCount(1);
  await expect(lineTab(win, "active", boss)).toBeVisible();
  expect(await frame(win)).toEqual(box);
  await hangUp(win, box);
});

// GP-24: пояснения, которые легко запомнить, видны, пока обучаемый не сделал действие верно
// LEARNED_AFTER раз (apps/web/src/arm/phone/learned.ts), потом прячутся — у этой учётной
// записи и после перезагрузки. Окно при этом не меняет ни места, ни размера: растёт лента.
test("Пояснения окна прячутся после нескольких верных действий; окно того же размера", async ({
  page,
  lesson,
}) => {
  test.setTimeout(120_000);
  await login(page, "trainee05");
  const win = phoneWindow(page);
  await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
  await phoneButton(page).click();
  await expect(win).toBeVisible();
  const box = await frame(win);
  const pick = win.getByText("Выберите, кому позвонить.", { exact: true });
  const resize = win.getByText(
    "Размер окна — потяните за любой край или угол",
    { exact: true },
  );
  await expect(resize).toBeVisible();

  // Звонок из контактов — верное действие для «Выберите, кому позвонить.».
  for (let done = 0; done < LEARNED_AFTER; done++) {
    await expect(pick).toBeVisible();
    await contact(win, "Руководитель организации").click();
    await expectTalking(win);
    await hangUp(win, box);
  }
  await expect(pick).toHaveCount(0);
  expect(await frame(win)).toEqual(box);
  // Поле «Номер» и «Позвонить» на месте: прячется только пояснение.
  await expect(win.getByRole("textbox", { name: "Номер" })).toBeVisible();

  // Размер окна стрелками на кнопке размера: после N-го раза полосы с пояснением нет,
  // кнопка размера остаётся в углу, подсказка — при наведении. Окно прижато к правому
  // нижнему углу (HQ-021): места вниз нет, поэтому сужаем.
  const grip = win.getByRole("button", {
    name: "Изменить размер окна телефона",
  });
  for (let done = 0; done < LEARNED_AFTER; done++) {
    await expect(resize).toBeVisible();
    await grip.press("ArrowLeft");
  }
  await expect(resize).toHaveCount(0);
  await expect(grip).toBeVisible();
  await expect(grip).toHaveAttribute("title", /потяните за любой край/);
  const grown = await frame(win);
  expect(grown.width).toBe(box.width - 20 * LEARNED_AFTER);
  expect(grown.height).toBe(box.height);

  // Счёт хранится у учётной записи: после перезагрузки (карточка остаётся открытой — она в
  // адресе) пояснений нет, окно того же размера.
  await page.reload();
  await phoneButton(page).first().click();
  await expect(win.getByRole("list", { name: "Контакты" })).toBeVisible();
  await expect(
    win.getByText("Позвонить можно из открытой карточки.", { exact: true }),
  ).toHaveCount(0);
  await expect(pick).toHaveCount(0);
  await expect(resize).toHaveCount(0);
  // Размер помнится, место — снова в углу, правый и нижний края как до сужения.
  const reopened = await frame(win);
  expect(reopened.width).toBe(grown.width);
  expect(reopened.height).toBe(grown.height);
  expect(reopened.x + reopened.width).toBe(box.x + box.width);
  expect(reopened.y + reopened.height).toBe(box.y + box.height);
});

// Свой список преподавателя (фикстура `phoneContacts`) на обоих экранах отчёта: он заменяет
// список по умолчанию; значок — в полосе «Службы:» карточки; сервер записывает только звонки
// абонентам из списка; «−», «Закрыть» и значок не меняют ни места, ни размера окна.
for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
]) {
  test.describe(`Свой список преподавателя, ${viewport.width}×${viewport.height}`, () => {
    test.use({
      viewport,
      phoneContacts: {
        "102": [
          { role: "head", name: "Руководитель организации", number: "450" },
          { role: "caller", name: "Заявитель", number: "460" },
        ],
      },
    });

    test("Список преподавателя заменяет список по умолчанию; сервер записывает звонки только по списку; окно 760 × 340 в любом состоянии", async ({
      page,
      lesson,
    }) => {
      test.setTimeout(120_000);
      await login(page, "trainee05");
      await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
      const card = page.getByRole("region", {
        name: `Происшествие ${lesson.card.source.number}`,
        exact: true,
      });
      // Значок — в полосе «Службы:» карточки, окно закрыто до нажатия.
      const win = phoneWindow(page);
      await expect(win).toBeHidden();
      await phoneButton(card).click();
      await expect(win).toBeVisible();
      const box = await frame(win);
      expect({
        width: Math.round(box.width),
        height: Math.round(box.height),
      }).toEqual({ width: 760, height: 340 });

      // Только абоненты преподавателя: руководства по умолчанию в списке нет.
      await expect(contact(win, "Руководитель организации")).toBeEnabled();
      await expect(contact(win, "Заявитель")).toBeEnabled();
      for (const name of [
        "Начальник отдела реагирования",
        "Начальник аварийной бригады",
        "Специалист аварийной бригады",
      ])
        await expect(contact(win, name)).toHaveCount(0);

      // Номер по умолчанию (401) и чужой номер не отвечают — звонка нет.
      for (const number of ["401", "+7 999 000-00-00"]) {
        await typed(win, number);
        await expect(win.getByText(UNKNOWN, { exact: true })).toBeVisible();
        await expect(callHead(win)).toHaveCount(0);
      }

      // Звонок руководителю из списка: голос собеседника в шапке, рамка та же.
      await contact(win, "Руководитель организации").click();
      await expectTalking(win);
      await expect(callHead(win)).toContainText(
        "Разговор: Руководитель организации",
      );
      await expect(win.getByText(/^(слушает|говорит)$/)).toBeVisible();
      expect(await frame(win)).toEqual(box);
      await hangUp(win, box);

      // Номер заявителя из карточки попадает на его условный номер из списка.
      await typed(win, lesson.card.source.phone_aon);
      await expectTalking(win);
      await expect(callHead(win)).toContainText("Заявитель");
      await hangUp(win, box);

      // Сервер записал наборы на условные номера абонентов; недоступные номера не записаны.
      await expect
        .poll(async () => {
          const events = (await (
            await page.request.get(`/api/cards/${lesson.card.id}/events`)
          ).json()) as { type: string; payload: { phone_ext?: string } }[];
          return events
            .filter((event) => event.type === "call_dial")
            .map((event) => event.payload.phone_ext);
        })
        .toEqual(["450", "460"]);

      // «−» сворачивает до шапки той же ширины; «Закрыть» прячет окно, значок открывает его
      // на прежнем месте того же размера.
      await win.getByRole("button", { name: "Свернуть телефон" }).click();
      await expect(win.getByRole("list", { name: "Контакты" })).toBeHidden();
      expect((await frame(win)).width).toBe(box.width);
      await win.getByRole("button", { name: "Развернуть телефон" }).click();
      await expect(win.getByRole("list", { name: "Контакты" })).toBeVisible();
      expect(await frame(win)).toEqual(box);
      await closePhone(page);
      await phoneButton(card).click();
      await expect(win).toBeVisible();
      expect(await frame(win)).toEqual(box);
    });
  });
}
