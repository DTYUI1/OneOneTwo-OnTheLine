import { expect } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { test, login } from "./captain-fixture";

type Card = components["schemas"]["Card"];
type Session = components["schemas"]["Session"];
type Service = components["schemas"]["Service"];

// «Тренировка» без этапа — «Сам», тест (решение 17.10): тренажёр молчит. Ни подсказки у
// элемента, ни «Подсказать», ни подсказки застрявшему — даже после 15 с без действий; в
// журнал карточки подсказки не пишутся. Поверх АРМ ни пузыря, ни рамки.
test("Тренировка «Сам»: от тренажёра на экране ничего, и застрявшему тоже", async ({
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
    // Плитка своей службы — та, на которой карандаш (макет B).
    const pencil = page.getByRole("button", {
      name: "Изменить статус",
      exact: true,
    });
    const plate = pencil.locator("..");
    await expect(plate).toContainText(name);
    const coach = page.getByRole("region", { name: "Подсказка тренажёра" });
    await expect(coach).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Подсказать", exact: true }),
    ).toHaveCount(0);
    // Прежний порог «застрял» — 15 с без действий: на тесте подсказка не приходит.
    await page.waitForTimeout(17_000);
    await expect(coach).toHaveCount(0);
    await expect(page.getByText("«Принята» ждёт")).toHaveCount(0);
    expect(
      await plate.evaluate((node) => getComputedStyle(node).outlineStyle),
    ).toBe("none");
    await page.getByLabel("Статус", { exact: true }).selectOption("accepted");
    await page
      .getByLabel("Комментарий", { exact: true })
      .fill("Принята, направляю бригаду.");
    await page.keyboard.press("Enter");
    await expect(plate).toContainText("Принята");
    await expect(coach).toHaveCount(0);
    const events: { type: string; payload: { hint_id?: string } }[] = await (
      await page.request.get(`/api/cards/${id}/events`)
    ).json();
    expect(events.filter((event) => event.type === "hint_open")).toEqual([]);
  } finally {
    if (practiceId) {
      // Не оставляем тренировку идущей для других проверок.
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
