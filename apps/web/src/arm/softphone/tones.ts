// Тоны линии через Web Audio: ни одного аудиофайла в поставке.
// Частота и длительности — российский телефонный стандарт, поэтому сигнал
// узнаётся на слух без объяснений: 425 Гц, КПВ 1 с сигнал / 4 с пауза.

import type { CallState } from "./machine";

export interface Tones {
  /** Контроль посылки вызова — «длинные гудки» в трубке. */
  ringback(): void;
  /** Щелчок снятия и укладки трубки. */
  click(): void;
  /** Тихое шипение открытой линии (TC-09): включается и гаснет плавно. */
  line(on: boolean): void;
  /** Гасит гудки; шипение линии живёт своим `line`. */
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
/**
 * Шипение линии — на грани слышимости: оно говорит «линия открыта», а не
 * нагнетает. Полоса телефона, как у голосов (scripts/voices/phone.py).
 */
const LINE_LEVEL = 0.006;
const LINE_LOOP_S = 3;
const LINE_FADE_S = 0.4;
const LINE_LOW_HZ = 300;
const LINE_HIGH_HZ = 3400;

/** Шипение звучит только в разговоре и молчит при «звук выкл.» и после занятия. */
export function lineHiss(
  state: CallState,
  muted: boolean,
  disabled: boolean,
): boolean {
  return state === "talking" && !muted && !disabled;
}

export function createTones(): Tones {
  let context: AudioContext | null = null;
  let oscillator: OscillatorNode | null = null;
  let gain: GainNode | null = null;
  let lineSource: AudioBufferSourceNode | null = null;
  let lineGain: GainNode | null = null;

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

  function lineOff(fadeS: number): void {
    if (lineGain && context) {
      const at = context.currentTime;
      lineGain.gain.cancelScheduledValues(at);
      lineGain.gain.setValueAtTime(lineGain.gain.value, at);
      lineGain.gain.linearRampToValueAtTime(0, at + fadeS);
      lineSource?.stop(at + fadeS + RAMP_S);
    }
    lineSource = null;
    lineGain = null;
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

    line(on: boolean): void {
      if (!on) {
        lineOff(LINE_FADE_S);
        return;
      }
      if (lineSource) return;
      const ready = wake();
      if (!ready) return;
      const frames = Math.round(ready.sampleRate * LINE_LOOP_S);
      const buffer = ready.createBuffer(1, frames, ready.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let index = 0; index < frames; index++)
        samples[index] = Math.random() * 2 - 1;
      const noise = ready.createBufferSource();
      const low = ready.createBiquadFilter();
      const high = ready.createBiquadFilter();
      const level = ready.createGain();
      noise.buffer = buffer;
      noise.loop = true;
      low.type = "highpass";
      low.frequency.value = LINE_LOW_HZ;
      high.type = "lowpass";
      high.frequency.value = LINE_HIGH_HZ;
      level.gain.setValueAtTime(0, ready.currentTime);
      level.gain.linearRampToValueAtTime(
        LINE_LEVEL,
        ready.currentTime + LINE_FADE_S,
      );
      noise
        .connect(low)
        .connect(high)
        .connect(level)
        .connect(ready.destination);
      noise.start();
      lineSource = noise;
      lineGain = level;
    },

    stop(): void {
      silence();
    },

    close(): void {
      silence();
      lineOff(RAMP_S);
      void context?.close();
      context = null;
    },
  };
}
