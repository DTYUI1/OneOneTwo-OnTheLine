import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { login } from "./captain-fixture";

type PracticeScenario = components["schemas"]["PracticeScenario"];
type Scenario = components["schemas"]["Scenario"];
type Session = components["schemas"]["Session"];
type User = components["schemas"]["User"];
type TrainingSettings = components["schemas"]["Settings"];
type AssignmentBatch = components["schemas"]["AssignmentBatch"];

const TRAIN_LABELS: Readonly<Record<string, string>> = {
  readback_error: "ловушка повтора адреса",
  clarify: "уточнение",
  request_service: "просьба вызвать службу",
  silence: "молчание бригады",
  alarm: "тревога",
};

test("Общий каталог: одинаковый ассортимент, специфика и выдача лифта с заявителем", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    process.env.E2E_DATABASE !== "1",
    "Нужен настоящий PostgreSQL и seed.training",
  );
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const traineeContext = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    ignoreHTTPSErrors: true,
  });
  let sessionId = "";
  let headers: Record<string, string> = {};
  try {
    const traineePage = await traineeContext.newPage();
    await login(traineePage, "trainee04");
    const traineeResponse = await traineePage.request.get(
      "/api/practice/catalog",
    );
    expect(traineeResponse.status()).toBe(200);
    const catalog: PracticeScenario[] = await traineeResponse.json();
    expect(catalog.length).toBeGreaterThan(0);
    await traineePage
      .getByRole("button", { name: "Каталог сценариев", exact: true })
      .click();
    const dialog = traineePage.getByRole("dialog", {
      name: "Каталог сценариев",
    });
    await expect(dialog.getByRole("listitem")).toHaveCount(catalog.length);
    const traineeTitles = await dialog.locator("li strong").allTextContents();
    expect(traineeTitles.sort()).toEqual(
      catalog.map((item) => item.title).sort(),
    );

    await login(page, "teacher");
    headers = {
      "X-CSRF-Token": (await page.context().cookies()).find(
        (cookie) => cookie.name === "csrf",
      )!.value,
    };
    const teacherResponse = await page.request.get("/api/practice/catalog");
    expect(teacherResponse.status()).toBe(200);
    expect(await teacherResponse.json()).toEqual(catalog);
    const scenarioResponse = await page.request.get("/api/scenarios");
    expect(scenarioResponse.status()).toBe(200);
    const scenarios: Scenario[] = await scenarioResponse.json();
    const byId = new Map(scenarios.map((item) => [item.id, item]));
    const lift = catalog.find(
      (item) => item.title === "Застрявший лифт: уточнить подъезд и кабину",
    )!;
    expect(lift).toBeDefined();
    expect(lift.version).toBe(2);
    expect(byId.get(lift.id)?.card.number).toBe("70008602");
    const users: User[] = await (await page.request.get("/api/users")).json();
    const trainee = users.find((item) => item.login === "trainee03")!;
    const settings: TrainingSettings = await (
      await page.request.get("/api/settings")
    ).json();
    const title = `Общий каталог ${testInfo.project.name} ${randomUUID()}`;
    const create = await page.request.post("/api/sessions", {
      headers,
      data: {
        title,
        participants: [
          {
            user_id: trainee.id,
            workstation_number: 1,
            dds_service_id: lift.service_id,
            level: lift.level,
          },
        ],
        settings_snapshot: {
          ...settings,
          phone_contacts: {
            ...settings.phone_contacts,
            [lift.service_id]: [
              { role: "caller", name: "Заявитель", number: "405" },
            ],
          },
        },
      },
    });
    expect(create.status()).toBe(201);
    const session: Session = await create.json();
    sessionId = session.id;
    await page.reload();
    const drafts = page.getByRole("button", { name: /^Черновики · / });
    if ((await drafts.getAttribute("aria-expanded")) !== "true")
      await drafts.click();
    await page.getByRole("button", { name: title, exact: false }).click();
    const detail = page.locator('section[aria-labelledby="session-title"]');
    const select = detail.getByRole("combobox", {
      name: "Добавить задание",
      exact: true,
    });
    await expect(select).toBeEnabled();
    await select.click();
    const options = page.getByRole("listbox", { name: "Сценарии для добавления" }).getByRole("option");
    await expect(options).toHaveCount(catalog.length);
    const actual = await options.evaluateAll((items) =>
      items.map((item) => ({
        id: (item as HTMLButtonElement).value,
        text: item.textContent ?? "",
      })),
    );
    expect(actual.map((item) => item.id).sort()).toEqual(
      catalog.map((item) => item.id).sort(),
    );
    for (const item of catalog) {
      const label = actual
        .find((option) => option.id === item.id)!
        .text.toLocaleLowerCase("ru-RU");
      expect(label).toContain(item.title.toLocaleLowerCase("ru-RU"));
      for (const kind of item.trains) {
        if (TRAIN_LABELS[kind]) expect(label).toContain(TRAIN_LABELS[kind]);
      }
      const expected = byId.get(item.id)?.reference.expected_call;
      if (expected?.required && expected.contact_role === "caller")
        expect(label).toContain("звонок заявителю");
    }
    await options.filter({ hasText: lift.title }).click();
    const selected = detail.locator("tbody tr").filter({ hasText: lift.title });
    await expect(selected).toHaveCount(1);
    await expect(selected).toContainText(/звонок заявителю/i);
    await page.screenshot({
      path: testInfo.outputPath("teacher-lift-catalog.png"),
      fullPage: true,
    });
    const posted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/sessions/${sessionId}/assignments/batch`),
    );
    await detail
      .getByRole("button", { name: /^Выдать задания \(1\)$/ })
      .click();
    const issued = await posted;
    expect(issued.status()).toBe(201);
    const batch: AssignmentBatch = await issued.json();
    expect(batch.assignments).toHaveLength(1);
    expect(batch.assignments[0].scenario_id).toBe(lift.id);
    const saved = await page.request.get(
      `/api/sessions/${sessionId}/assignment-batches`,
    );
    expect(saved.status()).toBe(200);
    const batches: AssignmentBatch[] = await saved.json();
    expect(
      batches.some(
        (item) =>
          item.request_id === batch.request_id &&
          item.assignments.some(
            (assignment) =>
              assignment.id === batch.assignments[0].id &&
              assignment.scenario_id === lift.id,
          ),
      ),
    ).toBe(true);
    await expect(detail.getByText(/^Выдано заданий: 1\./)).toBeVisible();
  } finally {
    try {
      if (sessionId) {
        const finished = await page.request.post(
          `/api/sessions/${sessionId}/finish`,
          { headers, data: { contract_version: 2, request_id: randomUUID() } },
        );
        expect(finished.ok()).toBe(true);
        const saved = await page.request.get(`/api/sessions/${sessionId}`);
        expect((await saved.json()).status).toBe("finished");
      }
    } finally {
      await traineeContext.close();
    }
  }
});
