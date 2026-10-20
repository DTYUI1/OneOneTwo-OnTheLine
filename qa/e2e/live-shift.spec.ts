import { expect, type APIRequestContext } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { test, login } from "./captain-fixture";
import { waitCard } from "./memo-lesson";

// Смена выглядит живой (TC-07): в реестре — отработанные карточки прошлой смены (по уровню
// участника), чужие службы на полосе служб сами меняют статусы, а карточку без статуса дольше
// срока сценария замечает отдел контроля: звонит, диспетчер поясняет по частям или голосом.
test.skip(
  process.env.E2E_DATABASE !== "1",
  "Нужен стенд с базой: E2E_DATABASE=1",
);

type Scenario = components["schemas"]["Scenario"];
type Session = components["schemas"]["Session"];
type User = components["schemas"]["User"];
type CardTraining = components["schemas"]["CardTraining"];

// «Задымление в квартире», 101: в карточке ещё 102, 103 и 104; отдел контроля — через 60 с.
const NUMBER = "70005101";
const TRAINEE = "trainee02";
const LEVEL = 3;
const BACKGROUND = 6;

async function lesson(request: APIRequestContext) {
  expect(
    (
      await request.post("/api/auth/login", {
        data: {
          login: "teacher",
          password: process.env.DEMO_PASSWORD ?? "demo-local",
        },
      })
    ).ok(),
  ).toBeTruthy();
  const headers = {
    "X-CSRF-Token": (await request.storageState()).cookies.find(
      (cookie) => cookie.name === "csrf",
    )!.value,
  };
  const scenarios: Scenario[] = await (
    await request.get("/api/scenarios")
  ).json();
  const scenario = scenarios.find(
    (item) => item.card.number === NUMBER && item.status === "approved",
  );
  expect(scenario, `Нет сценария ${NUMBER}`).toBeTruthy();
  const users: User[] = await (await request.get("/api/users")).json();
  const trainee = users.find((user) => user.login === TRAINEE)!;
  const settings = await (await request.get("/api/settings")).json();
  const created = await request.post("/api/sessions", {
    headers,
    data: {
      title: `Живая смена ${Date.now()}`,
      participants: [
        {
          user_id: trainee.id,
          workstation_number: 21,
          dds_service_id: "101",
          level: LEVEL,
        },
      ],
      settings_snapshot: { ...settings, hints_level: 1, parallel_cards: 1 },
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const session: Session = await created.json();
  const assigned = await request.post(
    `/api/sessions/${session.id}/assignments`,
    {
      headers,
      data: {
        participant_id: trainee.id,
        scenario_id: scenario!.id,
        order: 1,
        planned_at: new Date().toISOString(),
      },
    },
  );
  expect(assigned.status(), await assigned.text()).toBe(201);
  expect(
    (await request.post(`/api/sessions/${session.id}/start`, { headers })).ok(),
  ).toBeTruthy();
  return {
    id: session.id,
    finish: async () => {
      await request.post(`/api/sessions/${session.id}/finish`, { headers });
    },
  };
}

test("фон в реестре, чужие службы живут, отдел контроля звонит при просрочке", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const current = await lesson(request);
  try {
    await login(page, TRAINEE);
    const card = await waitCard(page, current.id);

    // Фон: карточки прошлой смены ниже карточки занятия — не открываются, «⌄» раскрывает.
    // Реестр по дате: карточки прошлых прогонов могут сдвинуть часть фона на 2-ю страницу,
    // поэтому считаем на самой длинной странице.
    const size = page.getByLabel("Записей на странице:");
    await size.selectOption({
      index: (await size.locator("option").count()) - 1,
    });
    const background = page.locator("[data-background-id]");
    await expect(background).toHaveCount(BACKGROUND);
    await expect(background.first()).toContainText(
      /Работы завершены|Отказ от выполнения работ|Не принята/,
    );
    await background.first().click();
    await expect(page).toHaveURL(/\/arm\/?$/);
    await expect(
      page.locator("tr", { hasText: "Службы:" }).first(),
    ).toBeVisible();

    // Карточка без статуса: открыли и ничего не ставим.
    await page.locator(`[data-card-id="${card.id}"]`).click();
    const view = page.getByRole("region", {
      name: `Происшествие ${card.source.number}`,
      exact: true,
    });
    await expect(view).toBeVisible();

    // Отдел контроля звонит только после срока сценария (60 с без статуса).
    const dial = page.getByRole("button", { name: "Телефон: входящих 1" });
    await expect(dial).toBeVisible({ timeout: 100_000 });
    // Вкладка звонящей линии «Отдел контроля» (вкладки линий 17.10): щелчок отвечает.
    const ring = page
      .getByRole("region", { name: "Телефон ДДС" })
      .locator('[role="tab"][data-line="ringing"]', {
        hasText: "Отдел контроля",
      });
    await dial.click();
    await expect(ring).toContainText(`по карточке ${card.source.number}`);

    // К этому времени чужие службы карточки уже приняли её сами (расписание мира).
    const tiles = view.locator("[data-service-state]");
    await expect(tiles).toHaveCount(3);
    for (const tile of await tiles.all()) {
      await expect(tile).toHaveAttribute(
        "data-service-state",
        /accepted|responding/,
      );
      await expect(tile).toContainText(/Принята|Начало реагирования/);
    }

    await ring.click();
    const talk = page.getByRole("region", {
      name: "Разговор с отделом контроля",
    });
    await expect(talk).toHaveAttribute("data-control-call", "talking");
    await expect(talk).toContainText(`по карточке ${card.source.number}`);
    await expect(talk).toContainText(
      "Почему карточка так долго без статуса? Поясните причину.",
    );
    await talk.getByRole("button", { name: "По частям" }).click();
    await talk
      .getByRole("group", { name: "Варианты пояснения" })
      .getByRole("button", {
        name: "Не успел обработать, статус ставлю сейчас",
      })
      .click();
    await expect(talk).toContainText("Принято. Отбой.");
    // Отдел контроля кладёт трубку сам; окно возвращается к карточке.
    await expect(talk).toBeHidden({ timeout: 10_000 });

    // Пояснение — в учебных сведениях карточки и в её журнале: оттуда его берёт разбор.
    await expect
      .poll(async () => {
        const training: CardTraining = await (
          await page.request.get(`/api/cards/${card.id}/training`)
        ).json();
        return training.control?.reply?.option_key ?? null;
      })
      .toBe("late");
    await expect(view.locator('[data-help="card-history"]')).toContainText(
      "пояснение отделу контроля: Не успел обработать, статус ставлю сейчас",
    );
    await expect(ring).toHaveCount(0);
  } finally {
    await current.finish();
  }
});
