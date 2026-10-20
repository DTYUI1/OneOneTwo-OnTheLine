// Звуковые сигналы АРМ: новое происшествие и вызов бригады (27.09, параллельная работа).
// Web Audio, без файлов в поставке. По эталону зоны (softphone/README.md) сигнал зовёт
// один раз и гаснет — не нарастает и не давит; громкость как у гудков софтфона.

const LEVEL = 0.06;
/** Микро-рампы вместо мгновенных включений — иначе в наушниках щёлкает. */
const RAMP_S = 0.005;

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  // Окружение без Web Audio (тесты, старый браузер) — АРМ работает молча.
  if (typeof AudioContext === "undefined") return null;
  context ??= new AudioContext();
  if (context.state === "suspended") void context.resume();
  return context;
}

/** Один тон сигнала: начало от старта, частоты (звучат вместе), длительность и атака. */
export interface Tone {
  readonly at: number;
  readonly hz: readonly number[];
  readonly seconds: number;
  /** Нарастание громкости: короткое — щелчок, длинное — мягкий звонок. */
  readonly attack: number;
  /** Проверка гарнитуры: отдельный левый или правый канал. */
  readonly pan?: number;
}

function play(
  ready: AudioContext,
  tones: readonly Tone[],
  gain = 1,
): OscillatorNode[] {
  const now = ready.currentTime;
  const sources: OscillatorNode[] = [];
  for (const { at, hz, seconds, attack, pan = 0 } of tones) {
    const start = now + at;
    const level = ready.createGain();
    // Частоты звучат вместе: громкость делится, чтобы сумма не была громче одного тона.
    const peak = (LEVEL * gain) / hz.length;
    level.gain.setValueAtTime(0, start);
    level.gain.linearRampToValueAtTime(peak, start + attack);
    level.gain.setValueAtTime(peak, start + seconds - RAMP_S);
    level.gain.linearRampToValueAtTime(0, start + seconds);
    if (pan !== 0 && ready.createStereoPanner) {
      const side = ready.createStereoPanner();
      side.pan.value = pan;
      level.connect(side).connect(ready.destination);
    } else level.connect(ready.destination);
    for (const frequency of hz) {
      const tone = ready.createOscillator();
      tone.frequency.value = frequency;
      tone.connect(level);
      tone.start(start);
      tone.stop(start + seconds + RAMP_S);
      sources.push(tone);
    }
  }
  return sources;
}

/** Трель вызова, которая ещё звучит или впереди: трубку сняли — она обрывается. */
let callRing: OscillatorNode[] = [];

function ringCall(tones: readonly Tone[]): void {
  const ready = audio();
  if (!ready) return;
  stopCallSignal();
  callRing = play(ready, tones);
}

/**
 * Трубку сняли — трель вызова замолкает сразу. Иначе вторая трель звучала поверх начатого
 * разговора (проверка 17.10: «гудок проигрывается 2 раза, когда уже взяли трубку»).
 */
export function stopCallSignal(): void {
  for (const tone of callRing) {
    try {
      tone.stop();
    } catch {
      // Уже отзвучал.
    }
  }
  callRing = [];
}

/** Новое происшествие в строке состояния: два коротких высоких тона 880 Гц. */
export const NEW_CARD_TONES: readonly Tone[] = [
  { at: 0, hz: [880], seconds: 0.12, attack: RAMP_S },
  { at: 0.2, hz: [880], seconds: 0.12, attack: RAMP_S },
];

/** Повтор трели доклада бригады (TC-01, touches.md «Звук и входящий»). */
export const RING_PERIOD_S = 2.6;
/** Мягкая атака трели: звонок нарастает, а не щёлкает. */
export const RING_ATTACK_S = 0.08;
const RING_ON_S = 1;
/** Две трели — и сигнал гаснет: дальше зовут мигание вкладки и значок телефона. */
const RING_REPEATS = 2;

/**
 * Доклад бригады (TC-01): трель телефона — два тона 440 + 480 Гц вместе, мягкая атака, повтор
 * через 2,6 с. Ниже и длиннее сигнала карточки — на слух их не спутать.
 */
export const BRIGADE_RING_TONES: readonly Tone[] = Array.from(
  { length: RING_REPEATS },
  (_, index) => ({
    at: index * RING_PERIOD_S,
    hz: [440, 480],
    seconds: RING_ON_S,
    attack: RING_ATTACK_S,
  }),
);

/** Новое происшествие в строке состояния: два коротких высоких тона. */
export function newCardSignal(): void {
  const ready = audio();
  if (ready) play(ready, NEW_CARD_TONES);
}

/** Звонит бригада: трель доклада, дальше — только мигание вкладки. */
export function brigadeCallSignal(): void {
  ringCall(BRIGADE_RING_TONES);
}

/**
 * Тревога бригады (DT-10): двухтональный сигнал трижды — его не спутать с обычным вызовом
 * (как в макете B). Дальше, как у обычного вызова, — мигание вкладки.
 */
export const ALARM_TONES: readonly Tone[] = [0, 1, 2].flatMap((index) => [
  { at: index * 0.5, hz: [960], seconds: 0.24, attack: RAMP_S },
  { at: index * 0.5 + 0.25, hz: [770], seconds: 0.24, attack: RAMP_S },
]);

export function alarmCallSignal(): void {
  ringCall(ALARM_TONES);
}

/**
 * Срочность норматива (TC-06): «осталось 10 с» — двойной короткий бип 660 Гц. Частоты не
 * пересекаются с трелью доклада (440 + 480), сигналом карточки (880), тревогой (960/770) и
 * гудками софтфона (425).
 */
export const URGENCY_WARN_TONES: readonly Tone[] = [
  { at: 0, hz: [660], seconds: 0.1, attack: RAMP_S },
  { at: 0.18, hz: [660], seconds: 0.1, attack: RAMP_S },
];

/** «Просрочено» — один низкий тон 330 Гц с мягким началом: внимание, а не угроза. */
export const URGENCY_OVER_TONES: readonly Tone[] = [
  { at: 0, hz: [330], seconds: 0.45, attack: 0.03 },
];

/**
 * Сигнал срочности: подаётся один раз и гаснет. `gain` — множитель громкости из настройки
 * обучаемого (1 — уровень остальных сигналов); при 0 звука нет совсем.
 */
export function urgencySignal(kind: "warn" | "over", gain: number): void {
  if (gain <= 0) return;
  const ready = audio();
  if (ready)
    play(
      ready,
      kind === "warn" ? URGENCY_WARN_TONES : URGENCY_OVER_TONES,
      gain,
    );
}

/** Сообщение преподавателя: один мягкий тон. */
export function teacherMessageSignal(): void {
  const ready = audio();
  if (ready) play(ready, [{ at: 0, hz: [660], seconds: 0.18, attack: RAMP_S }]);
}

/** Проверка наушников: сначала левый, затем правый канал. */
export function headsetTestSignal(): void {
  const ready = audio();
  if (ready)
    play(ready, [
      { at: 0, hz: [523], seconds: 0.35, attack: RAMP_S, pan: -1 },
      { at: 0.5, hz: [523], seconds: 0.35, attack: RAMP_S, pan: 1 },
    ]);
}
