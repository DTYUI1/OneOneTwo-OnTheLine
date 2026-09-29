// Тоны линии через Web Audio: ни одного аудиофайла в поставке.
// Частота и длительности — российский телефонный стандарт, поэтому сигнал
// узнаётся на слух без объяснений: 425 Гц, КПВ 1 с сигнал / 4 с пауза.

export interface Tones {
  /** Контроль посылки вызова — «длинные гудки» в трубке. */
  ringback(): void;
  /** Щелчок снятия и укладки трубки. */
  click(): void;
  stop(): void;
  close(): void;
}

const TONE_HZ = 425;
const RINGBACK_ON_S = 1;
const RINGBACK_OFF_S = 4;
/** ~2 минуты расписания вперёд — дольше любого звонка в тренажёре. */
const RINGBACK_CYCLES = 24;
/** Негромко: по эталону зоны сигнал зовёт, а не давит. */
const LEVEL = 0.06;
const CLICK_LEVEL = 0.05;
const CLICK_S = 0.009;
/**
 * Щелчок рычага — глухой и низкий. Широкополосный шум на той же длительности
 * слышен шипением и читается как дефект, а не как звук аппарата.
 */
const CLICK_CUTOFF_HZ = 1800;
/** Микро-рампы вместо мгновенных включений — иначе в наушниках щёлкает. */
const RAMP_S = 0.005;

export function createTones(): Tones {
  let context: AudioContext | null = null;
  let oscillator: OscillatorNode | null = null;
  let gain: GainNode | null = null;

  function audio(): AudioContext | null {
    if (context) return context;
    // Окружение без Web Audio (тесты, старый браузер) — софтфон работает молча.
    if (typeof AudioContext === "undefined") return null;
    context = new AudioContext();
    return context;
  }

  function wake(): AudioContext | null {
    const ready = audio();
    if (!ready) return null;
    // Контекст создаётся по жесту пользователя, но вкладка могла его усыпить.
    if (ready.state === "suspended") void ready.resume();
    return ready;
  }

  function silence(): void {
    if (gain && context) {
      gain.gain.cancelScheduledValues(context.currentTime);
      gain.gain.setValueAtTime(gain.gain.value, context.currentTime);
      gain.gain.linearRampToValueAtTime(0, context.currentTime + RAMP_S);
    }
    oscillator?.stop((context?.currentTime ?? 0) + RAMP_S * 2);
    oscillator = null;
    gain = null;
  }

  return {
    ringback(): void {
      const ready = wake();
      if (!ready) return;
      silence();
      const tone = ready.createOscillator();
      const level = ready.createGain();
      tone.frequency.value = TONE_HZ;
      level.gain.setValueAtTime(0, ready.currentTime);
      for (let cycle = 0; cycle < RINGBACK_CYCLES; cycle++) {
        const at = ready.currentTime + cycle * (RINGBACK_ON_S + RINGBACK_OFF_S);
        level.gain.setValueAtTime(0, at);
        level.gain.linearRampToValueAtTime(LEVEL, at + RAMP_S);
        level.gain.setValueAtTime(LEVEL, at + RINGBACK_ON_S - RAMP_S);
        level.gain.linearRampToValueAtTime(0, at + RINGBACK_ON_S);
      }
      tone.connect(level).connect(ready.destination);
      tone.start();
      oscillator = tone;
      gain = level;
    },

    click(): void {
      const ready = wake();
      if (!ready) return;
      const frames = Math.max(1, Math.round(ready.sampleRate * CLICK_S));
      const buffer = ready.createBuffer(1, frames, ready.sampleRate);
      const samples = buffer.getChannelData(0);
      const attack = Math.max(1, Math.round(frames * 0.2));
      for (let index = 0; index < frames; index++) {
        // Атака и затухание внутри буфера: включение с полной амплитуды даёт
        // разрыв сигнала, и он слышен как хрип в самом начале.
        const rise = index < attack ? index / attack : 1;
        const fall = Math.exp(-5 * (index / frames));
        samples[index] = (Math.random() * 2 - 1) * rise * fall;
      }
      const noise = ready.createBufferSource();
      const muffle = ready.createBiquadFilter();
      const level = ready.createGain();
      muffle.type = "lowpass";
      muffle.frequency.value = CLICK_CUTOFF_HZ;
      level.gain.value = CLICK_LEVEL;
      noise.buffer = buffer;
      noise.connect(muffle).connect(level).connect(ready.destination);
      noise.start();
    },

    stop(): void {
      silence();
    },

    close(): void {
      silence();
      void context?.close();
      context = null;
    },
  };
}
