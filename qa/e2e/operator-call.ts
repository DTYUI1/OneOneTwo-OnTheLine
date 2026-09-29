import { expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { login } from "./captain-fixture";

// Общие шаги звонка «Оператор 112» для e2e модуля (этап 2: вызов принимают кнопкой;
// этап 3: вопросы — по вкладкам шагов опроса, повтор адреса, «Сложно», проводник).

export const SCENARIOS = [
  "fire_apartment_smoke",
  "dtp_victims_fuel",
  "heart_attack_home",
  "elevator_stuck",
] as const;

interface Scenario {
  readonly opening: string;
  readonly questionnaire_id: string;
  readonly start_panic: number;
  readonly persona: { readonly label: string };
  readonly caller: { readonly phone: string };
  readonly answers: Record<string, { calm: string; panic: string }>;
  readonly address_confirmation: Record<string, string>;
  readonly distractors: {
    key: string;
    step: number;
    text: string;
    reply: string;
  }[];
  readonly reference_order: string[];
  readonly reactions: { hysteria: string[] };
}

const DATA = join(process.cwd(), "data/operator");
/** Повтор адреса: текст кнопки — адрес из карточки, его ищут по началу. */
export const CONFIRM_KEY = "confirm_address";
export const READBACK = /^(Проверю адрес: |Повторите, пожалуйста, адрес\.)/;

export function scenario(id: string): Scenario {
  return JSON.parse(
    readFileSync(join(DATA, "scenarios", `${id}.json`), "utf8"),
  ) as Scenario;
}

/**
 * Вопросы опросной карты сценария — тексты кнопок в разговоре, по шагам. Повтор адреса
 * здесь не участвует: его текст — адрес из карточки (`confirmAddress`).
 */
export function cardQuestions(
  id: string,
): { key: string; text: string; step: number }[] {
  const card = JSON.parse(
    readFileSync(
      join(DATA, "questionnaires", `${scenario(id).questionnaire_id}.json`),
      "utf8",
    ),
  ) as { questions: { key: string; text: string; step: number }[] };
  return card.questions.filter((question) => question.key !== CONFIRM_KEY);
}

export function talk(page: Page): Locator {
  return page.getByRole("region", { name: "Разговор с заявителем" });
}

export function questions(page: Page): Locator {
  return talk(page).getByRole("group", { name: "Вопросы заявителю" });
}

/** Освободить карточку после приёма: пользователь переносит отдельное окно за заголовок. */
export async function moveTalkAside(
  page: Page,
  side: "left" | "right" = "left",
) {
  const panel = (await talk(page).boundingBox())!;
  const head = (await talk(page).getByRole("heading").boundingBox())!;
  const x = head.x + head.width / 2,
    y = head.y + head.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(
    x +
      (side === "left" ? 8 : page.viewportSize()!.width - panel.width - 8) -
      panel.x,
    y + Math.max(8, page.viewportSize()!.height - panel.height - 74) - panel.y,
    { steps: 6 },
  );
  await page.mouse.up();
}

/** Вкладка шага опроса: «1. Адрес», «2. Номер для связи»… */
export function stepTab(page: Page, step: number): Locator {
  return talk(page)
    .getByRole("group", { name: "Шаги опроса" })
    .getByRole("button", { name: new RegExp(`^${step}\\. `) });
}

/** Открыть звонок и принять вызов; `mute` — без звука, реплики идут быстро. Проводник
 * по умолчанию выключен: его проверяет operator-guide.spec.ts. */
export async function openCall(
  page: Page,
  id: string,
  {
    user = "teacher",
    mute = true,
    guide = false,
    moveAside = true,
  }: {
    user?: string;
    mute?: boolean;
    guide?: boolean;
    moveAside?: boolean;
  } = {},
) {
  await login(page, user);
  await page.goto(`/app/operator?scenario=${id}`);
  const incoming = page.getByRole("dialog", { name: "Входящий вызов 112" });
  await expect(incoming).toBeVisible();
  await incoming
    .getByRole("checkbox", { name: "Проводник: подсказка на каждом шаге" })
    .setChecked(guide);
  await incoming.getByRole("button", { name: "Принять вызов" }).click();
  if (mute) await talk(page).getByRole("button", { name: "звук вкл." }).click();
  await expect(talk(page).getByRole("listitem").first()).toHaveText(
    `Заявитель: ${scenario(id).opening}`,
  );
  await idle(page);
  if (moveAside) await moveTalkAside(page);
  return talk(page);
}

/** Дождаться, пока заявитель договорит и кнопки разговора снова доступны. */
export async function idle(page: Page) {
  await expect(
    talk(page).getByRole("button", { name: /^Успокоить/ }),
  ).toBeEnabled({ timeout: 20_000 });
}

/** Реплика оператора и ответ заявителя: в журнале на две строки больше. */
async function exchange(page: Page, action: () => Promise<void>) {
  const lines = talk(page).getByRole("listitem");
  const before = await lines.count();
  await action();
  await expect(lines).toHaveCount(before + 2, { timeout: 20_000 });
  await idle(page);
}

export async function calm(page: Page, kind: "reason" | "order" = "reason") {
  await exchange(page, async () => {
    await talk(page)
      .getByRole("button", { name: /^Успокоить/ })
      .click();
    await talk(page)
      .getByRole("list", { name: "Успокоить" })
      .getByRole("button")
      .filter({ hasText: kind === "reason" ? "Я вам помогу" : "Успокойтесь!" })
      .click();
  });
}

export async function advise(page: Page, text: RegExp) {
  await exchange(page, async () => {
    await talk(page)
      .getByRole("button", { name: /^Советы/ })
      .click();
    await talk(page)
      .getByRole("list", { name: "Советы" })
      .getByRole("button", { name: text })
      .click();
  });
}

export async function hold(page: Page) {
  await exchange(page, () =>
    talk(page).getByRole("button", { name: "Слышу, записываю" }).click(),
  );
}

/** Кнопка вопроса: открыть вкладку шага, на которой он стоит (этап 3). */
export async function question(
  page: Page,
  name: string | RegExp,
): Promise<Locator> {
  const button = questions(page).getByRole("button", {
    name,
    exact: typeof name === "string",
  });
  if (await button.count()) return button;
  const tabs = talk(page)
    .getByRole("group", { name: "Шаги опроса" })
    .getByRole("button");
  for (let index = 0; index < (await tabs.count()); index++) {
    await tabs.nth(index).click();
    if (await button.count()) return button;
  }
  throw new Error(`Вопроса «${String(name)}» нет ни на одном шаге`);
}

export async function ask(page: Page, text: string) {
  const button = await question(page, text);
  await exchange(page, () => button.click());
}

/** Повторить вслух адрес из карточки (вопрос шага 1). */
export async function confirmAddress(page: Page) {
  const button = await question(page, READBACK);
  await exchange(page, () => button.click());
}

/** Переключатель «Сложно» — свой вопрос вместо вариантов шага. */
export function hardMode(page: Page): Locator {
  return talk(page).getByRole("checkbox", { name: "Сложно: свой вопрос" });
}

/** Режим «Сложно»: свой вопрос словами. */
export async function askOwn(page: Page, text: string) {
  const own = talk(page).getByRole("textbox", { name: "Свой вопрос" });
  if (!(await own.isVisible())) await hardMode(page).check();
  await exchange(page, async () => {
    await own.fill(text);
    await own.press("Enter");
  });
}

/** Адрес в карточку — поля слева. */
export async function fillAddress(
  page: Page,
  fields: Partial<
    Record<"Улица:" | "Дом/Вл:" | "Корпус:" | "Квартира/офис:", string>
  >,
) {
  for (const [label, value] of Object.entries(fields))
    await page.getByLabel(label, { exact: true }).fill(value ?? "");
}

export async function lastLine(page: Page): Promise<string> {
  return talk(page).getByRole("listitem").last().innerText();
}
