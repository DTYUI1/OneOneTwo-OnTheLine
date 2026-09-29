import { expect, test } from "@playwright/test";
import {
  SCENARIOS,
  advise,
  ask,
  hold,
  calm,
  cardQuestions,
  idle,
  lastLine,
  openCall,
  question,
  scenario,
  talk,
} from "./operator-call";
import { login } from "./captain-fixture";

// Этап 2 плана docs/operator_112_review/PLAN.md: живой звонок — «Принять вызов», голос и
// фон, истерика и «Успокоить» (IAED), пауза оператора, ухудшение и совет, 4 персонажа.
test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");
test.use({ viewport: { width: 1536, height: 864 } });

test("голос и фон звучат только после «Принять вызов»", async ({ page }) => {
  const voices: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(".ogg")) voices.push(request.url());
  });
  await login(page, "teacher");
  await page.goto("/app/operator?scenario=fire_apartment_smoke");
  const incoming = page.getByRole("dialog", { name: "Входящий вызов 112" });
  await expect(incoming).toContainText("+7 (916) 123-45-67");
  expect(voices).toEqual([]);
  const opening = page.waitForRequest(/opening[^/]*\.ogg/);
  const background = page.waitForRequest(/stairwell_alarm[^/]*\.ogg/);
  await incoming.getByRole("button", { name: "Принять вызов" }).click();
  await Promise.all([opening, background]);
  await expect(talk(page).getByRole("listitem").first()).toHaveText(
    `Заявитель: ${scenario("fire_apartment_smoke").opening}`,
  );
  // Тон — словами, без цифры.
  await expect(talk(page).getByTitle("Тон голоса заявителя")).toHaveText(
    "кричит, не слышит вопросов",
  );
});

test("в истерике вопрос не слышен; «Успокоить» подряд — адрес", async ({
  page,
}) => {
  const girl = scenario("fire_apartment_smoke");
  const address = cardQuestions("fire_apartment_smoke")[0]!.text;
  await openCall(page, "fire_apartment_smoke");
  await expect(talk(page)).toContainText("повторяйте её подряд");

  await ask(page, address);
  expect(girl.reactions.hysteria).toContain(
    (await lastLine(page)).replace(/^Заявитель: /, ""),
  );
  // Не услышанный вопрос не становится «заданным» (замечание капитана 29.09).
  const button = talk(page).getByRole("button", { name: address, exact: true });
  await expect(button).not.toHaveAccessibleDescription("Вопрос уже задан");

  await calm(page, "order");
  expect(await lastLine(page)).toContain("Как я могу успокоиться");
  await calm(page);
  await expect(talk(page)).toContainText("Паника ещё высокая");
  await calm(page);
  expect(await lastLine(page)).toBe(`Заявитель: ${girl.answers.address.calm}`);
  await expect(button).toHaveAccessibleDescription("Вопрос уже задан");
  await expect(talk(page).getByTitle("Тон голоса заявителя")).toHaveText(
    "волнуется",
  );
});

test("пауза оператора — «Алло?», «Слышу, записываю» держит контакт", async ({
  page,
}) => {
  await openCall(page, "dtp_victims_fuel");
  const lines = talk(page).getByRole("listitem");
  await talk(page).getByRole("button", { name: "Слышу, записываю" }).click();
  await expect(lines).toHaveCount(3);
  expect(await lastLine(page)).toBe("Заявитель: Да, я на связи.");
  await idle(page);
  await page.clock.install();
  const tone = talk(page).getByTitle("Тон голоса заявителя");
  await expect(tone).toHaveText("волнуется");
  await page.clock.runFor(17_000);
  await expect(lines).toHaveCount(3);
  await page.clock.runFor(1_000);
  await expect(lines).toHaveCount(4);
  expect(await lastLine(page)).toBe("Заявитель: Алло? Вы меня слышите?");
  await expect(tone).toHaveText("волнуется");
  await idle(page);
  await page.clock.runFor(18_000);
  await expect(lines).toHaveCount(5);
  await expect(tone).toHaveText("паникует, путается");
  await idle(page);
  await hold(page);
  await page.clock.runFor(18_000);
  await expect(lines).toHaveCount(8);
  await expect(tone).toHaveText("паникует, путается");
});

test("ситуация ухудшается по сценарию, нужный совет её закрывает", async ({
  page,
}) => {
  await page.clock.install();
  const child = scenario("elevator_stuck");
  await openCall(page, "elevator_stuck");
  await calm(page);
  expect(await lastLine(page)).toBe(`Заявитель: ${child.answers.address.calm}`);
  const floor = cardQuestions("elevator_stuck").find(
    (question) => question.key === "floor",
  )!;
  await ask(page, floor.text);
  // Время звонка — под управлением теста: ухудшение не раньше 45-й секунды. Пока ждём,
  // держим контакт, как оператор: иначе паузы доведут заявителя до истерики.
  const escalated = async () =>
    (await talk(page).innerText()).includes("Свет погас");
  for (let step = 0; step < 7 && !(await escalated()); step++) {
    await page.clock.runFor(9_000);
    if (!(await escalated())) await hold(page);
  }
  await expect(talk(page)).toContainText("Ой! Свет погас! Тут совсем темно!");
  await expect(talk(page)).toContainText("Ситуация ухудшилась");
  await idle(page);
  await advise(page, /^«Не пытайся открыть двери/);
  expect(await lastLine(page)).toBe(
    "Заявитель: Хорошо... я сел... не отключайтесь.",
  );
  await expect(talk(page)).not.toContainText("Ситуация ухудшилась");
});

for (const id of SCENARIOS)
  test(`персонаж ${id}: успокоить и расспросить спокойно`, async ({ page }) => {
    const data = scenario(id);
    await openCall(page, id);
    // Просьба с причиной подряд — ниже порога паники (у девушки дважды).
    for (let step = data.start_panic; step >= 2; step--) await calm(page);
    for (const item of cardQuestions(id)) {
      // Этап 3: вопрос — на вкладке своего шага; адрес после «Успокоить» уже задан.
      const button = await question(page, item.text);
      if (await button.getAttribute("aria-describedby")) continue;
      await ask(page, item.text);
      expect(await lastLine(page)).toBe(
        `Заявитель: ${data.answers[item.key]!.calm}`,
      );
    }
    await expect(talk(page).getByTitle("Тон голоса заявителя")).toHaveText(
      /говорит спокойно|волнуется/,
    );
  });
