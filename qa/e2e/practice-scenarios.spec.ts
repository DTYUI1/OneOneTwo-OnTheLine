import { expect, test, type Page } from "@playwright/test";
import { briefBrigade } from "./brigade-briefing";
import { freeBrigade, lineTab, openPhone } from "./phone";
import { csrf, startStep, training, unlockStep2 } from "./practice";
import { passWelcome } from "./practice-play";

// Сценарии самостоятельной тренировки (29.09): на ступени 2 выдаётся готовое происшествие
// (номер карточки 70005…), и бригада своей службы докладывает о выезде после статуса
// «Принята» и звонка — раньше на golden-сценарии бригада молчала.
const OWNER = "trainee02";
const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-local";

async function login(page: Page) {
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(OWNER);
  await page.getByLabel("Пароль").fill(PASSWORD);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  await passWelcome(page);
}

test("Ступень 2: готовое происшествие, бригада своей службы докладывает о выезде", async ({
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
  page.on("dialog", (dialog) => void dialog.accept());
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: "Параллельная работа" }),
    async (dialog) => {
      await dialog.getByRole("button", { name: "Понятно" }).click();
    },
  );
  await login(page);
  const request = page.request;
  await unlockStep2(request);

  const { session, card } = await startStep(request, 2);
  try {
    // Ступень 2 — готовое происшествие тренировки, а не golden без докладов.
    expect(card.source.number).toMatch(/^70005\d{3}$/);

    await page.goto(`/app/arm/cards/${encodeURIComponent(card.id)}`);
    const cardView = page.getByRole("region", {
      name: `Происшествие ${card.source.number}`,
      exact: true,
    });
    await expect(cardView.getByText(card.source.description)).toBeVisible();
    await cardView
      .getByRole("button", { name: "Изменить статус", exact: true })
      .click();
    await cardView
      .getByLabel("Статус", { exact: true })
      .selectOption("accepted");
    await cardView
      .getByLabel("Комментарий", { exact: true })
      .fill("Принята, направляю бригаду");
    await cardView
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();
    await expect
      .poll(async () => {
        const saved: Card = await (
          await request.get(`/api/cards/${card.id}`)
        ).json();
        return saved.state;
      })
      .toBe("accepted");
    await expect(cardView.getByText(/^\d{2}:\d{2} Принята$/)).toBeVisible();

    // Связь службы — окно телефона ДДС (GP-09): силы службы в контактах.
    // GP-05: звоним бригаде и даём вводную по частям — без неё она не выезжает.
    const win = await openPhone(page);
    const checked = page.waitForResponse((response) =>
      response.url().includes("/briefing-check"),
    );
    const line = await briefBrigade(page, freeBrigade(win));
    const { readback } = (await (await checked).json()) as {
      readback: string | null;
    };
    // В ленте — вводная диспетчера («Вы сказали: …») с улицей карточки.
    await expect(
      line
        .getByRole("listitem")
        .filter({ hasText: /^Вы сказали:/ })
        .filter({ hasText: card.source.address.street }),
    ).not.toHaveCount(0);
    // Повтор адреса бригадой — ровно тот, что вернул сервер: запись банка «Повторяю: …»
    // (проверка 17.10); у сценария с ловушкой повтора верный адрес бригада не повторяет —
    // строки нет. Всегда без «Выезжаем»: выезд говорит доклад о выезде (проверка ниже).
    // Повтор, который точно звучит, — service-reply.spec.ts, банковские сценарии.
    await expect(line.getByText(/^Повторяю:/)).toHaveCount(readback ? 1 : 0);
    if (readback)
      await expect(line.getByText(readback, { exact: true })).toBeVisible();
    await expect(line.getByText(/^Повторяю:.*[Вв]ыезжаем/)).toHaveCount(0);

    // Доклад о выезде — сразу после вводной, в том же разговоре. Положили трубку
    // раньше, чем он прозвучал, — бригада перезванивает сама (DT-20): отвечаем.
    const rings = lineTab(
      page.getByRole("region", { name: "Телефон ДДС" }),
      "ringing",
    );
    await expect
      .poll(
        async () => {
          const now = await training(request, card.id);
          if (now.messages.length === 0 && (now.incoming ?? []).length > 0)
            await rings
              .first()
              .click({ timeout: 3_000 })
              .catch(() => undefined);
          return now.messages.length;
        },
        { timeout: 45_000 },
      )
      .toBeGreaterThan(0);
    const [report] = (await training(request, card.id)).messages;
    // Доклад о выезде — фраза банка своей службы: слова разные («выехали», «выдвигаемся», «едем»).
    expect(report.delivery.message.text).toMatch(
      /выех|выезжа|направлен|выдвига|едем|в пути/i,
    );
    expect(report.delivery.message.audio).not.toBeNull();
    // Дальше бригада ждёт «Начало реагирования». DT-10 может добавить вопрос по
    // адресу уже после первого доклада: он не означает переход к следующему статусу.
    await page.waitForTimeout(8_000);
    const after = await training(request, card.id);
    expect(
      (await (await request.get(`/api/cards/${card.id}`)).json()).state,
    ).toBe("accepted");
    expect(after.missing_report_states).toEqual(
      expect.arrayContaining(["arrived", "working", "completed"]),
    );
  } finally {
    expect(
      (
        await request.post(`/api/sessions/${session.id}/finish`, {
          headers: { "X-CSRF-Token": await csrf(request) },
        })
      ).ok(),
    ).toBeTruthy();
  }
});
