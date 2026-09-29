// Голос заявителя и фон в трубке (этап 2). Реплики — файлы Piper (voiceAssets.ts). Нет
// файла или звук выключен — реплика «звучит» паузой по длине текста: темп разговора не
// зависит от того, есть ли звук.

import { createTones } from "../arm/softphone/tones";
import { BACKGROUNDS, CALLER_VOICES } from "./voiceAssets";

const READ_MS_PER_CHAR = 35;
const READ_MIN_MS = 600;
const READ_MAX_MS = 4000;
/** Без звука текст виден сразу — короткая пауза, только чтобы реплики не слипались. */
const MUTED_MS = 300;
/** Фон тише голоса: его слышно, но он не мешает разобрать слова. */
const BACKGROUND_VOLUME = 0.35;

export function readingDelay(text: string): number {
  return Math.min(
    READ_MAX_MS,
    Math.max(READ_MIN_MS, text.length * READ_MS_PER_CHAR),
  );
}

export interface CallerAudio {
  /** Произнести реплику; промис — когда она закончилась или её прервали. */
  say(voice: string | undefined, text: string): Promise<void>;
  replay(voice: string): void;
  background(name: string | null): void;
  ring(on: boolean): void;
  setMuted(muted: boolean): void;
  stop(): void;
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createCallerAudio(): CallerAudio {
  let muted = false;
  let speech: HTMLAudioElement | null = null;
  // Завершить текущую реплику: пауза не шлёт `ended`, а разговор ждёт её конца.
  let finishSpeech: (() => void) | null = null;
  let bed: HTMLAudioElement | null = null;
  let bedName: string | null = null;
  const tones = createTones();
  const playable = () => typeof Audio !== "undefined";

  function interrupt() {
    speech?.pause();
    speech = null;
    const finish = finishSpeech;
    finishSpeech = null;
    finish?.();
  }

  function stopBed() {
    bed?.pause();
    bed = null;
  }

  function startBed() {
    stopBed();
    const url = bedName ? BACKGROUNDS[bedName] : undefined;
    if (muted || !url || !playable()) return;
    bed = new Audio(url);
    bed.loop = true;
    bed.volume = BACKGROUND_VOLUME;
    void bed.play().catch(() => undefined);
  }

  return {
    say(voice, text) {
      interrupt();
      const url = voice ? CALLER_VOICES[voice] : undefined;
      if (muted) return wait(MUTED_MS);
      if (!url || !playable()) return wait(readingDelay(text));
      return new Promise((resolve) => {
        const audio = new Audio(url);
        speech = audio;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          if (finishSpeech === finish) finishSpeech = null;
          resolve();
        };
        finishSpeech = finish;
        // Файл не отдался или браузер не дал играть — пауза по длине текста.
        const fallback = () => void wait(readingDelay(text)).then(finish);
        audio.onended = finish;
        audio.onerror = fallback;
        audio.play().catch(fallback);
      });
    },
    replay(voice) {
      const url = CALLER_VOICES[voice];
      if (muted || !url || !playable()) return;
      interrupt();
      speech = new Audio(url);
      void speech.play().catch(() => undefined);
    },
    background(name) {
      bedName = name;
      startBed();
    },
    ring(on) {
      if (on) tones.ringback();
      else tones.stop();
    },
    setMuted(next) {
      muted = next;
      if (muted) {
        interrupt();
        stopBed();
      } else if (bedName) startBed();
    },
    stop() {
      interrupt();
      stopBed();
      bedName = null;
      tones.stop();
    },
  };
}
