import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { test, login } from "./captain-fixture";
import { lesson, waitCard } from "./memo-lesson";

// TC-08: комментарий и действия без досадных ошибок (docs/dds_touches.md).
//  - на занятии (тест, решение 17.10) подсказки понятности нет: «ghbyznf» и «ок» не ловятся,
//    поле не блокируется (подсказка — только во «Вместе», trainer-zone.spec.ts);
//  - двойной щелчок по статусу и повтор с новым ключом — одно событие;
//  - обрыв связи: «Работа не потеряна, переподключение через N с… · Повторить сейчас»,
//    действия лежат в очереди и после восстановления уходят по порядку.
test.skip(
  process.env.E2E_DATABASE !== "1",
  "Нужен стенд с базой: E2E_DATABASE=1",
);

type Event = { type: string; payload: Record<string, unknown> };

async function openLine(page: Page, sessionId: string) {
  const card = await waitCard(page, sessionId);
  await page.locator(`[data-card-id="${card.id}"]`).click();
  const view = page.getByRole("region", {
    name: `Происшествие ${card.source.number}`,
    exact: true,
  });
  await view
    .getByRole("button", { name: "Изменить статус", exact: true })
    .click();
  await view.getByLabel("Статус", { exact: true }).selectOption("accepted");
  return { card, view };
}

async function events(page: Page, cardId: string): Promise<Event[]> {
  return (await page.request.get(`/api/cards/${cardId}/events`)).json();
}

test("комментарий на занятии: подсказки понятности нет, поле не блокируется", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const current = await lesson(request, "102");
  try {
    await login(page, "trainee05");
    const { view } = await openLine(page, current.id);
    const comment = view.getByLabel("Комментарий", { exact: true });
    const hint = page.getByRole("status", { name: "Понятность комментария" });

    // Пауза в наборе больше секунды — подсказка пришла бы, будь это обучение.
    await comment.fill("ghbyznf");
    await page.waitForTimeout(1_500);
    await expect(hint).toHaveCount(0);
    await expect(comment).toHaveValue("ghbyznf");

    await comment.fill("ок");
    await page.waitForTimeout(1_500);
    await expect(hint).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Подсказка тренажёра" }),
    ).toHaveCount(0);
    // «Подтвердить» сохраняет и так.
    await view
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();
    await expect(view.getByText(/^\d\d:\d\d Принята$/)).toBeVisible();
  } finally {
    await current.finish();
  }
});

test("двойной щелчок по «Подтвердить» и повтор новым ключом — одно событие", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const current = await lesson(request, "102");
  try {
    await login(page, "trainee05");
    const { card, view } = await openLine(page, current.id);
    await view
      .getByLabel("Комментарий", { exact: true })
      .fill("Принята, направлен наряд");
    await view
      .getByRole("button", { name: "Подтвердить", exact: true })
      .dblclick();
    await expect(view.getByText(/^\d\d:\d\d Принята$/)).toBeVisible();
    // Тот же статус с тем же телом, но с новым client_event_id — повтор, а не 409.
    const csrf = (await page.request.storageState()).cookies.find(
      (item) => item.name === "csrf",
    )!.value;
    const again = await page.request.post(`/api/cards/${card.id}/events`, {
      headers: { "X-CSRF-Token": csrf },
      data: {
        client_event_id: randomUUID(),
        client_ts: new Date().toISOString(),
        type: "status_change",
        payload: { state: "accepted", comment: "Принята, направлен наряд" },
      },
    });
    expect(again.status(), await again.text()).toBe(200);
    expect((await again.json()).duplicate).toBe(true);
    const accepted = (await events(page, card.id)).filter(
      (item) =>
        item.type === "status_change" && item.payload.state === "accepted",
    );
    expect(accepted).toHaveLength(1);
  } finally {
    await current.finish();
  }
});

test("обрыв связи: «Работа не потеряна…», действия уходят по порядку после «Повторить сейчас»", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const current = await lesson(request, "102");
  try {
    await login(page, "trainee05");
    // Сокет остаётся открытым, а отправка действий отказывает, как при пропавшей сети.
    let blocked = false;
    await page.route("**/api/cards/*/events", (route) =>
      blocked && route.request().method() === "POST"
        ? route.abort("connectionfailed")
        : route.continue(),
    );
    const { card, view } = await openLine(page, current.id);
    // Строка обрыва связи — во всех режимах: это состояние связи, а не подсказка.
    const line = page.getByRole("status", { name: "Связь с сервером" });
    await expect(line).toHaveCount(0);

    blocked = true;
    const number = view.getByLabel("Номер наряда", { exact: true });
    await number.fill("Н-77");
    await number.blur();
    await view
      .getByLabel("Комментарий", { exact: true })
      .fill("Принята, направлен наряд");
    await view
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();

    await expect(line).toContainText("Работа не потеряна", { timeout: 15_000 });
    await expect(line).toContainText(/переподключ/);
    // Пока связи нет, на сервер не ушло ни номера, ни статуса.
    expect(
      (await events(page, card.id)).filter((item) =>
        ["field_change", "status_change"].includes(item.type),
      ),
    ).toEqual([]);
    // «Повторить сейчас» при живом отказе строку не убирает.
    await line.getByRole("button", { name: "Повторить сейчас" }).click();
    await expect(line).toContainText("Работа не потеряна");
    await page.waitForTimeout(2500);

    blocked = false;
    await line.getByRole("button", { name: "Повторить сейчас" }).click();
    await expect(line).toHaveCount(0, { timeout: 15_000 });
    await expect(view.getByText(/^\d\d:\d\d Принята$/)).toBeVisible();
    const sent = (await events(page, card.id)).filter((item) =>
      ["field_change", "status_change"].includes(item.type),
    );
    // По порядку и без повторов: сначала номер наряда, потом статус.
    expect(sent.map((item) => item.type)).toEqual([
      "field_change",
      "status_change",
    ]);
    expect(sent[0].payload).toMatchObject({
      field: "service_number",
      value: "Н-77",
    });
    expect(sent[1].payload).toMatchObject({ state: "accepted" });
  } finally {
    await current.finish();
  }
});
