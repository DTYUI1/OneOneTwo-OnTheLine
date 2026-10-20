import { expect, type APIRequestContext } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { test, login } from "./captain-fixture";
import { briefBrigade } from "./brigade-briefing";
import {
  REPORT_STEPS,
  registrationNumber,
  reportByParts,
} from "./report-parts";
import {
  answer,
  callHead,
  expectEnded,
  expectTalking,
  openDial,
  openPhone,
} from "./phone";
import { confirmAgain } from "./trainer";

type Card = components["schemas"]["Card"];
type Scenario = components["schemas"]["Scenario"];
type Session = components["schemas"]["Session"];
type User = components["schemas"]["User"];

// Доклад службе без микрофона (29.09, по частям с GP-06): дежурный службы представляется —
// дальше шаги доклада из карточки. Неверная часть — служба уточняет её, полный — дежурный
// принимает и называет номер регистрации (TC-03, персонаж банка OFFICIAL_102).
// Микрофон не запрашивается: шпион на getUserMedia считает вызовы, разрешение
// контексту не выдаётся.
test("Общий номер 102: доклад по частям, микрофон не запрашивается", async ({
  page,
  lesson,
}) => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен стенд с базой данных");
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const spy = window as Window & { micRequests?: number };
    spy.micRequests = 0;
    const devices = navigator.mediaDevices;
    if (!devices) return;
    devices.getUserMedia = async () => {
      spy.micRequests = (spy.micRequests ?? 0) + 1;
      throw new DOMException("Микрофон не нужен", "NotAllowedError");
    };
  });
  await login(page, "trainee05");
  await page.locator(`[data-card-id="${lesson.card.id}"]`).click();

  // Телефон ДДС (GP-09): своей службы в контактах нет — 102 набирается вручную.
  const talk = await openPhone(page);
  await (await openDial(talk)).fill("102");
  await talk.getByRole("button", { name: "Позвонить", exact: true }).click();
  await expectTalking(talk);

  // DT-05: голос — основной путь, части свёрнуты за «По частям».
  await expect(
    answer(talk).getByRole("button", { name: "Говорить", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  // TC-03: дежурный 102 — постоянный персонаж банка, представляется (фамилия или должность).
  await expect(talk.getByText(/Медведев|дежурн/i).first()).toBeVisible();

  // GP-06: доклад по частям. Ошибка в адресе («Бубнинская, 124») — адрес не прозвучал:
  // служба переспрашивает ровно его одной фразой банка, разговор продолжается.
  await reportByParts(talk, REPORT_STEPS, ["Адрес"]);
  const ask = "Повторите адрес полностью.";
  await expect(talk.getByText(ask)).toBeVisible();
  await expect(callHead(talk)).toHaveAttribute("data-call-state", "talking");
  // TC-03: «Повторите» — дежурный повторяет свою последнюю реплику дословно.
  await answer(talk)
    .getByRole("button", { name: "Повторите", exact: true })
    .click();
  await expect(talk.getByText(ask)).toHaveCount(2);

  // Второй круг — только адрес и что случилось; верно — служба принимает и кладёт трубку.
  await reportByParts(talk, ["Адрес", "Что случилось"]);
  await expectEnded(talk);
  // Итог звонка по памятке, с. 32 — как в макете B: все три части звонка службе прозвучали
  // (карточка обязательна только в звонке в 112).
  await expect(talk.getByText("Что прозвучало: 3 из 3")).toBeVisible();
  // Улица карточки (Дубнинская) похожа на Дубининскую — дежурный просил её по буквам.
  await expect(talk.getByText("Улицу по буквам повторите.")).toBeVisible();
  await expect(talk.getByText(/номер/i).last()).toBeVisible();
  await expect(talk.getByText(/Абонент положил трубку/)).toBeVisible();
  // Номер регистрации ушёл в отбой — его сверяют с комментарием карточки.
  expect(await registrationNumber(page.request, lesson.card.id)).toMatch(
    /^\d+$/,
  );

  // В отбой ушли круги доклада: первый — без адреса, это ошибка части в разборе; части —
  // за звонок (прозвучавшее раньше не теряется).
  await expect
    .poll(async () => {
      const events = (await (
        await page.request.get(`/api/cards/${lesson.card.id}/events`)
      ).json()) as {
        type: string;
        payload: { report_choices?: string[]; report_parts?: string[][] };
      }[];
      const hangup = events.find((event) => event.type === "call_hangup");
      return [hangup?.payload.report_choices, hangup?.payload.report_parts];
    })
    .toEqual([
      ["no_address", "full"],
      [
        // Карточку памятка требует только в звонке в 112 (report-parts.ts).
        ["who", "change"],
        ["who", "address", "change"],
      ],
    ]);
  expect(
    await page.evaluate(
      () => (window as Window & { micRequests?: number }).micRequests,
    ),
  ).toBe(0);
  await talk.getByRole("button", { name: "Закрыть", exact: true }).click();

  const card = page.getByRole("region", {
    name: `Происшествие ${lesson.card.source.number}`,
    exact: true,
  });
  async function status(state: string) {
    await card.getByRole("button", { name: "Изменить статус" }).click();
    await card.getByLabel("Статус", { exact: true }).selectOption(state);
    await card
      .getByLabel("Комментарий", { exact: true })
      .fill("Проверка статуса");
    await card.getByRole("button", { name: "Подтвердить" }).click();
  }
  await status("accepted");
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/cards/${lesson.card.id}`)).json())
          .state,
    )
    .toBe("accepted");
  await status("completed");
  // Необратимый статус — вторым ✓: у ✓ подпись «Нажмите ✓ или Enter ещё раз» (17.10).
  await expect(confirmAgain(page)).toBeVisible();
  expect(
    (await (await page.request.get(`/api/cards/${lesson.card.id}`)).json())
      .state,
  ).toBe("accepted");
  await card.getByRole("button", { name: "Подтвердить" }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/cards/${lesson.card.id}`)).json())
          .state,
    )
    .toBe("completed");
});

// GP-06: вводная бригаде по частям. Похожая ошибка в адресе засчитывается ошибкой: бригада
// едет туда, что услышала (в разборе — критерий address). Повтор «Повторяю: …» звучит только
// записью банка (проверка 17.10): адреса учебной карточки в записях нет — бригада молчит,
// ошибка видна на прибытии.
test("Вводная по частям: ошибка в адресе — бригада едет туда, что услышала", async ({
  page,
  lesson,
}) => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен стенд с базой данных");
  test.setTimeout(90_000);
  await login(page, "trainee05");
  await page.locator(`[data-card-id="${lesson.card.id}"]`).click();
  const card = page.getByRole("region", {
    name: `Происшествие ${lesson.card.source.number}`,
    exact: true,
  });
  await card.getByRole("button", { name: "Изменить статус" }).click();
  await card.getByLabel("Статус", { exact: true }).selectOption("accepted");
  await card.getByLabel("Комментарий", { exact: true }).fill("Принята");
  await card.getByRole("button", { name: "Подтвердить" }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/cards/${lesson.card.id}`)).json())
          .state,
    )
    .toBe("accepted");

  const checked = page.waitForResponse((response) =>
    response.url().includes("/briefing-check"),
  );
  const line = await briefBrigade(page, undefined, ["Адрес"]);
  const check = (await (await checked).json()) as {
    address: string;
    heard_address: string;
    complete: boolean;
    readback: string | null;
  };
  expect(check).toMatchObject({
    address: "wrong",
    complete: true,
    readback: null,
  });
  expect(check.heard_address).not.toBe("");
  await expect(line.getByText(/^Повторяю:/)).toHaveCount(0);
});

// Повтор адреса записью банка (проверка 17.10): у банковских сценариев data/scenarios адрес
// карточки и похожие ошибки вариантов по частям записаны («Повторяю: …», набор bank-v6).
// Без ловушки бригада повторяет верный адрес; с ловушкой повтора (readback_error) верный
// адрес повторяет сама ловушка, а ошибку диспетчера бригада повторяет как услышала.
// Верная вводная в сценарии с ловушкой — повтора записью нет: адрес (с ошибкой) говорит
// сама ловушка в докладе о выезде, строк «Повторяю: …» в разговоре ноль.
for (const { code, number, wrong, repeats } of [
  { code: "fight-street-102-1", number: "70005701", wrong: [], repeats: true },
  {
    code: "fight-street-102-2",
    number: "70005702",
    wrong: ["Адрес"],
    repeats: true,
  },
  { code: "fight-street-102-2", number: "70005702", wrong: [], repeats: false },
] as { code: string; number: string; wrong: string[]; repeats: boolean }[]) {
  const title = repeats
    ? `Банковский сценарий ${code}: бригада повторяет адрес записью банка${wrong.length ? " (ошибка в адресе)" : ""}`
    : `Банковский сценарий ${code}: верная вводная — повтор говорит ловушка, не запись`;
  test(title, async ({ page, request }) => {
    test.skip(process.env.E2E_DATABASE !== "1", "Нужен стенд с базой данных");
    test.setTimeout(120_000);
    const lesson = await bankLesson(request, number);
    try {
      await login(page, "trainee05");
      await page.locator(`[data-card-id="${lesson.cardId}"]`).click();
      const card = page.getByRole("region", {
        name: `Происшествие ${number}`,
        exact: true,
      });
      await card.getByRole("button", { name: "Изменить статус" }).click();
      await card.getByLabel("Статус", { exact: true }).selectOption("accepted");
      await card.getByLabel("Комментарий", { exact: true }).fill("Принята");
      await card.getByRole("button", { name: "Подтвердить" }).click();
      await expect
        .poll(
          async () =>
            (
              await (
                await page.request.get(`/api/cards/${lesson.cardId}`)
              ).json()
            ).state,
        )
        .toBe("accepted");

      const checked = page.waitForResponse((response) =>
        response.url().includes("/briefing-check"),
      );
      const line = await briefBrigade(page, undefined, wrong);
      const check = (await (await checked).json()) as {
        address: string;
        heard_address: string;
        complete: boolean;
        readback: string | null;
      };
      if (!repeats) {
        expect(check).toMatchObject({
          address: "ok",
          complete: true,
          readback: null,
        });
        // Ловушка звучит в докладе о выезде; до неё и вместе с ней — ни одного «Повторяю:».
        await expect(
          page.getByText(/Диспетчер, как поняли\?/).first(),
        ).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText(/^Повторяю:/)).toHaveCount(0);
        return;
      }
      expect(check).toMatchObject({
        address: wrong.length ? "wrong" : "ok",
        complete: true,
        readback: `Повторяю: ${check.heard_address}.`,
      });
      // Строка бригады в ленте — тот самый повтор, без «Выезжаем».
      await expect(
        line.getByText(check.readback!, { exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(line.getByText(/^Повторяю:.*[Вв]ыезжаем/)).toHaveCount(0);
    } finally {
      await lesson.finish();
    }
  });
}

/** Занятие trainee05 (служба 102) с банковским сценарием по номеру карточки. */
async function bankLesson(request: APIRequestContext, number: string) {
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
  const scenario = (
    (await (await request.get("/api/scenarios")).json()) as Scenario[]
  )
    .filter((item) => item.status === "approved" && item.card.number === number)
    .sort((a, b) => b.version - a.version)[0];
  expect(scenario, `Нет сценария ${number}: выполните app.seed`).toBeTruthy();
  const users: User[] = await (await request.get("/api/users")).json();
  const trainee = users.find((user) => user.login === "trainee05")!;
  const created = await request.post("/api/sessions", {
    headers,
    data: {
      title: `Повтор адреса ${number} ${Date.now()}`,
      participants: [
        {
          user_id: trainee.id,
          workstation_number: 23,
          dds_service_id: "102",
          level: 4,
        },
      ],
      settings_snapshot: {
        ...(await (await request.get("/api/settings")).json()),
        parallel_cards: 1,
      },
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const session: Session = await created.json();
  const finish = async () => {
    await request.post(`/api/sessions/${session.id}/finish`, { headers });
  };
  try {
    const assigned = await request.post(
      `/api/sessions/${session.id}/assignments`,
      {
        headers,
        data: {
          participant_id: trainee.id,
          scenario_id: scenario.id,
          order: 1,
          planned_at: new Date().toISOString(),
        },
      },
    );
    expect(assigned.status(), await assigned.text()).toBe(201);
    expect(
      (
        await request.post(`/api/sessions/${session.id}/start`, { headers })
      ).ok(),
    ).toBeTruthy();
    let cardId = "";
    await expect
      .poll(
        async () => {
          const cards: Card[] = await (await request.get("/api/cards")).json();
          cardId =
            cards.find((item) => item.session_id === session.id)?.id ?? "";
          return cardId;
        },
        { timeout: 30_000 },
      )
      .not.toBe("");
    return { cardId, finish };
  } catch (error) {
    await finish();
    throw error;
  }
}
