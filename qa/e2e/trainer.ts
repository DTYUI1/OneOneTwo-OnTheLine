import { type Locator, type Page } from "@playwright/test";

// Тренажёр после решения 17.10: панели «Тренажёр» нет. В обучении («Смотрю», «Вместе»)
// тренажёр говорит подсказкой у элемента шага; на тестах («Сам», ступени 2–4, каталог,
// занятия) от него на экране ничего нет. Необратимый статус во всех режимах сохраняется
// вторым нажатием ✓ — над ✓ подпись «Нажмите ✓ или Enter ещё раз…».

/** Подсказка тренажёра у элемента шага (только в обучении). */
export function coach(page: Page): Locator {
  return page.getByRole("region", { name: "Подсказка тренажёра" });
}

/** Подпись у ✓: первое нажатие взвело необратимый статус, второе сохранит его. */
export function confirmAgain(page: Page): Locator {
  return page.getByRole("status").filter({
    hasText: /^Нажмите ✓ или Enter ещё раз/,
  });
}

/** Этапы обучения «Смотрю → Вместе → Сам» в шапке списка (пока обучаемый на ступени 1). */
export function stages(page: Page): Locator {
  return page.getByRole("group", { name: "Этапы обучения" });
}

/**
 * Окно «Как устроено обучение» (DT-18) «уже видели» — у любого, кто войдёт. Ключ окна у
 * каждого пользователя свой (`trainer:intro:<id>`, stages.ts, проверка 20.10), а id до входа
 * неизвестен: скрипт страницы отвечает «видели» на любой такой ключ. Для `page.addInitScript`.
 */
export function introSeenForAnyUser(): void {
  try {
    const read = Storage.prototype.getItem;
    Storage.prototype.getItem = function (this: Storage, key: string) {
      return key.startsWith("trainer:intro:") ? "1" : read.call(this, key);
    };
  } catch {
    // Без хранилища окно покажется — проверки его не ждут.
  }
}
