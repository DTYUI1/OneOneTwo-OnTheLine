// Наставник Николай Сергеевич, старший смены, — лицо подсказки тренажёра в обучении (библия
// маскота: docs/JBTD/projects/dds-dispatcher-mascot/research/04-mascot-bible.md, разделы 5
// и 8). Он стоит в подсказке по пояс и указывает ручкой туда же, куда её стрелка. Здесь нет
// React: какая поза и показывать ли его этому обучаемому. Вид — Mascot.tsx.
//
// Выключить его можно для себя (библия, 8): подсказка остаётся, только без фигуры; голос —
// отдельно. Настройки помнятся в браузере, как громкость сигналов (urgencySound.ts); хранилище
// не открылось — живут до перезагрузки страницы.

export const MASCOT_NAME = "Николай Сергеевич";
export const MASCOT_ROLE = "старший смены";

/** Позы по пояс (библия, раздел 5); `point-*` — куда указывает ручка на экране. */
export type MascotPose =
  | "greet"
  | "point-left"
  | "point-right"
  | "point-up"
  | "point-down"
  | "point-up-right"
  | "point-down-right"
  | "explain"
  | "wait"
  | "listen"
  | "correct"
  | "attention"
  | "approve"
  | "step-up"
  | "goodbye";

/**
 * Куда указывает рука в каждой позе — угол на экране: 0° — вправо, 90° — вниз (библия, 10.8:
 * `point-up` и `point-down` — рука с ручкой вверх и вниз под 45° к левому краю;
 * `point-up-right` и `point-down-right` — левая рука под 45° к правому, ручка опущена).
 */
const POINTS: readonly (readonly [MascotPose, number])[] = [
  ["point-right", 0],
  ["point-down-right", 45],
  ["point-down", 135],
  ["point-left", 180],
  ["point-up", -135],
  ["point-up-right", -45],
];

const gap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/**
 * Поза, которой наставник указывает на цель: dx, dy — от его плеча к цели в пикселях экрана
 * (y вниз). Берётся поза с ближайшим направлением руки — по настоящему положению цели, а
 * не по стороне подсказки: подсказка слева от цели, а цель ниже — рука вниз, не вбок.
 */
export function poseToward(dx: number, dy: number): MascotPose {
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  let best = POINTS[0];
  for (const point of POINTS)
    if (gap(point[1], angle) < gap(best[1], angle)) best = point;
  return best[0];
}

export const MASCOT_KEY = "arm112:mascot-off:v1";
/** Голос наставника выключается отдельно от фигуры: текст в подсказке остаётся. */
export const VOICE_KEY = "arm112:mascot-voice-off:v1";

/**
 * Настройка — у каждого пользователя своя: на общем компьютере выключенный наставник
 * переходил к следующему обучаемому (проверка 20.10). Ключ — `MASCOT_KEY:<id пользователя>`;
 * прежние общие ключи без пользователя не читаются — чьи они, уже не узнать. До входа
 * пользователя нет: настройка по умолчанию и не сохраняется.
 */
export const mascotKey = (key: string, userId: string) => `${key}:${userId}`;
let owner: string | null = null;

const listeners = new Set<() => void>();

/** Включённая по умолчанию настройка: в хранилище пишется только «выключено». */
function flag(key: string) {
  let current: boolean | null = null;
  return {
    get(): boolean {
      if (current === null) {
        try {
          current =
            owner === null ||
            localStorage.getItem(mascotKey(key, owner)) !== "1";
        } catch {
          current = true;
        }
      }
      return current;
    },
    set(on: boolean): void {
      current = on;
      try {
        if (owner === null) return;
        if (on) localStorage.removeItem(mascotKey(key, owner));
        else localStorage.setItem(mascotKey(key, owner), "1");
      } catch {
        // Не сохранилось — настройка действует до перезагрузки.
      } finally {
        for (const listener of listeners) listener();
      }
    },
    reset(): void {
      current = null;
    },
  };
}

const shown = flag(MASCOT_KEY);
const voice = flag(VOICE_KEY);

/** Показывать ли наставника в подсказках; по умолчанию — да. */
export const mascotShown = (): boolean => shown.get();
export const setMascotShown = (on: boolean): void => shown.set(on);

/** Говорит ли наставник вслух; без фигуры он молчит в любом случае. */
export const mascotVoice = (): boolean => voice.get();
export const setMascotVoice = (on: boolean): void => voice.set(on);

export function subscribeMascot(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Забыть прочитанное (для тестов). */
export function resetMascot(): void {
  shown.reset();
  voice.reset();
}

/**
 * Чьи настройки читать: вход, выход и смена учётной записи без перезагрузки страницы
 * (`Shell.tsx`). Подписчики перечитывают фигуру и голос нового пользователя.
 */
export function setMascotUser(userId: string | null): void {
  if (owner === userId) return;
  owner = userId;
  resetMascot();
  for (const listener of listeners) listener();
}
