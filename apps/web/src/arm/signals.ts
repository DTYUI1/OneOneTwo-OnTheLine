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

function beep(ready: AudioContext, at: number, hz: number, seconds: number) {
  const tone = ready.createOscillator();
  const level = ready.createGain();
  tone.frequency.value = hz;
  level.gain.setValueAtTime(0, at);
  level.gain.linearRampToValueAtTime(LEVEL, at + RAMP_S);
  level.gain.setValueAtTime(LEVEL, at + seconds - RAMP_S);
  level.gain.linearRampToValueAtTime(0, at + seconds);
  tone.connect(level).connect(ready.destination);
  tone.start(at);
  tone.stop(at + seconds + RAMP_S);
}

/** Новое происшествие в строке состояния: два коротких высоких тона. */
export function newCardSignal(): void {
  const ready = audio();
  if (!ready) return;
  const now = ready.currentTime;
  beep(ready, now, 880, 0.12);
  beep(ready, now + 0.2, 880, 0.12);
}

/** Звонит бригада: две трели телефонного звонка, дальше — только мигание вкладки. */
export function brigadeCallSignal(): void {
  const ready = audio();
  if (!ready) return;
  const now = ready.currentTime;
  for (let burst = 0; burst < 2; burst++)
    for (let step = 0; step < 8; step++)
      beep(ready, now + burst * 1.4 + step * 0.05, step % 2 ? 480 : 440, 0.05);
}
