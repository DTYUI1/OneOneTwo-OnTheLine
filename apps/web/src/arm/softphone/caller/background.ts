// Фон под звонком заявителю (HQ-019, docs/dds_caller.md, раздел 4): между репликами вшитая
// подложка молчит, поэтому под разговором идёт петля того же места — готовые петли модуля
// «Оператор 112» (`data/voices/operator/background`, без интернета). Тише голоса: громкость
// звука разговора × 0,35, как у оператора 112 (`operator/voice.ts`, `BACKGROUND_VOLUME`).
import { useEffect, useRef } from "react";
import { BACKGROUNDS } from "../../../operator/voiceAssets";

export const BACKGROUND_SHARE = 0.35;

/** Петля `name`, пока `on`: заявитель снял трубку; гаснет на отбое и удержании. */
export function useCallerBackground(
  name: string | null,
  on: boolean,
  muted: boolean,
  volume: number,
): void {
  const bed = useRef<HTMLAudioElement | null>(null);
  const url = name ? BACKGROUNDS[name] : undefined;
  useEffect(() => {
    if (!on || !url || typeof Audio === "undefined") return;
    const audio = new Audio(url);
    audio.loop = true;
    bed.current = audio;
    void audio.play().catch(() => undefined);
    return () => {
      audio.pause();
      bed.current = null;
    };
  }, [on, url]);
  useEffect(() => {
    const audio = bed.current;
    if (!audio) return;
    audio.muted = muted;
    audio.volume = Math.max(0, Math.min(1, volume * BACKGROUND_SHARE));
  }, [muted, volume, on]);
}
