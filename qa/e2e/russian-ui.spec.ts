import { expect, type Page } from "@playwright/test";
import { test, login } from "./captain-fixture";
import { visitAdmin, visitTeacher } from "./captain-screens";
import {
  backToContacts,
  closePhone,
  dialTyped,
  expectEnded,
  openPhone,
} from "./phone";
import { confirmAgain } from "./trainer";

// Обозначения формата, методики, клавиш и коды справочника служб.
const ALLOWED: Record<string, string> = {
  "I-TIME": "Название методики времени",
  CSV: "Формат выгрузки отчёта",
  "Caps Lock": "Надпись клавиши фиксации регистра",
  Esc: "Клавиша отмены",
  Enter: "Клавиша подтверждения",
  Backspace: "Клавиша удаления",
  MOSLIFT: "Код службы Мослифт из данных",
  GKH: "Код службы ЖКХ из данных",
  SMS: "Надпись «список SMS» в шапке карточки, снимок arm_dds/06 (макет B)",
  admin: "Сервер: логин администратора, см. handoff.md",
  teacher: "Сервер: логин преподавателя, см. handoff.md",
  trainee: "Сервер: основа учебных логинов, см. handoff.md",
  fire: "Сервер: категория пожарной службы, см. handoff.md",
  police: "Сервер: категория полиции, см. handoff.md",
  medical: "Сервер: категория скорой помощи, см. handoff.md",
  gas: "Сервер: категория газовой службы, см. handoff.md",
  utilities: "Сервер: категория ЖКХ, см. handoff.md",
  lift: "Сервер: категория лифтовой службы, см. handoff.md",
  system112: "Сервер: категория Системы-112 в справочнике служб (GP-04)",
  voice: "Сервер: идентификатор профиля голоса voice-1…6, см. handoff.md",
  city: "Сервер: evidence проверки адреса, см. handoff.md",
  street: "Сервер: evidence проверки адреса, см. handoff.md",
  house: "Сервер: evidence проверки адреса, см. handoff.md",
  received: "Сервер: evidence последовательности статусов, см. handoff.md",
  accepted: "Сервер: evidence последовательности статусов, см. handoff.md",
  responding: "Сервер: evidence последовательности статусов, см. handoff.md",
  completed: "Сервер: evidence последовательности статусов, см. handoff.md",
  rejected: "Сервер: evidence отказа и маршрутизации, см. handoff.md",
  redirected:
    "Сервер: evidence перенаправления и маршрутизации, см. handoff.md",
  service_number:
    "Сервер: пояснение проверки обязательного номера наряда, см. handoff.md",
};
async function russian(page: Page, screen: string) {
  // Дожидаемся запросов к локальному API, чтобы проверять содержимое, а не только «Загрузка».
  await expect(
    page.getByText(/^(?:Загрузка|Загружаем)(?:\s.*)?…$/i),
  ).toHaveCount(0);
  let content = await page.locator("body").innerText();
  // Сервер: название занятия из brigade-audio.spec.ts содержит браузер и хеш.
  // Исключён только этот формат тестовых данных, см. handoff.md.
  content = content.replace(
    /(?<=Бригады )(?:chromium|firefox) [0-9a-f]{8}\b/g,
    "",
  );
  // Сервер: полные UUID в названиях прошлых тестовых занятий; см. handoff.md.
  // Части идентификаторов не являются английскими словами. Иной текст не исключается.
  content = content.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    "",
  );
  for (const phrase of Object.keys(ALLOWED))
    content = content.replace(
      new RegExp(`(?<![A-Za-z])${phrase}(?![A-Za-z])`, "g"),
      "",
    );
  const words = [...new Set(content.match(/[A-Za-z]{3,}/g) ?? [])];
  expect.soft(words, screen).toEqual([]);
}

test("Русский интерфейс всех ролей с реальной карточкой", async ({
  page,
  browser,
  lesson,
}) => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  await login(page, "trainee05");
  await russian(page, "Список происшествий");
  await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
  await russian(page, "Карточка");
  // Подсказок «?» у полей с 29.09 нет (df0b29c): `hint_open` в занятии пишет
  // «Объяснение экрана» открытой карточки.
  await page
    .getByRole("button", { name: "Объяснение экрана", exact: true })
    .click();
  await expect(page.locator('[data-help-ui] [role="region"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => {
      const events = (await (
        await page.request.get(`/api/cards/${lesson.card.id}/events`)
      ).json()) as { type: string }[];
      return events.some((event) => event.type === "hint_open");
    })
    .toBe(true);
  await expect(page.locator('[data-help="card-history"]')).toContainText(
    "карточка открыта",
  );
  await page.reload();
  await expect(page.locator('[data-help="card-history"] li')).toContainText([
    "карточка показана",
  ]);
  await russian(page, "Карточка после перезагрузки");
  // Связь службы — окно телефона ДДС (GP-09): контакты, разговор и итог по-русски.
  await openPhone(page);
  await russian(page, "Телефон ДДС");
  const talk = await dialTyped(page, "102");
  await russian(page, "Разговор по телефону ДДС");
  await talk
    .getByRole("button", { name: "Положить трубку", exact: true })
    .click();
  await expectEnded(talk);
  await russian(page, "Итог звонка");
  await backToContacts(talk);
  await closePhone(page);
  await expect(page.locator('[data-help="card-history"]')).toContainText(
    "звонок завершён",
  );
  await russian(page, "Карточка после звонка");
  await page.screenshot({
    path: "scripts/ralph/artwox/logs/recheck/card-history.png",
  });
  await page
    .getByRole("button", { name: "Изменить статус", exact: true })
    .click();
  await page.getByLabel("Статус", { exact: true }).selectOption("accepted");
  await page.getByLabel("Номер наряда", { exact: true }).fill("112");
  await page
    .getByLabel("Комментарий", { exact: true })
    .fill("Информация принята. Направлен наряд.");
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(page.locator('[data-help="card-history"]')).toContainText(
    "Принята",
  );
  await page
    .getByRole("button", { name: "Изменить статус", exact: true })
    .click();
  await page.getByLabel("Статус", { exact: true }).selectOption("completed");
  await page
    .getByLabel("Комментарий", { exact: true })
    .fill("Работы завершены. Сведения переданы ответственному.");
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  // Необратимый статус — вторым ✓: у ✓ подпись «Нажмите ✓ или Enter ещё раз» (17.10).
  await expect(confirmAgain(page)).toBeVisible();
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  // Карточка закрыта: карандаша на своей плитке больше нет (разбор — в «Моих
  // результатах», кнопки «Разбор» в АРМ нет — макет B).
  await expect(
    page.getByRole("button", { name: "Изменить статус", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('[data-help="card-history"]')).toContainText(
    "Работы завершены",
  );
  await russian(page, "Закрытая карточка с историей действий");
  await expect
    .poll(
      async () => {
        const evaluations = (await (
          await page.request.get("/api/evaluations")
        ).json()) as { card_id: string }[];
        return evaluations.some((e) => e.card_id === lesson.card.id);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await lesson.finish();
  await page.goto("/app/arm/results");
  await russian(page, "Мои результаты и разбор");
  await page.goto("/app/results");
  await russian(page, "Мои результаты из шапки");
  await page.goto("/app/arm/reference");
  await russian(page, "Справка");
  // Для обхода преподавателя требуется текущий сценарий: результат уже сохранён,
  // список завершённых открывается после входа внутри общего обхода.
  const teacher = await browser.newPage({
    baseURL: test.info().project.use.baseURL,
  });
  try {
    await visitTeacher(teacher, lesson.session.title, (name) =>
      russian(teacher, name),
    );
  } finally {
    await teacher.close();
  }
  const admin = await browser.newPage({
    baseURL: test.info().project.use.baseURL,
  });
  try {
    await visitAdmin(admin, (name) => russian(admin, name));
  } finally {
    await admin.close();
  }
});
