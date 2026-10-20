import { expect, test } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { csrf, signIn } from "./practice-play";

type JobProgress = components["schemas"]["JobProgress"];

// GP-14: сценарии готовит ИИ, преподаватель их видит и утверждает или отклоняет.
test("Студия: сгенерированные сценарии — «Утвердить» и «Отклонить»", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужны PostgreSQL, worker, app.seed.training и явное E2E_DATABASE=1",
  );
  test.skip(
    testInfo.project.name !== "chromium",
    "Одна учётка преподавателя: браузеры не делят пакеты",
  );
  test.setTimeout(120_000);
  await signIn(page, "teacher");
  const seed = Math.floor(Math.random() * 1_000_000);
  const started = await page.request.post("/api/packs/generate", {
    headers: { "X-CSRF-Token": await csrf(page.request) },
    data: { service_id: "101", level: 3, count: 2, seed },
  });
  expect(started.ok(), await started.text()).toBeTruthy();
  const job = await started.json();
  let progress: JobProgress | undefined;
  await expect
    .poll(
      async () => {
        progress = await (
          await page.request.get(`/api/jobs/${job.id}/progress`)
        ).json();
        return progress?.job.status;
      },
      { timeout: 60_000 },
    )
    .toBe("done");
  expect(progress!.scenario_ids).toHaveLength(2);

  await page.getByRole("button", { name: /Студия сценариев/ }).click();
  await page.getByRole("tab", { name: /пакеты/ }).click();
  await page
    .getByRole("button", { name: `Сгенерированный пакет (seed ${seed})` })
    .first()
    .click();
  const rows = page.getByRole("row").filter({ hasText: "черновик" });
  await expect(rows).toHaveCount(2);
  // Сценарий готов к утверждению: эталон и план полные, как у файлов каталога.
  await expect(rows.first()).toContainText("готов");

  await rows.first().getByRole("checkbox").check();
  await page.getByRole("button", { name: "Утвердить отмеченные (1)" }).click();
  await expect(page.getByText("утверждён, версия")).toBeVisible();

  const draft = page.getByRole("row").filter({ hasText: "черновик" });
  await expect(draft).toHaveCount(1);
  await draft.getByRole("button", { name: "Отклонить" }).click();
  await expect(page.getByText("отклонён, больше не выдаётся")).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "черновик" }),
  ).toHaveCount(0);
});
