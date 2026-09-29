// Подсказки орфографии в комментарии (28.09): POST /spelling/check возвращает слова,
// которых нет в словаре, с позициями в строке (единицы UTF-16, как у String.slice).
import type { components } from "../api-client/schema";

export type SpellingIssue = components["schemas"]["SpellingSuggestion"];

/**
 * Ответ приходит с задержкой: пока он шёл, текст могли поправить. Показываем только
 * подсказки, чьё слово всё ещё стоит на своём месте. Слово без вариантов тоже
 * показываем: в оценке оно всё равно считается ошибкой.
 */
export function currentIssues(
  text: string,
  issues: readonly SpellingIssue[],
): SpellingIssue[] {
  return issues.filter(
    (issue) => text.slice(issue.start, issue.end) === issue.word,
  );
}

/** Заменить слово вариантом исправления; если слово уже другое — текст не трогаем. */
export function applySuggestion(
  text: string,
  issue: SpellingIssue,
  suggestion: string,
): string {
  if (text.slice(issue.start, issue.end) !== issue.word) return text;
  return text.slice(0, issue.start) + suggestion + text.slice(issue.end);
}
