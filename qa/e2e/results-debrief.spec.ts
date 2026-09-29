import { expect } from "@playwright/test";
import { test, login } from "./captain-fixture";

// Разбор проваленной попытки (29.09): вердикт раньше процента, решение преподавателя
// раньше «Итогов», полный список критериев свёрнут. Карточка фикстуры закрыта и
// оценена подменой ответов API: проверяется порядок экрана, а не оценщик.
test("разбор проваленной попытки: вердикт первым, критерии свёрнуты", async ({
  page,
  lesson,
}) => {
  const closed = {
    ...lesson.card,
    state: "completed",
    closed_at: new Date().toISOString(),
  };
  const evaluation = {
    id: "e2e-evaluation",
    card_id: lesson.card.id,
    trainee_id: lesson.card.trainee_id,
    total: 0.5,
    status: "complete",
    teacher_comment: "Адрес нужно уточнять у заявителя.",
    version: 1,
    model_info: { rules: "v1" },
    criteria: [
      {
        key: "address",
        score: 0,
        weight: 1,
        critical: true,
        explanation: "Не подтверждены компоненты адреса: дом.",
        evidence: [
          "Проверен ручной адрес из полей ручного ввода",
          "Не совпали: дом",
        ],
      },
      {
        key: "routing",
        score: 1,
        weight: 1,
        critical: false,
        explanation: "Своя служба.",
        evidence: [],
      },
    ],
  };
  await page.route("**/api/cards", async (route) => {
    const response = await route.fetch();
    const cards = (await response.json()) as { id: string }[];
    // Переход «вход → Мои результаты» отменяет запрос списка, пока идёт fetch:
    // отменённый запрос уже обработан, подменять в нём нечего.
    await route
      .fulfill({
        response,
        json: cards.map((card) => (card.id === closed.id ? closed : card)),
      })
      .catch(() => undefined);
  });
  await page.route("**/api/evaluations", (route) =>
    route.fulfill({ json: [evaluation] }),
  );
  try {
    await login(page, "trainee05");
    await page.goto("/app/arm/results");
    const review = page.locator('[data-help="results-review"]');
    await expect(review.getByText("Не зачтено").first()).toBeVisible();
    const text = (await review.textContent()) ?? "";
    expect(text.indexOf("Не зачтено")).toBeLessThan(text.indexOf("50 %"));
    expect(text.indexOf("Главное на следующую попытку")).toBeGreaterThan(-1);
    expect(text.indexOf("Решение преподавателя")).toBeLessThan(
      text.indexOf("Итоги"),
    );
    await expect(
      review.locator("details > summary", { hasText: "Все критерии" }),
    ).toBeVisible();
    await expect(review.getByText("Не совпали: дом").first()).toBeVisible();
  } finally {
    // Не ждём обработчики: запрос списка, отменённый уходом со страницы, может
    // так и не завершиться, и ожидание съедало весь таймаут теста.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await lesson.finish();
  }
});
