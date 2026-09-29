import { expect, test, type Page } from "@playwright/test";
import { login } from "./captain-fixture";
import {
  advise,
  ask,
  askOwn,
  calm,
  cardQuestions,
  confirmAddress,
  fillAddress,
  hardMode,
  hold,
  lastLine,
  moveTalkAside,
  openCall,
  questions,
  scenario,
  stepTab,
  talk,
} from "./operator-call";

// Этап 3 плана docs/operator_112_review/PLAN.md — методика и разбор: вопросы по шагам опроса
// (3–4 варианта шага вместо викторины), «Сложно» — свой вопрос, повтор адреса ловит ошибку
// на слух, разбор звонка с пометками и «Пройти заново», справка «?», проводник первого
// звонка, выбор звонка перед приёмом.
test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");
test.use({ viewport: { width: 1536, height: 864 } });

const DTP = scenario("dtp_victims_fuel");
const GIRL = scenario("fire_apartment_smoke");
const DTP_Q = Object.fromEntries(
  cardQuestions("dtp_victims_fuel").map((item) => [item.key, item.text]),
);
const GIRL_Q = Object.fromEntries(
  cardQuestions("fire_apartment_smoke").map((item) => [item.key, item.text]),
);
const extra = (key: string) =>
  DTP.distractors.find((item) => item.key === key)!;

/** Что сделал бы новичок, прочитав подсказку проводника, — только то, что в ней сказано. */
async function followTip(page: Page, title: string) {
  const answer = (group: string, value: string) =>
    page
      .getByRole("group", { name: group })
      .getByRole("button", { name: value, exact: true })
      .click();
  switch (title) {
    case "Заявитель кричит и не слышит вопросов":
    case "Паника ещё высокая":
      return calm(page);
    case "Шаг 1 — адрес":
      return ask(page, GIRL_Q.address!);
    case "Внесите адрес в карточку":
      // Записать, что услышал: «Дубнинская улица, дом двенадцать, квартира сорок семь…
      // Район Западное Дегунино».
      await fillAddress(page, {
        "Улица:": "Дубнинская улица",
        "Дом/Вл:": "12",
        "Квартира/офис:": "47",
      });
      return page.getByLabel("Район:").fill("Западное Дегунино");
    case "Спросите ориентир":
      return ask(page, GIRL_Q.landmark!);
    case "Повторите адрес вслух":
      return confirmAddress(page);
    case "Шаг 2 — номер для связи":
      await ask(page, GIRL_Q.callback!);
      return ask(page, GIRL_Q.name!);
    case "Выберите тип происшествия":
      // «Из-под двери идёт густой дым, открытого огня я не вижу» — задымление.
      await page.getByLabel("Тип происшествия").fill("задымление квартира");
      return page
        .getByRole("button", { name: /^задымление: квартира/ })
        .click();
    case "Шаги 3 и 4":
      for (const key of ["what_happened", "since", "victims", "self_safety"])
        await ask(page, GIRL_Q[key]!);
      return;
    case "Шаг 5 — детали и доступ":
      for (const key of ["floor", "access", "gas"])
        await ask(page, GIRL_Q[key]!);
      return;
    case "Отметьте опросную карту":
      // За дверью бабушка; у соседей газовая плита.
      await answer("Угроза людям", "Да");
      return answer("Проведена ли газификация", "Да");
    case "Ситуация ухудшилась":
      return advise(page, /^«Прикройте нос и рот мокрой тканью/);
    case "Пауза — это тоже сигнал":
      return hold(page);
    case "Опишите своими словами":
      return page
        .getByLabel("Описание со слов заявителя")
        .fill(
          "Задымление в квартире 47 на пятом этаже: из-под двери густой дым, огня нет. " +
            "В квартире пожилая соседка, не открывает на стук, квартира заперта изнутри. " +
            "Дым дошёл до лестничной площадки.",
        );
    default:
      throw new Error(`Нет действия на подсказку «${title}»`);
  }
}

test("вопросы по шагам: 3–4 варианта, лишний вопрос злит, пройденный шаг ведёт дальше", async ({
  page,
}) => {
  await openCall(page, "dtp_victims_fuel");
  await expect(stepTab(page, 1)).toHaveAttribute("aria-current", "step");
  await expect(stepTab(page, 1)).toHaveAttribute("aria-pressed", "true");
  // До записи улицы: адрес, ориентир и лишний вопрос о квартире; затем появится повтор.
  await expect(questions(page).getByRole("button")).toHaveCount(3);

  await ask(page, DTP_Q.address!);
  expect(await lastLine(page)).toBe(`Заявитель: ${DTP.answers.address!.calm}`);
  // Лишний вопрос: свой раздражённый ответ, кнопка — «уже задан».
  const flat = extra("apartment");
  await ask(page, flat.text);
  expect(await lastLine(page)).toBe(`Заявитель: ${flat.reply}`);
  await expect(
    questions(page).getByRole("button", { name: flat.text, exact: true }),
  ).toHaveAccessibleDescription("Вопрос уже задан");

  await fillAddress(page, {
    "Улица:": "Кутузовский проспект",
    "Дом/Вл:": "34",
  });
  await expect(questions(page).getByRole("button")).toHaveCount(4);
  await confirmAddress(page);
  expect(await lastLine(page)).toBe(
    `Заявитель: ${DTP.address_confirmation.ok}`,
  );
  await ask(page, DTP_Q.landmark!);
  // Шаг 1 пройден — галочка, вкладка сама перешла к шагу 2 и его вопросам.
  await expect(stepTab(page, 1)).toHaveAttribute("data-done", "true");
  await expect(stepTab(page, 1)).toHaveAccessibleName("1. Адрес — пройден");
  await expect(stepTab(page, 2)).toHaveAttribute("aria-current", "step");
  await expect(
    questions(page).getByRole("button", { name: DTP_Q.callback!, exact: true }),
  ).toBeVisible();
  // Любой шаг можно открыть щелчком; текущий шаг от этого не меняется.
  await stepTab(page, 4).click();
  await expect(
    questions(page).getByRole("button", { name: DTP_Q.victims!, exact: true }),
  ).toBeVisible();
  await expect(stepTab(page, 2)).toHaveAttribute("aria-current", "step");
});

test("«Сложно»: свой вопрос словами вместо вариантов", async ({ page }) => {
  await openCall(page, "dtp_victims_fuel");
  await hardMode(page).check();
  // Вариантов нет — только поле своего вопроса; вкладки шагов остаются.
  await expect(questions(page)).toHaveCount(0);
  await expect(stepTab(page, 1)).toBeVisible();
  await askOwn(page, "Где произошла авария?");
  expect(await lastLine(page)).toBe(`Заявитель: ${DTP.answers.address!.calm}`);
  await askOwn(page, "Какая сегодня погода?");
  expect(await lastLine(page)).toBe("Заявитель: Что? Не расслышал, повторите!");
  await hardMode(page).uncheck();
  await expect(questions(page).getByRole("button").first()).toBeVisible();
});

test("повтор адреса вслух ловит «Дубининскую» из панического ответа", async ({
  page,
}) => {
  await openCall(page, "fire_apartment_smoke");
  await calm(page);
  // Паника ещё высокая: адрес звучит с ошибкой на слух.
  await ask(page, GIRL_Q.address!);
  expect(await lastLine(page)).toContain("Дубининская");
  await fillAddress(page, {
    "Улица:": "Дубининская улица",
    "Дом/Вл:": "12",
    "Квартира/офис:": "47",
  });
  await expect(
    questions(page).getByRole("button", {
      name: "Проверю адрес: Дубининская улица, дом 12, квартира 47. Верно?",
    }),
  ).toBeVisible();
  await confirmAddress(page);
  expect(await lastLine(page)).toBe(
    `Заявитель: ${GIRL.address_confirmation.wrong_street}`,
  );
  await fillAddress(page, { "Улица:": "Дубнинская улица" });
  await confirmAddress(page);
  expect(await lastLine(page)).toBe(
    `Заявитель: ${GIRL.address_confirmation.ok}`,
  );
});

test("разбор звонка: лента с пометками, время шагов, эталонный порядок, «Пройти заново»", async ({
  page,
}) => {
  await openCall(page, "dtp_victims_fuel", { user: "trainee02" });
  // Имя раньше адреса — вопрос раньше времени; дальше — по шагам.
  await ask(page, DTP_Q.name!);
  await ask(page, DTP_Q.address!);
  await fillAddress(page, {
    "Улица:": "Кутузовский проспект",
    "Дом/Вл:": "34",
  });
  await confirmAddress(page);
  await ask(page, DTP_Q.landmark!);
  await page.getByRole("button", { name: "сохранить", exact: true }).click();

  const result = page.getByRole("dialog", { name: "Результат попытки" });
  await expect(result).toBeVisible();
  await expect(result).toContainText("Порядок опроса: первым спрошен не адрес");
  const review = result.getByRole("region", { name: "Разбор звонка" });
  const timeline = review.getByRole("list", { name: "Лента разговора" });
  await expect(timeline).toContainText("событие: Звонок начался");
  await expect(timeline).toContainText(
    "навредило: Адреса ещё нет — вопрос раньше времени.",
  );
  await expect(timeline).toContainText("Паника выросла.");
  await expect(timeline).toContainText(
    "помогло: Адрес подтверждён повтором — как требует стандарт приёма вызова.",
  );
  await expect(timeline).toContainText("Карточка сохранена, разговор окончен.");
  const steps = review.getByRole("list", { name: "Время шагов опроса" });
  await expect(steps.getByRole("listitem").first()).toContainText(
    /1\. Адрес\s*\d\d:\d\d/,
  );
  await expect(steps.getByRole("listitem").nth(2)).toContainText("не пройден");
  await expect(result).toContainText(DTP.reference_order[0]!);

  // «Пройти заново» — тот же звонок с начала: снова входящий вызов этого заявителя.
  await result.getByRole("button", { name: "Пройти заново" }).click();
  const incoming = page.getByRole("dialog", { name: "Входящий вызов 112" });
  await expect(incoming).toContainText("+7 (926) 123-45-67");
  await expect(
    incoming.getByRole("radio", { name: "Мужчина, 45 лет" }),
  ).toBeChecked();
  await incoming.getByRole("button", { name: "Принять вызов" }).click();
  await expect(talk(page).getByRole("listitem").first()).toHaveText(
    `Заявитель: ${DTP.opening}`,
  );
  await expect(page.getByRole("timer")).toHaveText(/00:0\d/);
});

test("«?» объясняет каждую часть экрана", async ({ page }) => {
  await openCall(page, "fire_apartment_smoke");
  await page.getByLabel("Тип происшествия").fill("задымление квартира");
  await page.getByRole("button", { name: /^задымление: квартира/ }).click();
  // Справка перечисляет видимые части: открываем описание, закрытое окном слева.
  await moveTalkAside(page, "right");
  await talk(page).getByRole("button", { name: "Объяснение экрана" }).click();
  const help = page.getByRole("region", {
    name: "Объяснение экрана оператора 112",
  });
  await expect(help).toBeVisible();
  await expect(help).toContainText("1 из 10");
  const titles: string[] = [];
  for (let part = 0; part < 10; part++) {
    titles.push(await help.getByRole("heading").innerText());
    if (part < 9) await help.getByRole("button", { name: "Далее" }).click();
  }
  expect(titles.map((title) => title.replace(/^\d+\. /, ""))).toEqual([
    "Телефоны, номер и таймер",
    "Заявитель",
    "Адрес",
    "Описание со слов заявителя",
    "Быстрые кнопки",
    "Тип происшествия",
    "Опросная карта",
    "Разговор с заявителем",
    "Шаги опроса",
    "Службы и сохранение",
  ]);
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
});

test("проводник: одна подсказка, над разговором, щелчки не перехватывает, скрывается на звонок", async ({
  page,
}) => {
  await openCall(page, "fire_apartment_smoke", { guide: true });
  const tip = page.getByRole("status", { name: "Проводник" });
  await expect(tip).toContainText(
    "Проводник · Заявитель кричит и не слышит вопросов",
  );
  // Цель — «Успокоить» в разговоре: подсказка над всей панелью, вопросы и кнопки открыты.
  const bubble = (await tip.boundingBox())!;
  const panel = (await talk(page).boundingBox())!;
  expect(bubble.y + bubble.height).toBeLessThanOrEqual(panel.y);
  expect(
    await tip.evaluate((element) => getComputedStyle(element).pointerEvents),
  ).toBe("none");
  await calm(page);
  await calm(page);
  // Адрес прозвучал — подсказка ведёт к полю «Улица:», под ним.
  await expect(tip).toContainText("Внесите адрес в карточку");
  const street = (await page
    .getByLabel("Улица:", { exact: true })
    .boundingBox())!;
  expect((await tip.boundingBox())!.y).toBeGreaterThan(street.y);
  // Под подсказкой поле доступно: ввод идёт, подсказка ведёт дальше.
  await fillAddress(page, { "Улица:": "Дубнинская улица", "Дом/Вл:": "12" });
  await expect(tip).toContainText("Спросите ориентир");

  await tip.getByRole("button", { name: "Скрыть проводник" }).click();
  await expect(tip).toHaveCount(0);
  // «Скрыть проводник» — только на этот звонок: у следующего флажок снова стоит
  // (просьба капитана 29.09).
  await page.goto("/app/operator?scenario=fire_apartment_smoke");
  await expect(
    page
      .getByRole("dialog", { name: "Входящий вызов 112" })
      .getByRole("checkbox", { name: "Проводник: подсказка на каждом шаге" }),
  ).toBeChecked();
});

test("выбор звонка перед приёмом: случайный или конкретный персонаж", async ({
  page,
}) => {
  await login(page, "teacher");
  await page.goto("/app/operator");
  const incoming = page.getByRole("dialog", { name: "Входящий вызов 112" });
  await expect(
    incoming.getByRole("radio", { name: "Случайный звонок" }),
  ).toBeChecked();
  for (const label of [
    "Девушка, 22 года",
    "Мужчина, 45 лет",
    "Пожилая женщина, 72 года",
    "Мальчик, 9 лет",
  ])
    await expect(incoming.getByRole("radio", { name: label })).toBeVisible();
  await incoming.getByRole("radio", { name: "Мальчик, 9 лет" }).check();
  await expect(page).toHaveURL(/scenario=elevator_stuck/);
  await expect(incoming).toContainText("+7 (916) 123-98-76");
  await incoming.getByRole("button", { name: "Принять вызов" }).click();
  await expect(talk(page).getByRole("listitem").first()).toHaveText(
    `Заявитель: ${scenario("elevator_stuck").opening}`,
  );
});

test("новичок проходит первый звонок сам — по подсказкам проводника", async ({
  page,
}) => {
  // Самый трудный звонок — девушка в истерике. Каждое действие — только то, что сказано
  // в подсказке проводника (followTip); чек-лист «пригоден для обучения», п. 2.
  await openCall(page, "fire_apartment_smoke", {
    user: "trainee03",
    guide: true,
  });
  const tip = page.getByRole("status", { name: "Проводник" });
  const seen: string[] = [];
  for (let turn = 0; turn < 30; turn++) {
    await expect(tip).toBeVisible();
    const title = (await tip.locator("b").innerText()).replace(
      /^Проводник · /,
      "",
    );
    if (title === "Сохраните карточку") break;
    seen.push(title);
    await followTip(page, title);
    // Сделал, что сказано, — проводник ведёт дальше. Подсказка о паузе держится несколько
    // секунд после «Алло?», её не ждём.
    if (title !== "Пауза — это тоже сигнал")
      await expect(tip.locator("b")).not.toHaveText(`Проводник · ${title}`);
  }
  expect(seen.slice(0, 2)).toEqual([
    "Заявитель кричит и не слышит вопросов",
    "Паника ещё высокая",
  ]);
  await page.getByRole("button", { name: "сохранить", exact: true }).click();
  const result = page.getByRole("dialog", { name: "Результат попытки" });
  await expect(result).toBeVisible();
  const [total] = (await result.getByText(/^\d+ из \d+$/).innerText())
    .split(" из ")
    .map(Number);
  expect(total).toBeGreaterThanOrEqual(95);
  await expect(result).toContainText("Порядок по стандарту");
  // После сохранения проводник замолкает.
  await expect(tip).toHaveCount(0);
});
