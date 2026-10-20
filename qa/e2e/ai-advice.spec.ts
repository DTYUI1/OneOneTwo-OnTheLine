import { expect, test } from "@playwright/test";
import { passWelcome, playTutorial, signIn } from "./practice-play";

// GP-14 (рекомендации организаторов 16.10, п. 5, 9, 10): после закрытой карточки ИИ
// оценивает действия и пишет рекомендации — что подтянуть и следующий шаг. Их видят
// обучаемый (разбор, «Мой путь») и преподаватель (кабинет, путь обучаемых).
const OWNER = "trainee02";

test("После закрытой карточки — оценка и рекомендации у обучаемого и преподавателя", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker, app.seed.training и явное E2E_DATABASE=1",
  );
  test.skip(
    testInfo.project.name !== "chromium",
    "Одна учётка обучаемого: браузеры не делят тренировку",
  );
  test.setTimeout(240_000);
  page.setDefaultTimeout(15_000);
  await signIn(page, OWNER);
  await page.goto("about:blank");
  const card = await playTutorial(page.request);

  await page.goto("/app/arm");
  await passWelcome(page);
  await page.getByRole("link", { name: "Мои результаты" }).click();
  await page
    .getByRole("navigation", { name: "Закрытые карточки" })
    .getByRole("button", { name: new RegExp(card.source.number) })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Оценка" })).toBeVisible();
  const advice = page.getByLabel("Рекомендации");
  await expect(advice).toBeVisible({ timeout: 30_000 });
  await expect(advice).toContainText("Следующий шаг — ступень");

  const teacher = await browser.newPage();
  try {
    await signIn(teacher, "teacher");
    const panel = teacher.getByRole("region", {
      name: "Путь обучаемых и рекомендации",
    });
    await expect(panel).toBeVisible();
    const fullName = (await (await page.request.get("/api/auth/me")).json())
      .full_name as string;
    await expect(
      panel.getByRole("row", { name: new RegExp(fullName) }),
    ).toContainText("Следующий шаг — ступень");
  } finally {
    await teacher.close();
  }
});
