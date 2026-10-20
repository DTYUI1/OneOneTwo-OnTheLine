import { expect, type APIRequestContext, type Locator } from "@playwright/test";
import { answer, currentStep } from "./phone";

// GP-06: доклад службе без микрофона — по частям (docs/dds_gameplay.md, раздел 6). На шаге
// до трёх вариантов короче 60 символов, верный на экране не отмечен; `data-correct` у
// кнопки — для показа «Смотрю» и этих проверок.

/** Варианты текущего шага: не больше трёх, каждый короче 60 символов. */
export async function expectShortOptions(options: Locator): Promise<void> {
  const texts = await options.allTextContents();
  expect(texts.length).toBeGreaterThan(1);
  expect(texts.length).toBeLessThanOrEqual(3);
  for (const text of texts) expect(text.trim().length).toBeLessThan(60);
}

/**
 * Шаги полного доклада службе по памятке ДДС, с. 32. Карточку памятка требует только в
 * звонке в 112 — в звонке службе шага «Карточка» нет.
 */
export const REPORT_STEPS = [
  "Кто вы",
  "Адрес",
  "Что случилось",
  "Что изменилось",
] as const;

/**
 * Пройти круг доклада по частям: `steps` — ожидаемые шаги по порядку, `wrong` — шаги, где
 * выбирается ошибка («Адрес»), на остальных — верная часть. «По частям» раскрывается, если
 * варианты свёрнуты.
 */
export async function reportByParts(
  talk: Locator,
  steps: readonly string[] = REPORT_STEPS,
  wrong: readonly string[] = [],
): Promise<void> {
  // GP-09: варианты и «По частям» — в полосе «Ответ» окна телефона.
  const group = answer(talk);
  const options = group.locator('button[data-part="report"]');
  const open = group.locator('button[data-parts="report"]');
  await expect(options.first().or(open)).toBeVisible({ timeout: 20_000 });
  if (!(await options.first().isVisible())) await open.click();
  await expect(options.first()).toBeVisible({ timeout: 15_000 });
  for (const label of steps) {
    await expect(currentStep(talk, label)).toBeVisible();
    await expectShortOptions(options);
    const pick = wrong.includes(label)
      ? group
          .locator('button[data-part="report"][data-correct="false"]')
          .first()
      : group.locator('button[data-part="report"][data-correct="true"]');
    const text = (await pick.textContent())!.trim();
    const before = (await options.allTextContents()).join("|");
    await pick.click();
    // Следующий шаг — другие варианты; после последнего шага круга служба отвечает.
    await expect
      .poll(async () => (await options.allTextContents()).join("|"))
      .not.toBe(before);
    // Выбранная часть сразу строкой в ленте (кнопки с этим текстом уже нет).
    await expect(
      talk
        .locator("li", { hasText: /^Вы сказали/ })
        .filter({ hasText: text })
        .last(),
    ).toBeVisible();
  }
  // TC-03: улица карточки похожа на другую улицу Москвы — на полный доклад дежурный службы
  // просит повторить её по буквам; верный вариант закрывает доклад.
  if (
    await talk
      .getByText(/по буквам/)
      .last()
      .isVisible()
  ) {
    const right = group.locator(
      'button[data-part="report"][data-correct="true"]',
    );
    await expect(right).toHaveCount(1);
    await right.click();
  }
}

/** Номер регистрации, который назвал дежурный службы в звонке карточки (TC-03). */
export async function registrationNumber(
  request: APIRequestContext,
  cardId: string,
): Promise<string> {
  let number = "";
  await expect
    .poll(async () => {
      const events = (await (
        await request.get(`/api/cards/${cardId}/events`)
      ).json()) as {
        type: string;
        payload: { registration_number?: string };
      }[];
      number =
        events.find((event) => event.type === "call_hangup")?.payload
          .registration_number ?? "";
      return number;
    })
    .toMatch(/^\d+$/);
  return number;
}
