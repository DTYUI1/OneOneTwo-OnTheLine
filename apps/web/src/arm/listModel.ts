// Реестр происшествий без React: тексты первого экрана и клавиши списка.
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
): string {
  if (search.trim())
    return "По вашему запросу ничего не найдено. Измените запрос или нажмите «сбросить».";
  if (hasRunningSession)
    return "Происшествий нет. Дождитесь карточки от Системы 112.";
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
