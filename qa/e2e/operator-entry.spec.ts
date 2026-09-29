import { expect } from "@playwright/test";
// test фикстуры закрывает окно «Параллельная работа», если оно осталось от занятия.
import { login, test } from "./captain-fixture";

// Вход в модуль «Оператор 112»: выбор на приветствии, из шапки; выход крестиком — на экран
// результатов 112, оттуда крестиком — к выбору обучения (просьба капитана 29.09).
test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");
// Экран оператора вёрстан под 1920×1080 (docs/screenshots/card_112).
test.use({ viewport: { width: 1920, height: 1080 } });

test("на приветствии обучаемый выбирает обучение оператора 112", async ({
  page,
}) => {
  await page.goto("/app/login");
  // Экран входа копирует Систему 112, но подпись говорит, что это тренажёр.
  await expect(
    page.getByRole("heading", {
      name: /Учебный тренажёр оператора 112 и диспетчера служб/,
    }),
  ).toBeVisible();
  await page.getByLabel("Логин", { exact: true }).fill("trainee04");
  await page
    .getByLabel("Пароль")
    .fill(process.env.DEMO_PASSWORD ?? "demo-local");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.getByRole("button", { name: "Оператор 112" }).click();
  await expect(page).toHaveURL(/\/app\/operator/);
  // Проводник включён у каждого нового звонка: снятая галочка не запоминается.
  const guide = page.getByRole("checkbox", {
    name: "Проводник: подсказка на каждом шаге",
  });
  await expect(guide).toBeChecked();
  await guide.uncheck();
  await page.reload();
  await expect(guide).toBeChecked();
  // Этап 2: звонок начинается, когда оператор принял вызов.
  await page.getByRole("button", { name: "Принять вызов" }).click();
  const talk = page.getByRole("region", { name: "Разговор с заявителем" });
  await expect(talk.getByRole("listitem").first()).toHaveText(/^Заявитель: /);
});

test("обучаемый: выход из 112 — результаты, крестик — выбор обучения", async ({
  page,
}) => {
  await login(page, "trainee05");
  // Ссылка в шапке — к выбору обучения, «112» оттуда — в модуль.
  await page.getByRole("link", { name: "Оператор 112" }).click();
  await expect(
    page.getByRole("heading", { name: "Выберите обучение" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Оператор 112" }).click();
  await expect(page).toHaveURL(/\/app\/operator$/);
  // Карточка во весь экран, как в Системе 112: шапки тренажёра нет.
  await expect(page.getByRole("button", { name: "Выйти" })).toHaveCount(0);
  await page.getByRole("button", { name: "Принять вызов" }).click();
  // Сохранённая попытка появится на экране результатов.
  await page.getByRole("button", { name: "сохранить", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Результат попытки" });
  await review.getByRole("button", { name: "Закрыть разбор" }).click();
  await page.getByRole("button", { name: "Закрыть карточку" }).click();

  await expect(page).toHaveURL(/\/app\/operator\/results/);
  const results = page.getByRole("main", {
    name: "Результаты тренировок «Оператор 112»",
  });
  await expect(results).toBeVisible();
  await expect(
    results.getByRole("button", { name: /\d+ \/ 100/ }).first(),
  ).toBeVisible();
  await expect(
    results.getByRole("region", { name: "Баллы попытки" }),
  ).toContainText("Тип происшествия");
  await expect(
    results.getByRole("region", { name: "Разбор звонка" }),
  ).toContainText("Звонок начался");

  await results.getByRole("button", { name: "Закрыть результаты" }).click();
  await expect(
    page.getByRole("heading", { name: "Выберите обучение" }),
  ).toBeVisible();
  // «112» — снова звонок; выход и крестик снова приводят к выбору.
  await page.getByRole("button", { name: "Оператор 112" }).click();
  await expect(page).toHaveURL(/\/app\/operator$/);
  await page.getByRole("button", { name: "Принять вызов" }).click();
  await page.getByRole("button", { name: "Закрыть карточку" }).click();
  await page.getByRole("button", { name: "Закрыть результаты" }).click();
  // «Диспетчер служб» — АРМ ДДС с шапкой тренажёра.
  await page.getByRole("button", { name: "Диспетчер служб" }).click();
  await expect(page).toHaveURL(/\/app\/arm/);
  await expect(page.getByRole("button", { name: "Выйти" })).toBeVisible();
});

test("преподаватель заходит в «Оператор 112» из шапки и возвращается в кабинет", async ({
  page,
}) => {
  await login(page, "teacher");
  await page.getByRole("link", { name: "Оператор 112" }).click();
  await expect(page).toHaveURL(/\/app\/operator/);
  await page.getByRole("button", { name: "Принять вызов" }).click();
  await page.getByRole("button", { name: "Закрыть карточку" }).click();
  await expect(page).toHaveURL(/\/app\/operator\/results/);
  // У преподавателя выбора обучения нет — крестик ведёт в кабинет.
  await page.getByRole("button", { name: "Закрыть результаты" }).click();
  await expect(page).toHaveURL(/\/app\/teacher/);
});

test("крестик выбора обучения — выход из учётной записи на экран входа", async ({
  page,
}) => {
  await login(page, "trainee03");
  await page.getByRole("link", { name: "Оператор 112" }).click();
  await page.getByRole("button", { name: "Вернуться ко входу" }).click();
  await expect(page).toHaveURL(/\/app\/login$/);
  await expect(
    page.getByRole("heading", { name: /Вход в систему/ }),
  ).toBeVisible();
  // Сессия закрыта: без нового входа АРМ не открывается.
  await page.goto("/app/arm");
  await expect(page).toHaveURL(/\/app\/login$/);
});
