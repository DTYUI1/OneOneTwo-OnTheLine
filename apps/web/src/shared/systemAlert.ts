// Видимое оповещение о сбое (FR-7.4): что сломалось и чем это грозит занятию.
// Чистая функция без React и сети — проверяется тестами.

import type { components } from "../api-client/schema";

type Health = components["schemas"]["Health"];

/**
 * Список проблем словами; пустой — сбоя нет. `health = null` и `failed` — сервер не
 * ответил. В mock-режиме БД и worker не подключаются намеренно — это не сбой.
 */
export function describeOutage(
  health: Health | null,
  failed: boolean,
): string[] {
  if (failed || !health)
    return failed
      ? [
          "Сервер не отвечает — действия не сохраняются, пока связь не восстановится.",
        ]
      : [];
  if (health.mode !== "database" || health.status === "ok") return [];
  const problems: string[] = [];
  if (health.database === "error")
    problems.push(
      "База данных недоступна или не обновлена — занятия и карточки не работают.",
    );
  if (health.worker === "error")
    problems.push(
      "Фоновый обработчик не отвечает — новые карточки не выдаются, оценки не считаются.",
    );
  if (problems.length === 0)
    problems.push(
      "Мгновенные обновления недоступны — экран может отставать, обновите страницу.",
    );
  return problems;
}
