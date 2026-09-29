import { expect } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { test, login } from "./captain-fixture";

type Card = components["schemas"]["Card"];
type Session = components["schemas"]["Session"];
type Service = components["schemas"]["Service"];

// Шаг «Принять решение» в тренировке с подсказчиком: взгляд уводится с рамки
// адреса на плитку своей службы, пока не поставлена «Принята».
test("Тренировка: плитка своей службы выделена до «Принята»", async ({
  page,
}) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker, app.seed.training и явное E2E_DATABASE=1",
  );
  test.setTimeout(90_000);
  let practiceId: string | null = null;
  try {
    // Прежняя тренировка ещё идёт — подтверждаем окном «Начать заново».
    await page.addLocatorHandler(
      page.getByRole("dialog", { name: "Начать тренировку заново?" }),
      async (dialog) => {
        await dialog.getByRole("button", { name: "Начать заново" }).click();
      },
    );
    await login(page, "trainee05");
    await page
      .getByRole("button", { name: /^Тренировка/ })
      .first()
      .click();
    // Карточка тренировки открывается сама (учебный цикл, 29.09).
    await expect(page).toHaveURL(/\/arm\/cards\/[^/]+$/, { timeout: 20_000 });
    const id = decodeURIComponent(page.url().split("/").at(-1)!);
    const listed: Card[] = await (await page.request.get("/api/cards")).json();
    const card = listed.find((item) => item.id === id);
    expect(card).toBeDefined();
    practiceId = card!.session_id;
    const sessions: Session[] = await (
      await page.request.get("/api/sessions")
    ).json();
    const practice = sessions.find((item) => item.id === practiceId);
    expect(practice?.kind).toBe("practice");
    const services: Service[] = await (
      await page.request.get("/api/services")
    ).json();
    const name = services.find(
      (item) => item.id === practice!.participants[0].dds_service_id,
    )!.name;
    const plate = page.getByRole("button", { name: new RegExp(`^${name}`) });
    await expect(plate).toHaveClass(/manualNeeded/);
    // Акцент виден глазом: контур вокруг плашки, а не только имя класса.
    expect(
      await plate.evaluate((node) => getComputedStyle(node).outlineStyle),
    ).not.toBe("none");
    await plate.click();
    await page.getByLabel("Статус", { exact: true }).selectOption("accepted");
    await page
      .getByLabel("Комментарий", { exact: true })
      .fill("Принята, направляю бригаду.");
    await page.keyboard.press("Enter");
    const accepted = page.getByRole("button", {
      name: new RegExp(`^${name}.*Принята`),
    });
    await expect(accepted).not.toHaveClass(/manualNeeded/);
    await accepted.blur();
    expect(
      await accepted.evaluate((node) => getComputedStyle(node).outlineStyle),
    ).toBe("none");
  } finally {
    if (practiceId) {
      // Тренировка включает подсказки: не оставляем её идущей для других проверок.
      // Завершает её сам обучаемый: администратор в учебный процесс не вмешивается.
      await page.request.post("/api/auth/login", {
        data: {
          login: "trainee05",
          password: process.env.DEMO_PASSWORD ?? "demo-local",
        },
      });
      const csrf = (await page.request.storageState()).cookies.find(
        (cookie) => cookie.name === "csrf",
      )?.value;
      await page.request.post(`/api/sessions/${practiceId}/finish`, {
        headers: { "X-CSRF-Token": csrf ?? "" },
      });
    }
  }
});
