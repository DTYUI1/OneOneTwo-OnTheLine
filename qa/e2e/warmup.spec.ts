import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { TRAINEE_BEGIN } from "./operator-module";

type Service = components["schemas"]["Service"];
type WarmupResult = components["schemas"]["WarmupResult"];

// DT-09: «Разминка» — два упражнения на один навык; результат сохраняется на сервере,
// ошибки прошлой попытки идут первыми.
const OWNER = "trainee01";
const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-local";

interface Incident {
  key: string;
  card: { description: string; service_ids: string[] };
}
const incidents: Incident[] = readdirSync(join(process.cwd(), "data/practice"))
  .filter((name) => name.endsWith(".json"))
  .map((name) =>
    JSON.parse(
      readFileSync(join(process.cwd(), "data/practice", name), "utf8"),
    ),
  );

test("Разминка: адреса и «Кого направить», результат на сервере", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL и API с миграцией 0017 (E2E_DATABASE=1)",
  );
  test.skip(
    testInfo.project.name !== "chromium",
    "Одна учётка обучаемого: браузеры не делят результаты",
  );
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: "Параллельная работа" }),
    async (dialog) => {
      await dialog.getByRole("button", { name: "Понятно" }).click();
    },
  );
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(OWNER);
  await page.getByLabel("Пароль").fill(PASSWORD);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  await page.getByRole("button", { name: TRAINEE_BEGIN }).click();
  const services: Service[] = await (
    await page.request.get("/api/services")
  ).json();
  const name = (id: string) => services.find((item) => item.id === id)!.name;
  const results = async (): Promise<WarmupResult[]> =>
    (await page.request.get("/api/warmups")).json();
  const before = (await results()).length;

  await page.getByRole("button", { name: "Разминка", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Разминка" });

  // 1. «Найди отличие в адресе»: отвечаем верно, сравнивая записи.
  await dialog
    .getByRole("region", { name: "Найди отличие в адресе" })
    .getByRole("button", { name: "Начать" })
    .click();
  const drill = dialog.getByRole("region", { name: "Найди отличие в адресе" });
  for (let i = 0; i < 10; i++) {
    await expect(drill.getByText(`${i + 1} из 10`)).toBeVisible();
    const [a, b] = await drill
      .locator("p")
      .filter({ hasNotText: " из 10" })
      .allTextContents();
    await drill
      .getByRole("button", { name: a === b ? /Одинаковые/ : /Разные/ })
      .click();
  }
  await expect(dialog.getByRole("status").first()).toHaveText(/10 из 10 за/);
  await expect(dialog.getByText("Результат сохранён.")).toBeVisible();
  await dialog.getByRole("button", { name: "К разминке" }).click();

  // 2. «Кого направить»: первое задание — нарочно неверно, остальные — по карточке.
  await dialog
    .getByRole("region", { name: "Кого направить" })
    .getByRole("button", { name: "Начать" })
    .click();
  const routing = dialog.getByRole("region", { name: "Кого направить" });
  let missedKey = "";
  let missedText = "";
  for (let i = 0; i < incidents.length; i++) {
    await expect(
      routing.getByText(`${i + 1} из ${incidents.length}`),
    ).toBeVisible();
    const text = await routing.locator("p").nth(1).textContent();
    const incident = incidents.find((item) => item.card.description === text)!;
    const group = routing.getByRole("group", { name: "Службы" });
    if (i === 0) {
      missedKey = incident.key;
      // Ошибка в итоге — словами (bdf51685): первая фраза задания и «Нужно: службы».
      const lead =
        incident.card.description.match(/^.+?[.!?](?=\s|$)/)?.[0] ??
        incident.card.description;
      missedText = `${lead} Нужно: ${incident.card.service_ids.map(name).join(", ")}.`;
      const wrong = services.find(
        (item) =>
          !incident.card.service_ids.includes(item.id) &&
          incidents.some((one) => one.card.service_ids.includes(item.id)),
      )!;
      await group
        .getByRole("button", { name: wrong.name, exact: true })
        .click();
    } else
      for (const id of incident.card.service_ids)
        await group
          .getByRole("button", { name: name(id), exact: true })
          .click();
    await routing.getByRole("button", { name: "Проверить" }).click();
    await routing.getByRole("button", { name: /Дальше|Итог/ }).click();
  }
  await expect(dialog.getByRole("status").first()).toHaveText(
    new RegExp(`${incidents.length - 1} из ${incidents.length} за`),
  );
  await expect(dialog.getByText("Результат сохранён.")).toBeVisible();
  await expect(
    dialog.getByRole("listitem").filter({ hasText: missedText }),
  ).toBeVisible();

  // На сервере — оба результата; ошибка записана для возврата.
  const saved = await results();
  expect(saved.length).toBe(before + 2);
  const [routingResult, addressResult] = saved;
  expect(routingResult).toMatchObject({
    kind: "routing",
    correct: incidents.length - 1,
    total: incidents.length,
  });
  expect(routingResult.mistakes[0]).toMatch(new RegExp(`^${missedKey}:`));
  expect(addressResult).toMatchObject({
    kind: "address",
    correct: 10,
    total: 10,
  });

  // «Ещё раз» — задание с ошибкой идёт первым.
  await dialog.getByRole("button", { name: "Ещё раз" }).click();
  const first = incidents.find((item) => item.key === missedKey)!;
  await expect(routing.locator("p").nth(1)).toHaveText(first.card.description);
});
