import { expect, type Page } from "@playwright/test";
import { test, login } from "./captain-fixture";
import { visitAdmin, visitTeacher } from "./captain-screens";

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
  admin: "Сервер: логин администратора, см. handoff.md",
  teacher: "Сервер: логин преподавателя, см. handoff.md",
  trainee: "Сервер: основа учебных логинов, см. handoff.md",
  fire: "Сервер: категория пожарной службы, см. handoff.md",
  police: "Сервер: категория полиции, см. handoff.md",
  medical: "Сервер: категория скорой помощи, см. handoff.md",
  gas: "Сервер: категория газовой службы, см. handoff.md",
  utilities: "Сервер: категория ЖКХ, см. handoff.md",
  lift: "Сервер: категория лифтовой службы, см. handoff.md",
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
  await page
    .getByRole("button", { name: "Подсказка: адрес", exact: true })
    .click();
  await expect(page.getByRole("note")).toBeVisible();
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
    "открыта подсказка",
  );
  await page.reload();
  await expect(page.locator('[data-help="card-history"] li')).toContainText([
    "карточка показана",
  ]);
  await russian(page, "Карточка после открытия подсказки и перезагрузки");
  await page.getByRole("button", { name: "Телефон", exact: true }).click();
  await russian(page, "Телефон");
  for (const digit of "102")
    await page.getByRole("button", { name: digit, exact: true }).click();
  await page.getByRole("button", { name: "Вызов", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Разговор", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await page
    .getByRole("button", { name: "Положить трубку", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Звонок завершён", exact: true })
    .click();
  await expect(page.locator('[data-help="card-history"]')).toContainText(
    "звонок завершён",
  );
  await russian(page, "Карточка после звонка");
  await page.screenshot({
    path: "scripts/ralph/artwox/logs/recheck/card-history.png",
  });
  await page.getByRole("button", { name: /Служба 102.*Получена/ }).click();
  await page.getByLabel("Статус", { exact: true }).selectOption("accepted");
  await page.getByLabel("Номер наряда", { exact: true }).fill("112");
  await page
    .getByLabel("Комментарий", { exact: true })
    .fill("Информация принята. Направлен наряд.");
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(page.locator('[data-help="card-history"]')).toContainText(
    "Принята",
  );
  await page.getByRole("button", { name: /Служба 102.*Принята/ }).click();
  await page.getByLabel("Статус", { exact: true }).selectOption("completed");
  await page
    .getByLabel("Комментарий", { exact: true })
    .fill("Работы завершены. Сведения переданы ответственному.");
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(page.getByText(/Нажмите ✓ ещё раз/)).toBeVisible();
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Разбор", exact: true }),
  ).toBeVisible();
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
