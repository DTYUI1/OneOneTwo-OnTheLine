// Реестр происшествий без React: тексты первого экрана, клавиши, порядок и страницы списка.
// Проверяются в listModel.test.ts, экран — ArmPage.

/** Минимум из ответа GET /progress, который нужен кнопке «Тренировка». */
export type ProgressLike = { current_step: number } | null | undefined;

/**
 * Пустой реестр. Без идущего занятия карточка от Системы 112 не придёт: вместо
 * ожидания ведём на тренировку, иначе самостоятельный обучаемый упирается в тупик.
 */
export function emptyListText(
  search: string,
  hasRunningSession: boolean,
  step?: number,
  /** В реестре есть карточки прошлой смены (TC-07): новых нет, а старые видны. */
  hasBackground = false,
): string {
  if (search.trim())
    return "По вашему запросу ничего не найдено. Измените запрос или нажмите «сбросить».";
  if (hasRunningSession)
    return hasBackground
      ? "Новых происшествий нет. Дождитесь карточки от Системы 112."
      : "Происшествий нет. Дождитесь карточки от Системы 112.";
  // Проводник есть только в обучающем упражнении; на ступенях 2+ подсказок нет.
  if (step)
    return `Занятие ещё не начато. Чтобы потренироваться самостоятельно, нажмите «Тренировка: ступень ${step}».`;
  return "Занятие ещё не начато. Чтобы потренироваться самостоятельно, нажмите «Тренировка» — проводник подскажет каждый шаг.";
}

/**
 * Ступень, которую запускает «Тренировка». На первой ступени — обучающее
 * упражнение с проводником, как до «Моего пути»: ступень не передаётся.
 */
export function trainingStep(progress: ProgressLike): number | undefined {
  const step = progress?.current_step ?? 0;
  return step >= 2 ? step : undefined;
}

/**
 * Этапы обучения в шапке списка — только на ступени 1 (решение 17.10). Пока путь
 * загружается (`undefined`), ступень неизвестна: группа не мелькает у обучаемого со
 * ступени 2+. Путь не загрузился (`failed`) — этапы видны, как на первой ступени.
 */
export function showsStages(progress: ProgressLike, failed = false): boolean {
  if (progress === undefined) return failed;
  return trainingStep(progress) === undefined;
}

/** Подпись «Тренировки»: ступень, на которой обучаемый сейчас («Мой путь»). */
export function trainingLabel(progress: ProgressLike): string {
  const step = trainingStep(progress);
  return step ? `Тренировка: ступень ${step}` : "Тренировка";
}

export type ListKeyAction = "focusSearch" | "firstRow";

/**
 * Клавиши реестра: «/» вне поля ввода — к поиску, ↓ из поиска — к первой строке.
 * `inInput` — фокус в поле ввода (в поиске для ↓).
 */
export function listKey(key: string, inInput: boolean): ListKeyAction | null {
  if (key === "/" && !inInput) return "focusSearch";
  if (key === "ArrowDown" && inInput) return "firstRow";
  return null;
}

/** «Записей на странице» — варианты списка; по умолчанию 10, как в АРМ (arm_dds/02, 03). */
export const PAGE_SIZES = [10, 25, 50, 100] as const;

export type ListPage = {
  /** Страница с нуля, уже в пределах реестра. */
  page: number;
  /** Число страниц; у пустого реестра 0 — «Страница:» без номера (arm_dds/02). */
  pages: number;
  /** Строки страницы — `slice(start, end)` общего списка. */
  start: number;
  end: number;
  /** «1-10 из 23»; пустой реестр — «0 из 0» (arm_dds/02, 03). */
  label: string;
};

/** Строка реестра: карточка занятия или отработанная карточка прошлой смены (TC-07). */
export type ListRow<C, B> =
  | { readonly kind: "card"; readonly id: string; readonly item: C }
  | { readonly kind: "background"; readonly id: string; readonly item: B };

/**
 * Реестр по «Дата ↓» (arm_dds/03): карточки занятий и прошлой смены — одним списком, новые
 * сверху. Фон старше начала своего занятия и встаёт ниже его карточек; карточки прошлых
 * занятий — по своей дате, а не над всем фоном, поэтому фон не уходит со страницы 1. При
 * равном времени — карточка занятия выше; внутри каждого списка порядок сохраняется.
 */
export function byDate<
  C extends { readonly id: string; readonly appeared_at: string },
  B extends { readonly id: string; readonly appeared_at: string },
>(cards: readonly C[], background: readonly B[]): ListRow<C, B>[] {
  const rows: ListRow<C, B>[] = [
    ...cards.map((item) => ({ kind: "card" as const, id: item.id, item })),
    ...background.map((item) => ({
      kind: "background" as const,
      id: item.id,
      item,
    })),
  ];
  return rows.sort(
    (a, b) => Date.parse(b.item.appeared_at) - Date.parse(a.item.appeared_at),
  );
}

/**
 * Пришло новое происшествие: в ответе есть id, которого не было в прошлом. Первый ответ
 * (`previous` null — экран только открыт или вернулись из карточки) новым не считается.
 */
export function cardArrived(
  previous: readonly string[] | null,
  next: readonly string[],
): boolean {
  if (!previous) return false;
  const known = new Set(previous);
  return next.some((id) => !known.has(id));
}

/**
 * Страница реестра. Номер вне списка (после поиска или смены «Записей на странице»)
 * прижимается к последней странице, а не оставляет пустой экран.
 */
export function listPage(total: number, page: number, size: number): ListPage {
  const pages = Math.ceil(total / size);
  const current = Math.min(Math.max(page, 0), Math.max(pages - 1, 0));
  const start = current * size;
  const end = Math.min(start + size, total);
  return {
    page: current,
    pages,
    start,
    end,
    label: total ? `${start + 1}-${end} из ${total}` : "0 из 0",
  };
}
