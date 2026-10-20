// Плашка очереди действий (PendingActions.tsx): что из неподтверждённого показать обучаемому.
// Обычная отправка действия — 30–100 мс, а очередь проверяется раз в 2 с: попавшее в проверку
// действие «в пути» висело в плашке до следующей — «Действия ещё не подтверждены сервером» на
// 2 с при открытии карточки и в начале разговора (проверка капитана 20.10). Показываем только
// то, что сервер отклонил, и то, что не уходит дольше STUCK_AFTER_MS.
import type { PendingEvent } from "../shared/ws/outbox";

/** Дольше этого действие не уходит — застряло: связи нет или сервер не отвечает. */
export const STUCK_AFTER_MS = 3000;

/** Что показать в плашке; пусто — плашки нет. Есть отказ — вся очередь: она остановлена. */
export function noticeItems(
  items: readonly PendingEvent[],
  now: number,
): PendingEvent[] {
  if (items.some((item) => item.failure)) return [...items];
  return items.filter((item) => now - item.queuedAt >= STUCK_AFTER_MS);
}
