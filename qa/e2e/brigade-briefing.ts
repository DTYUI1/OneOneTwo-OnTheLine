import { expect, type Locator, type Page } from "@playwright/test";
import { expectShortOptions } from "./report-parts";
import { answer, currentStep, dial, freeBrigade, openPhone } from "./phone";

// GP-05: направить бригаду = разговор с ней. Кому звонить — силы службы в окне телефона
// (GP-09); бригада выезжает только после вводной (адрес и что случилось). Здесь — вводная
// по частям, без микрофона.

/**
 * Позвонить бригаде из контактов телефона и дать вводную по частям. `row` — кнопка
 * контакта бригады; по умолчанию первая свободная. Возвращает окно телефона.
 */
export async function briefBrigade(
  page: Page,
  row?: Locator,
  /** Шаги, где выбирается похожая ошибка (GP-06): «Адрес» — бригада поедет не туда. */
  wrong: readonly string[] = [],
): Promise<Locator> {
  const win = await openPhone(page);
  const line = await dial(page, row ?? freeBrigade(win));
  await giveBriefing(line, wrong);
  return line;
}

/** Вводная по частям в уже идущем разговоре с бригадой: «По частям», адрес, что случилось. */
export async function giveBriefing(
  line: Locator,
  /** Шаги, где выбирается похожая ошибка (GP-06). */
  wrong: readonly string[] = [],
): Promise<void> {
  const group = answer(line);
  await group.getByRole("button", { name: "По частям", exact: true }).click();
  const parts = group.locator('button[data-reply="brief"]');
  // Шаг «Адрес», затем «Что случилось»: до трёх коротких вариантов — верный из карточки
  // и похожие ошибки (GP-06).
  for (const step of ["Адрес", "Что случилось"]) {
    await expect(currentStep(line, step)).toBeVisible();
    await expectShortOptions(parts);
    const before = (await parts.allTextContents()).join("|");
    await group
      .locator(
        wrong.includes(step)
          ? 'button[data-reply="brief"][data-correct="false"]'
          : 'button[data-reply="brief"][data-correct="true"]',
      )
      .first()
      .click();
    await expect
      .poll(async () => (await parts.allTextContents()).join("|"))
      .not.toBe(before);
  }
}

/** Полная вводная по карточке для событий через API: адрес и что случилось. */
export function briefingText(source: {
  address: { street: string; house: string };
  incident_class: string;
  description: string;
}): string {
  const house = source.address.house ? `, дом ${source.address.house}` : "";
  return `${source.address.street}${house}. ${source.incident_class || source.description}`;
}
