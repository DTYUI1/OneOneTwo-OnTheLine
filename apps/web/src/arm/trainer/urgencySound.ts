// Громкость и «без звука» сигналов срочности (TC-06): помнятся в браузере, чтобы обучаемый
// выбрал один раз. Хранилище может не открыться (приватное окно) — тогда настройка живёт до
// перезагрузки страницы, звук не ломается. Здесь нет React: зона читает через
// useSyncExternalStore, сигнал — через getSound().

export interface UrgencySound {
  readonly muted: boolean;
  /** Громкость от 0 до 1; 0,5 — как у остальных сигналов АРМ. */
  readonly volume: number;
}

export const DEFAULT_SOUND: UrgencySound = { muted: false, volume: 0.5 };
export const SOUND_KEY = "arm112:urgency-sound:v1";

/** Настройка из сохранённой строки; чужое и битое — настройка по умолчанию. */
export function parseSound(raw: string | null): UrgencySound {
  if (!raw) return DEFAULT_SOUND;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_SOUND;
  }
  if (typeof value !== "object" || value === null) return DEFAULT_SOUND;
  const { muted, volume } = value as Record<string, unknown>;
  return {
    muted: typeof muted === "boolean" ? muted : DEFAULT_SOUND.muted,
    volume:
      typeof volume === "number" && Number.isFinite(volume)
        ? Math.min(1, Math.max(0, volume))
        : DEFAULT_SOUND.volume,
  };
}

/** Множитель громкости сигнала: 0,5 даёт 1 — уровень остальных сигналов. */
export function soundGain(sound: UrgencySound): number {
  return sound.muted ? 0 : sound.volume * 2;
}

function load(): UrgencySound {
  try {
    return parseSound(localStorage.getItem(SOUND_KEY));
  } catch {
    return DEFAULT_SOUND;
  }
}

let current: UrgencySound | null = null;
const listeners = new Set<() => void>();

export function getSound(): UrgencySound {
  current ??= load();
  return current;
}

export function setSound(next: UrgencySound): void {
  current = next;
  try {
    localStorage.setItem(SOUND_KEY, JSON.stringify(next));
  } catch {
    // Не сохранилось — настройка действует до перезагрузки.
  }
  for (const listener of listeners) listener();
}

export function subscribeSound(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Забыть прочитанное (для тестов). */
export function resetSound(): void {
  current = null;
}
