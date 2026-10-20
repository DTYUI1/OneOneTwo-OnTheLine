// Доклад службе голосом (DT-05): чистые правила без браузера и сети. Голос — основной путь,
// варианты ответа (report.ts) — запасной в том же окне разговора. Фразу распознаёт сервер
// (POST /calls/{id}/voice-report, локальный faster-whisper) и сводит её к тому же виду
// доклада, что у вариантов: голос и вариант оцениваются по одной шкале, вариант — ниже.
// Сервер называет и прозвучавшие части памятки ДДС, с. 32 (DT-11) — их видно в разборе.

import { peerAlmostDone } from "./pushToTalk";
import { officialPhrase } from "./bank";
import {
  partsOf,
  type AddressGap,
  type ReportChoice,
  type ReportPart,
} from "./report";

/** После стольких нераспознанных фраз предлагаются варианты (evalcore: та же константа). */
export const MAX_VOICE_FAILURES = 2;
/** Одна фраза доклада не длиннее — запись останавливается сама. */
export const MAX_PHRASE_MS = 10_000;

/** Что служба отвечает на нераспознанную фразу — фраза банка дежурного (GP-25). */
export const NOT_HEARD = officialPhrase("not_understood");

/** Почему голосом доложить нельзя. */
export type VoiceProblem =
  | "no_recorder"
  | "insecure"
  | "denied"
  | "no_device"
  | "server_off";

/** Как сказан доклад: так он и попадает в отбой (`call_hangup.report_modes`). */
export type ReportMode = "voice" | "option";

export const PROBLEM: Record<VoiceProblem, string> = {
  no_recorder: "Браузер не записывает звук.",
  insecure: "Микрофон работает только по защищённому соединению.",
  denied: "Нет доступа к микрофону: браузер его не разрешил.",
  no_device: "Микрофон не найден. Подключите гарнитуру.",
  server_off: "Распознавание речи на сервере выключено.",
};

/** Понятное сообщение по-русски и что делать дальше. */
export function problemNote(problem: VoiceProblem, voiceOnly: boolean): string {
  return voiceOnly
    ? `${PROBLEM[problem]} В этом занятии доклад только голосом — сообщите преподавателю.`
    : `${PROBLEM[problem]} Доложите вариантом ответа.`;
}

export interface RecorderEnvironment {
  readonly secureContext: boolean;
  readonly mediaDevices: boolean;
  readonly mediaRecorder: boolean;
}

/** Можно ли вообще записать фразу; `null` — можно. */
export function environmentProblem(
  env: RecorderEnvironment,
): VoiceProblem | null {
  if (!env.mediaRecorder || !env.mediaDevices) return "no_recorder";
  if (!env.secureContext) return "insecure";
  return null;
}

/** Ошибка getUserMedia → причина: нет устройства или нет разрешения. */
export function accessProblem(error: unknown): VoiceProblem {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name: unknown }).name)
      : "";
  return name === "NotFoundError" || name === "OverconstrainedError"
    ? "no_device"
    : "denied";
}

/** Ответ сервера распознавания (схема `VoiceReport`). */
/** Громкость фразы по оценке сервера (evalcore.loudness). */
export type Loudness = "quiet" | "ok" | "loud";

export interface Recognition {
  readonly text: string;
  /** Нет или null — сервер громкость не меряет. */
  readonly loudness?: Loudness | null;
  readonly choice: Exclude<ReportChoice, "extra"> | null;
  /** Прозвучавшие части; нет — сервер до DT-11, части выводятся из вида. */
  readonly parts?: readonly ReportPart[];
  /** Похожая улица (TC-03): адрес прозвучал, улицу легко спутать — переспрос по буквам. */
  readonly spell_street?: string | null;
  /** Чего не хватило в адресе и поводе; нет — сервер до 17.10, спрашивается адрес. */
  readonly address_gap?: AddressGap | null;
}

/** Итог одной фразы. */
export type VoiceOutcome =
  | {
      readonly kind: "heard";
      readonly text: string;
      readonly choice: ReportChoice;
      readonly parts: readonly ReportPart[];
      readonly loudness: Loudness | null;
      /** Улица, с которой легко спутать улицу карточки; `null` — переспрашивать не нужно. */
      readonly spellStreet: string | null;
      /** Чего не хватило в адресе и поводе; `null` — часть прозвучала или не известно. */
      readonly addressGap: AddressGap | null;
    }
  /**
   * Речь есть, но уверенность ниже порога (TC-04): текст показывается в поле правки, а не
   * бракуется — обучаемый проверяет его и нажимает Enter. Переспрос не штрафуется.
   */
  | { readonly kind: "check"; readonly text: string }
  /** Пусто или сбой связи — служба переспрашивает. */
  | { readonly kind: "unclear" }
  /** Распознавание выключено на сервере — голосом в этом занятии не доложить. */
  | { readonly kind: "off" };

export function recognitionOutcome(
  status: number,
  body: Recognition | undefined,
): VoiceOutcome {
  if (status === 503) return { kind: "off" };
  if (status >= 200 && status < 300 && body?.choice && body.text.trim())
    return {
      kind: "heard",
      text: body.text.trim(),
      choice: body.choice,
      parts: body.parts ?? partsOf(body.choice),
      loudness: body.loudness ?? null,
      spellStreet: body.spell_street ?? null,
      addressGap: body.address_gap ?? null,
    };
  // Текст есть, доклада нет: уверенность ниже порога (сервер ставит choice только уверенным).
  if (status >= 200 && status < 300 && body && !body.choice && body.text.trim())
    return { kind: "check", text: body.text.trim() };
  return { kind: "unclear" };
}

/**
 * Прежние фразы доклада в звонке — одним текстом для сервера (`earlier`): доклад
 * складывается за звонок, части ищутся в сумме фраз. Нет фраз — `null`.
 */
export function earlierText(said: readonly string[]): string | null {
  const text = said
    .map((phrase) => phrase.trim().replace(/[.!?]+$/, ""))
    .filter(Boolean)
    .join(". ");
  return text || null;
}

/** Подсказка у поля правки распознанного (TC-04, docs/competitors/touches.md, п. 12). */
export const CHECK_NOTE = "Проверьте адрес и нажмите Enter";
/** Поле правки: сообщение, если поправленный текст не дошёл до сервера. */
export const CHECK_RETRY_NOTE = "Не удалось отправить. Нажмите Enter ещё раз.";

/** Что копится за звонок при распознавании фраз доклада. */
export interface PhraseState {
  /** Нераспознанных фраз — уходит в отбой (`voice_failures`). */
  readonly failures: number;
  /** Распознанное с низкой уверенностью, ждёт проверки в поле правки; `null` — нечего. */
  readonly draft: string | null;
}

/**
 * Состояние после очередной фразы. Штрафует только фраза без речи (`unclear`): неуверенно
 * распознанное (`check`) — переспрос, он не попадает ни в счётчик, ни в разбор.
 */
export function afterPhrase(
  state: PhraseState,
  outcome: VoiceOutcome,
): PhraseState {
  if (outcome.kind === "heard") return { ...state, draft: null };
  if (outcome.kind === "check") return { ...state, draft: outcome.text };
  if (outcome.kind === "unclear")
    return { failures: state.failures + 1, draft: null };
  return state;
}

/** Статус взведённого нажатия: запись начнётся сама по концу реплики (HQ-052). */
export const ARMED_STATUS = "запись начнётся после реплики";

/** Состояние микрофона, как его видит обучаемый. */
export type MicStage = "idle" | "recording" | "recognizing";

/**
 * Статус микрофона словами (TC-04): «слушаю», «распознаю…», «собеседник говорит».
 * Полудуплекс: пока собеседник говорит, запись не идёт — об этом и статус. `null` — микрофон
 * свободен, говорить можно.
 */
export function micStatus(
  stage: MicStage,
  peerSpeaking: boolean,
  armed = false,
  elapsedMs?: number,
): string | null {
  if (stage === "recording" && elapsedMs !== undefined) {
    const elapsed = Math.floor(
      Math.max(0, Math.min(elapsedMs, MAX_PHRASE_MS)) / 1000,
    );
    return `Идёт запись · ${elapsed} / ${MAX_PHRASE_MS / 1000} с`;
  }
  if (stage === "recording") return "слушаю";
  if (stage === "recognizing") return "распознаю…";
  // Нажатие «говорить» во время реплики принято и ждёт её конца (HQ-052).
  if (armed && peerSpeaking) return ARMED_STATUS;
  return peerSpeaking ? "собеседник говорит" : null;
}

/**
 * Можно ли начать запись: свободный микрофон и собеседник молчит (полудуплекс) или
 * договорит меньше чем через секунду (`leftMs`, HQ-052; `null` — конец реплики неизвестен).
 */
export function canStartRecording(
  stage: MicStage,
  peerSpeaking: boolean,
  leftMs: number | null = null,
): boolean {
  return stage === "idle" && peerAlmostDone(peerSpeaking, leftMs);
}

/**
 * Показывать ли варианты ответа. «Только голос» у преподавателя — никогда. Иначе они
 * свёрнуты за кнопкой «По частям» и раскрываются сами, когда голосом не
 * доложить: нет микрофона, распознавание выключено или две фразы подряд не расслышаны.
 */
export function choicesShown(input: {
  readonly voiceOnly: boolean;
  readonly problem: VoiceProblem | null;
  readonly failures: number;
  readonly opened: boolean;
}): boolean {
  if (input.voiceOnly) return false;
  return (
    input.opened ||
    input.problem !== null ||
    input.failures >= MAX_VOICE_FAILURES
  );
}

/** Подсказка после нераспознанной фразы. */
export function unclearNote(failures: number, voiceOnly: boolean): string {
  if (failures < MAX_VOICE_FAILURES) return "Повторите доклад голосом.";
  return voiceOnly
    ? "Голос снова не распознан. Говорите ближе к микрофону, чётко и без пауз."
    : "Голос снова не распознан. Выберите вариант доклада ниже или повторите голосом.";
}

/** Тише этого — тишина на индикаторе громкости, дБ полной шкалы. */
export const LEVEL_FLOOR_DB = -60;
/** Громкая речь у микрофона — полная шкала индикатора, дБ полной шкалы. */
export const LEVEL_CEIL_DB = -10;

/**
 * Громкость фразы для индикатора: среднеквадратичное отсчётов в децибелах, разложенное
 * на 0…1 между `LEVEL_FLOOR_DB` и `LEVEL_CEIL_DB`. По децибелам, а не по амплитуде:
 * тихая речь иначе почти не двигает полосу.
 */
export function speechLevel(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  const level = (db - LEVEL_FLOOR_DB) / (LEVEL_CEIL_DB - LEVEL_FLOOR_DB);
  return Math.min(1, Math.max(0, level));
}

/** Подсказка после фразы, сказанной слишком тихо или громко; в норме — ничего. */
export function loudnessNote(loudness: Loudness | null): string | null {
  if (loudness === "quiet")
    return "Вас едва слышно — говорите громче или ближе к микрофону.";
  if (loudness === "loud")
    return "Слишком громко — голос перегружает микрофон, говорите спокойнее.";
  return null;
}
