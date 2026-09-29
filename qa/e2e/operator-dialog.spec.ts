import { expect, test } from "@playwright/test";
import {
  ask,
  calm,
  cardQuestions,
  lastLine,
  openCall,
  scenario,
  talk,
} from "./operator-call";

// OP-05: разговор с заявителем на экране оператора 112 (сценарий пожара). С этапа 2
// девушка звонит в истерике: сначала «Успокоить» — просьба с причиной, повторить подряд.
test.skip(process.env.E2E_DATABASE !== "1", "Нужен отдельный стенд с БД");

const ID = "fire_apartment_smoke";
const GIRL = scenario(ID);
const QUESTION = Object.fromEntries(
  cardQuestions(ID).map((question) => [question.key, question.text]),
);
// Этап 3: лишние вопросы — правдоподобные для своего шага, у каждого свой ответ заявителя.
const EXTRA = GIRL.distractors.filter((item) =>
  ["home_phone", "door_color"].includes(item.key),
);

test("после успокоения верные вопросы — спокойные ответы", async ({ page }) => {
  await openCall(page, ID);
  await calm(page);
  await calm(page);
  expect(await lastLine(page)).toBe(`Заявитель: ${GIRL.answers.address.calm}`);
  for (const key of ["what_happened", "victims", "access"]) {
    await ask(page, QUESTION[key]!);
    expect(await lastLine(page)).toBe(`Заявитель: ${GIRL.answers[key]!.calm}`);
  }
  // Паника цифрой не показывается — только тоном.
  await expect(talk(page).getByTitle("Тон голоса заявителя")).not.toContainText(
    /\d/,
  );
});

test("лишние вопросы возвращают истерику — вопросы снова не слышны", async ({
  page,
}) => {
  await openCall(page, ID);
  await calm(page);
  await calm(page);
  for (const item of EXTRA) {
    await ask(page, item.text);
    expect(await lastLine(page)).toBe(`Заявитель: ${item.reply}`);
  }
  await ask(page, QUESTION.floor!);
  expect(GIRL.reactions.hysteria).toContain(
    (await lastLine(page)).replace(/^Заявитель: /, ""),
  );
  await expect(talk(page)).toContainText("повторяйте её подряд");
});

for (const [button, note] of [
  ["срыв звонка", "Звонок сорвался, разговор окончен."],
  ["нет контакта", "Нет контакта с заявителем, разговор окончен."],
] as const) {
  test(`«${button}» заканчивает разговор`, async ({ page }) => {
    await openCall(page, ID);
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(talk(page).getByRole("listitem").last()).toHaveText(note);
    await expect(
      talk(page).getByRole("button", { name: QUESTION.address!, exact: true }),
    ).toBeDisabled();
  });
}
