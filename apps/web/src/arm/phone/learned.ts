// Пояснения окна телефона, которые легко запомнить (GP-24, замечание пользователя 16.10):
// пояснение видно, пока обучаемый не сделал это действие верно LEARNED_AFTER раз, потом
// остаётся только в подсказке при наведении и в «?» окна. Счётчик — на учётную запись, в
// браузере (localStorage), как отметка приветствия (shared/welcome.ts). Здесь нет React:
// модуль читают и e2e-снимки окна (qa/e2e/dds-phone-shots.spec.ts).

/** Сколько верных действий — и пояснение прячется. Единственное место, где задано N. */
export const LEARNED_AFTER = 3;

/** Пояснение окна телефона — по действию, которое его «выучивает». */
export const LEARNED_HINTS = [
  // «Выберите, кому позвонить.», «Позвонить можно из открытой карточки.» — набран номер.
  "dial",
  // «Размер окна — потяните за любой край или угол» — размер окна изменён.
  "resize",
  // «Доклад по частям, шаг «…».» — доклад по частям без ошибок за круг.
  "report",
  // «Дайте бригаде вводную…», «Вводная по частям, шаг «…».» — бригада выехала по вводной.
  "briefing",
  // Подписи шкалы громкости «тихо», «норма», «громко» — фраза записана в норме.
  "meter",
  // «Говорите, удерживая пробел…» (TC-04) — ответ начат или закончен пробелом.
  "space",
  // «Проверьте адрес и нажмите Enter» (TC-04) — проверенная фраза отправлена клавишей Enter.
  "check",
] as const;

export type LearnedHint = (typeof LEARNED_HINTS)[number];

/** Сколько раз каждое действие сделано верно (не больше LEARNED_AFTER). */
export type LearnedCounts = Readonly<Partial<Record<LearnedHint, number>>>;

export function learnedKey(userId: string): string {
  return `arm112:phone-learned:v1:${userId}`;
}

/** Счётчики из сохранённой строки; чужое и битое не мешает — пояснения покажутся. */
export function parseLearned(raw: string | null): LearnedCounts {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null) return {};
  const counts: Partial<Record<LearnedHint, number>> = {};
  for (const hint of LEARNED_HINTS) {
    const count = (value as Record<string, unknown>)[hint];
    if (typeof count === "number" && Number.isInteger(count) && count > 0)
      counts[hint] = Math.min(count, LEARNED_AFTER);
  }
  return counts;
}

export function isLearned(counts: LearnedCounts, hint: LearnedHint): boolean {
  return (counts[hint] ?? 0) >= LEARNED_AFTER;
}

/** Ещё одно верное действие; выученное пояснение счётчик больше не растит. */
export function countLearned(
  counts: LearnedCounts,
  hint: LearnedHint,
): LearnedCounts {
  return isLearned(counts, hint)
    ? counts
    : { ...counts, [hint]: (counts[hint] ?? 0) + 1 };
}

// Хранилище на страницу: окно телефона, разговор карточки и контакты без карточки читают
// одни и те же счётчики — пояснение прячется во всех местах сразу.
const cache = new Map<string, LearnedCounts>();
const listeners = new Set<() => void>();

export function learnedCounts(userId: string): LearnedCounts {
  let counts = cache.get(userId);
  if (!counts) {
    try {
      counts = parseLearned(localStorage.getItem(learnedKey(userId)));
    } catch {
      // Без storage пояснения видны, счёт живёт до перезагрузки страницы.
      counts = {};
    }
    cache.set(userId, counts);
  }
  return counts;
}

export function learn(userId: string, hint: LearnedHint): void {
  const old = learnedCounts(userId);
  const next = countLearned(old, hint);
  if (next === old) return;
  cache.set(userId, next);
  try {
    localStorage.setItem(learnedKey(userId), JSON.stringify(next));
  } catch {
    // Счёт останется до перезагрузки страницы.
  }
  for (const listener of listeners) listener();
}

export function subscribeLearned(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
