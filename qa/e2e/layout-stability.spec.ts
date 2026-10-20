import { expect, test, type Page } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import {
  answer,
  freeBrigade,
  currentStep,
  openPhone,
  phoneWindow,
} from "./phone";
import { introSeenForAnyUser } from "./trainer";

type Card = components["schemas"]["Card"];
type Session = components["schemas"]["Session"];
type CardTraining = components["schemas"]["CardTraining"];

// Сдвиги вёрстки на пути обучаемого: после каждого действия блоки, которые
// не участвовали в действии, должны остаться на месте. Замер — по рамкам
// областей data-help и по layout-shift браузера (без недавнего ввода).

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Boxes = Record<string, Box>;
interface Shift {
  step: string;
  moved: { name: string; dx: number; dy: number; dw: number; dh: number }[];
  cls: number;
}

const TOLERANCE_PX = 2;

async function boxes(page: Page): Promise<Boxes> {
  return page.evaluate(() => {
    const out: Record<string, Box> = {};
    const add = (name: string, element: Element | null) => {
      if (!element) return;
      const rect = element.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      out[name] = {
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      };
    };
    document
      .querySelectorAll("[data-help]")
      .forEach((element) =>
        add(`help:${element.getAttribute("data-help")}`, element),
      );
    document
      .querySelectorAll("button")
      .forEach((element) =>
        add(
          `button:${(element.textContent ?? "").trim().slice(0, 40)}`,
          element,
        ),
      );
    // Ссылки шапки («Мои результаты», «Оператор 112») стоят в одном ряду с кнопками.
    document
      .querySelectorAll("header a")
      .forEach((element) =>
        add(`link:${(element.textContent ?? "").trim().slice(0, 40)}`, element),
      );
    return out;
  });
}

async function installShiftObserver(page: Page) {
  await page.addInitScript(() => {
    const store = window as unknown as { __shift: number };
    store.__shift = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
      })[])
        if (!entry.hadRecentInput) store.__shift += entry.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
}

const shiftSoFar = (page: Page) =>
  page.evaluate(() => (window as unknown as { __shift: number }).__shift ?? 0);

async function login(page: Page, name: string) {
  // Окно «Как устроено обучение» (DT-18) — перед первой тренировкой; здесь о другом.
  await page.addInitScript(introSeenForAnyUser);
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(name);
  await page
    .getByLabel("Пароль")
    .fill(process.env.DEMO_PASSWORD ?? "demo-local");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
])
  test(`сдвиги вёрстки на пути тренировки, ${viewport.width}×${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.skip(process.env.E2E_DATABASE !== "1", "Нужен стенд с БД");
    test.skip(testInfo.project.name !== "chromium", "layout-shift — Chromium");
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize(viewport);
    // Прежняя тренировка ещё идёт — подтверждаем окном «Начать заново».
    // Каждый запуск тренировки подтверждается (PracticeButton, 20.10).
    await page.addLocatorHandler(
      page.getByRole("dialog", { name: "Запустить тренировку?" }),
      async (dialog) => {
        await dialog.getByRole("button", { name: "Запустить" }).click();
      },
    );
    await page.addLocatorHandler(
      page.getByRole("dialog", { name: "Начать тренировку заново?" }),
      async (dialog) => {
        await dialog.getByRole("button", { name: "Начать заново" }).click();
      },
    );
    await page.addLocatorHandler(
      page.getByRole("dialog", { name: "Параллельная работа" }),
      async (dialog) => {
        await dialog.getByRole("button", { name: "Понятно" }).click();
      },
    );
    await installShiftObserver(page);
    const shifts: Shift[] = [];
    let before = await boxes(page);
    let clsBefore = 0;
    // Действие и то, что им законно меняется (регулярки по именам блоков).
    async function step(name: string, action: () => Promise<void>) {
      before = await boxes(page);
      clsBefore = await shiftSoFar(page);
      await action();
      await page.waitForTimeout(800);
      const after = await boxes(page);
      const moved = Object.keys(before)
        .filter((key) => key in after)
        .map((key) => ({
          name: key,
          dx: after[key].x - before[key].x,
          dy: after[key].y - before[key].y,
          dw: after[key].w - before[key].w,
          dh: after[key].h - before[key].h,
        }))
        .filter(
          (item) =>
            Math.max(
              Math.abs(item.dx),
              Math.abs(item.dy),
              Math.abs(item.dw),
              Math.abs(item.dh),
            ) > TOLERANCE_PX,
        );
      shifts.push({
        step: name,
        moved,
        cls: Math.round(((await shiftSoFar(page)) - clsBefore) * 1000) / 1000,
      });
    }

    // Параллельные прогоны на одном стенде — разными обучаемыми.
    await login(page, process.env.E2E_TRAINEE ?? "trainee03");
    await page
      .getByRole("button", { name: /^(Диспетчер служб|Перейти в тренажёр)$/ })
      .click();
    await expect(page).toHaveURL(/\/arm/);
    await page.waitForTimeout(1500);

    await step("Тренировка → карточка", async () => {
      await page
        .getByRole("button", { name: /^Тренировка/ })
        .first()
        .click();
      // Запуск подтверждается (обработчики выше). Карточка открывается сама: прежний
      // запасной щелчок по первой строке реестра открывал чужую старую карточку, и сдвиг
      // мерился не на том пути (ревью 20.10).
      await expect(
        page.getByRole("region", { name: /^Происшествие \d+$/ }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page).toHaveURL(/\/arm\/cards\/[^/]+$/);
      await page.waitForTimeout(1500);
    });
    const id = decodeURIComponent(page.url().split("/").at(-1)!);
    const cards: Card[] = await (await page.request.get("/api/cards")).json();
    const card = cards.find((item) => item.id === id)!;
    const sessions: Session[] = await (
      await page.request.get("/api/sessions")
    ).json();
    const practice = sessions.find((item) => item.id === card.session_id)!;
    const cardView = page.getByRole("region", {
      name: `Происшествие ${card.source.number}`,
      exact: true,
    });

    await step("открыть форму статуса", () =>
      cardView
        .getByRole("button", { name: "Изменить статус", exact: true })
        .click(),
    );
    await step("выбрать статус", () =>
      cardView
        .getByLabel("Статус", { exact: true })
        .selectOption("accepted")
        .then(() => undefined),
    );
    await step("ввести комментарий", () =>
      cardView
        .getByLabel("Комментарий", { exact: true })
        .fill("Принята, направляю бригаду"),
    );
    await step("подтвердить статус", () =>
      cardView
        .getByRole("button", { name: "Подтвердить", exact: true })
        .click(),
    );
    // Связь службы — окно телефона ДДС (GP-09): значок на панели карточки открывает
    // его поверх карточки, ничего под ним не сдвигается.
    const win = phoneWindow(page);
    await step("открыть телефон", async () => {
      await openPhone(page);
    });
    // GP-05: флажков и «Направить выбранные» нет — бригаду направляет вводная.
    await step("позвонить бригаде", async () => {
      await freeBrigade(win).click();
      await page.waitForTimeout(4000);
    });
    await step("направить бригаду", async () => {
      await answer(win)
        .getByRole("button", { name: "По частям", exact: true })
        .click();
      // Верная часть шага (GP-06: варианты перемешаны, верный — data-correct).
      const parts = answer(win).locator(
        'button[data-reply="brief"][data-correct="true"]',
      );
      await parts.click();
      await expect(currentStep(win, "Что случилось")).toBeVisible();
      await parts.click();
      await page.waitForTimeout(1000);
    });
    // Доклад о выезде звучит в том же разговоре; отбой раньше — и бригада перезвонит.
    await expect
      .poll(
        async () =>
          (
            (await (
              await page.request.get(`/api/cards/${card.id}/training`)
            ).json()) as CardTraining
          ).messages.filter((item) => item.state === "presented").length,
        { timeout: 30_000 },
      )
      .toBe(1);
    await step("положить трубку", () =>
      win.getByRole("button", { name: "Положить трубку" }).click(),
    );
    await step("к контактам", () =>
      answer(win).getByRole("button", { name: "К контактам" }).click(),
    );
    await expect(
      win.getByRole("region", { name: "Доклады бригад" }).getByRole("listitem"),
    ).toHaveCount(1);

    await testInfo.attach("shifts.json", {
      body: JSON.stringify(shifts, null, 2),
      contentType: "application/json",
    });
    console.log(`SHIFTS ${viewport.width}: ${JSON.stringify(shifts)}`);

    // Уборка: тренировка не должна остаться идущей для других спек.
    const csrf = (await page.context().cookies()).find(
      (cookie) => cookie.name === "csrf",
    )?.value;
    await page.request.post(`/api/sessions/${practice.id}/finish`, {
      headers: { "X-CSRF-Token": csrf ?? "" },
    });

    // Шапка и карточка: эти блоки и кнопки стоят на месте после действия.
    const still: Record<string, string[]> = {
      // «?» в шапке появляется на экране карточки — его место занято заранее.
      "Тренировка → карточка": [
        "button:Порядок работы",
        "button:Сообщить об ошибке",
        "button:Выйти",
      ],
      // Строка статуса и окно истории встают поверх карточки (макет B) и ничего
      // не сдвигают; полоса проводника держит высоту под шаг и «Не забудьте…».
      "открыть форму статуса": ["help:card-services"],
      "подтвердить статус": [
        "help:card-address",
        "help:card-description",
        "help:card-incident",
        "help:card-services",
      ],
    };
    for (const [name, keys] of Object.entries(still))
      expect
        .soft(
          shifts
            .find((item) => item.step === name)
            ?.moved.filter((item) => keys.includes(item.name)),
          `сдвиг на шаге «${name}»`,
        )
        .toEqual([]);

    // Ключевые блоки на всём пути: области карточки, окно телефона, кнопки шапки не
    // сдвигаются от действия, CLS шага ниже порога «хорошо» Web Vitals (0,1) с
    // запасом. Законно меняются только раскрываемая форма статуса (card-action
    // растёт внутрь себя) и всплывающие подсказки «?». Окно телефона (card-phone,
    // GP-09) плавает поверх карточки: ни место, ни размер не зависят от состояния
    // звонка — контакты, вызов, разговор, итог.
    const KEY =
      /^(help:card-(?!action$|redirect$).+|button:(Порядок работы|Сообщить об ошибке|Выйти)|link:.+)$/;
    for (const shift of shifts) {
      expect
        .soft(
          shift.moved.filter((item) => KEY.test(item.name)),
          `сдвиг ключевых блоков на шаге «${shift.step}»`,
        )
        .toEqual([]);
      expect.soft(shift.cls, `CLS шага «${shift.step}»`).toBeLessThan(0.05);
    }

    // Окно телефона на месте и того же размера во всех состояниях звонка: рамка,
    // «В центр» и «Закрыть» не прыгают под рукой.
    for (const name of [
      "позвонить бригаде",
      "направить бригаду",
      "положить трубку",
      "к контактам",
    ])
      expect(
        shifts
          .find((item) => item.step === name)!
          .moved.filter((item) => /^help:card-phone$/.test(item.name)),
        `окно телефона на шаге «${name}»`,
      ).toEqual([]);
  });
