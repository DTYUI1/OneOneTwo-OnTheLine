// Голос наставника (библия маскота, раздел 4): заранее озвученные реплики, интернет в классе
// не нужен. Реплики — voice/lines.json: `text` — ровно как на экране, по нему подсказка
// находит запись; озвучка — scripts/voices/mascot_synth.py (ElevenLabs, Alex Bell). Нет
// записи — наставник молчит, текст на экране остаётся.
//
// Правила (библия, 8): не больше одной реплики на шаг, уже сказанное не повторяет, новая
// реплика обрывает прежнюю. Молчит, если обучаемый убрал наставника или выключил голос.
import lines from "./voice/lines.json";
import { mascotShown, mascotVoice } from "./mascotModel";

export interface MentorLine {
  readonly id: string;
  readonly event: string;
  /** Как на экране. */
  readonly text: string;
  /** Как произносить, если отличается от экрана (галочка вместо ✓). */
  readonly speech?: string;
}

export const MENTOR_LINES: readonly MentorLine[] = lines.lines;

const files = import.meta.glob<string>("./voice/*.mp3", {
  eager: true,
  query: "?url",
  import: "default",
});

/** Запись реплики; null — ещё не озвучена. */
export function voiceUrl(id: string): string | null {
  return files[`./voice/${id}.mp3`] ?? null;
}

const byText = new Map(MENTOR_LINES.map((line) => [line.text, line]));

/** Реплика по тексту на экране. */
export function lineForText(text: string): MentorLine | null {
  return byText.get(text) ?? null;
}

/** Текст реплики для экрана — окна обучения берут его отсюда, чтобы он совпадал с записью. */
export function mentorText(id: string): string {
  const line = MENTOR_LINES.find((item) => item.id === id);
  if (!line) throw new Error(`Нет реплики наставника ${id}`);
  return line.text;
}

let playing: HTMLAudioElement | null = null;
const said = new Set<string>();

/**
 * Сказать реплику, если её ещё не говорили с этим ключом: ключ — карточка и шаг, у окон —
 * само окно. Браузер может не дать звук без нажатия на странице — тогда тихо.
 */
export function say(id: string, key: string = id): void {
  if (said.has(key)) return;
  said.add(key);
  if (!mascotShown() || !mascotVoice()) return;
  const url = voiceUrl(id);
  if (!url) return;
  hush();
  const audio = new Audio(url);
  playing = audio;
  audio.addEventListener("ended", () => {
    if (playing === audio) playing = null;
  });
  void audio.play().catch(() => {
    if (playing === audio) playing = null;
  });
}

/** Замолчать: подсказку спрятали, окно закрыли или голос выключили. */
export function hush(): void {
  playing?.pause();
  playing = null;
}

/** Забыть сказанное (для тестов). */
export function resetSaid(): void {
  said.clear();
  hush();
}
