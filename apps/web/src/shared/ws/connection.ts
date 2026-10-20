// Состояние связи клиента (TC-08, docs/competitors/touches.md, «Обрыв связи»): обучаемый должен
// видеть, что работа не потеряна, когда она придёт на сервер и как не ждать. Здесь только расчёт
// строки; сам клиент — `client.ts`, показ — строка `ConnectionNotice` (`arm/trainer/TrainerCoach.tsx`), во всех режимах.

export interface ConnectionState {
  /** Связь есть: WS открыт и отправка очереди проходит. */
  readonly online: boolean;
  /** С какого момента (мс, Date.now) связи нет; у `online` — 0. */
  readonly since: number;
  /** Когда следующая попытка (мс, Date.now); null — попытка идёт сейчас или не назначена. */
  readonly retryAt: number | null;
}

export const ONLINE: ConnectionState = {
  online: true,
  since: 0,
  retryAt: null,
};

/** Задержки переподключения: 0,5 → 1 → 2 → 4 → 5 с (contracts/ws-events.md). */
export const BACKOFF_FIRST_MS = 500;
export const BACKOFF_MAX_MS = 5000;

export function nextBackoff(current: number): number {
  return Math.min(current * 2, BACKOFF_MAX_MS);
}

/** Короткие сбои (меньше этого) строкой не показываем: связь вернулась раньше, чем её заметили. */
export const SHOW_AFTER_MS = 1500;

/** Строка для обучаемого; null — связь есть или обрыв ещё слишком короткий. */
export function connectionLine(
  state: ConnectionState,
  now: number,
): string | null {
  if (state.online || now - state.since < SHOW_AFTER_MS) return null;
  if (state.retryAt === null || state.retryAt <= now)
    return "Работа не потеряна, переподключаемся…";
  const seconds = Math.max(1, Math.ceil((state.retryAt - now) / 1000));
  return `Работа не потеряна, переподключение через ${seconds} с…`;
}
