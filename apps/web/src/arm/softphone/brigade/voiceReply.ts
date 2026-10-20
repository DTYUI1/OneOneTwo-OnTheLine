// Ответ бригаде голосом (DT-16): чистые правила без браузера и сети — как у доклада службе
// (voiceReport.ts). Голос — основной путь, варианты ответа реплики — запасной в том же
// разговоре. Фразу распознаёт сервер (POST /calls/{id}/voice-reply) и сводит её к одному
// из вариантов (evalcore.voice_reply); вариант уходит тем же `brigade_reply`, что кнопка.

import { brigadePhrase, brigadePhrases } from "../bank";
import { parseServiceIntent } from "./serviceIntent";
import { SYSTEM_112, type AwaitedService } from "./logic";
import {
  MAX_VOICE_FAILURES,
  PROBLEM,
  type Loudness,
  type VoiceProblem,
} from "../voiceReport";

/** Как дан ответ бригаде: так он и попадает в разбор («голосом» / «вариантом»). */
export interface ReplyHow {
  readonly mode: "voice" | "option";
  /** Распознанный текст ответа голосом. */
  readonly text?: string;
  readonly loudness?: "quiet" | "ok" | "loud" | null;
  /** Фраз на этот вопрос, которые бригада не поняла. */
  readonly voiceFailures?: number;
}

/** Поля способа ответа в `brigade_reply`: пустые не отправляются. */
export function replyHowPayload(how: ReplyHow | undefined): {
  mode?: "voice" | "option";
  text?: string;
  loudness?: "quiet" | "ok" | "loud" | null;
  voice_failures?: number;
} {
  if (!how) return {};
  return {
    mode: how.mode,
    ...(how.mode === "voice" && how.text
      ? { text: how.text.slice(0, 1000) }
      : {}),
    ...(how.mode === "voice" && how.loudness !== undefined
      ? { loudness: how.loudness }
      : {}),
    ...(how.voiceFailures
      ? { voice_failures: Math.min(how.voiceFailures, 100) }
      : {}),
  };
}

/**
 * Что бригада службы отвечает на фразу, которую не расслышала или не поняла. Ответы бригады —
 * фразы банка озвучки её службы (GP-25, `../bank.ts`): у 103 голос женский — «Не поняла».
 */
export function notUnderstood(service: string | null | undefined): string {
  return brigadePhrase(service, "not_understood");
}

/** Ответ сервера (схема `VoiceReply`). */
export interface ReplyRecognition {
  readonly text: string;
  readonly option_key: string | null;
  readonly loudness?: Loudness | null;
  /** Фразу мир засчитает поправкой повтора адреса (HQ-024): ответит бригада репликой ветки. */
  readonly world_answers?: boolean;
}

/** Итог одной фразы ответа. */
export type ReplyOutcome =
  | {
      readonly kind: "heard";
      readonly text: string;
      readonly optionKey: string;
      readonly loudness: Loudness | null;
    }
  /**
   * Не расслышано или не сопоставлено с вариантом — бригада переспрашивает. Громкость
   * есть, если речь услышана: подсказка «громче / тише» пригодится и тут.
   */
  | { readonly kind: "unclear"; readonly loudness: Loudness | null }
  /**
   * В записи ничего не сказано (пробел нажат случайно, тишина): бригада не отвечает «Не понял,
   * повторите» — переспрос на пустом месте только шумит (проверка 17.10).
   */
  | { readonly kind: "silence"; readonly loudness: Loudness | null }
  /**
   * Фраза бригаде без вопроса (DT-19): распознана, бригада ответит по `brigadeAnswer`.
   * `worldAnswers` — фраза поправляет повтор адреса (HQ-024): ответ — реплика ветки мира
   * («Понял, …, едем»), окно телефона своего не даёт.
   */
  | {
      readonly kind: "said";
      readonly text: string;
      readonly loudness: Loudness | null;
      readonly worldAnswers: boolean;
    }
  /** Распознавание выключено на сервере — голосом в этом занятии не ответить. */
  | { readonly kind: "off" };

export function replyOutcome(
  status: number,
  body: ReplyRecognition | undefined,
  /** Варианты реплики; `null` — фраза без вопроса, сопоставлять не с чем. */
  options: readonly { readonly key: string }[] | null,
): ReplyOutcome {
  if (status === 503) return { kind: "off" };
  const ok = status >= 200 && status < 300 && body !== undefined;
  if (ok && !body.text.trim())
    return { kind: "silence", loudness: body.loudness ?? null };
  if (options === null)
    return ok && body.text.trim()
      ? {
          kind: "said",
          text: body.text.trim(),
          loudness: body.loudness ?? null,
          worldAnswers: body.world_answers ?? false,
        }
      : { kind: "unclear", loudness: ok ? (body.loudness ?? null) : null };
  const key = ok ? body.option_key : null;
  // Вариант должен быть из этой реплики: ответ на старую реплику сюда не годится.
  if (ok && key && body.text.trim() && options.some((item) => item.key === key))
    return {
      kind: "heard",
      text: body.text.trim(),
      optionKey: key,
      loudness: body.loudness ?? null,
    };
  return { kind: "unclear", loudness: ok ? (body.loudness ?? null) : null };
}

/** Голосом не ответить — понятное сообщение и что делать дальше. */
export function replyProblemNote(
  problem: VoiceProblem,
  voiceOnly: boolean,
): string {
  return voiceOnly
    ? `${PROBLEM[problem]} В этом занятии отвечают только голосом — сообщите преподавателю.`
    : `${PROBLEM[problem]} Ответьте бригаде вариантом.`;
}

/** Подсказка после фразы, которую бригада не поняла. */
export function replyUnclearNote(failures: number, voiceOnly: boolean): string {
  if (failures < MAX_VOICE_FAILURES) return "Повторите ответ голосом.";
  return voiceOnly
    ? "Голос снова не понят. Говорите ближе к микрофону, чётко и словами варианта."
    : "Голос снова не понят. Выберите вариант ответа ниже или повторите голосом.";
}

/** Просьба доложить: «доложите обстановку», «что у вас», «вы на месте?». */
const ASKS_REPORT =
  /доклад|доложи|обстановк|ситуаци|что у вас|как у вас|где вы|на месте|прибыл/i;

/** Слова-паразиты и звуки без смысла: «э-э», «мм», «а». Одни они — «не расслышала». */
const FILLER = /^(э+м*|м+|а+|у+|о+|хм+|гм+|эм+|ну|так)$/i;

/** Канонические номера в общем словаре → идентификаторы служб интерфейса. */
const serviceId = (ext: string): string =>
  ext === "105" ? "GKH" : ext === "106" ? "MOSLIFT" : ext;

export function calledService(text: string): string | null {
  return parseServiceIntent(text).services.map(serviceId)[0] ?? null;
}

export function saysCalled(text: string): boolean {
  return parseServiceIntent(text).called;
}

/**
 * О какой службе фраза «вызвана»: названная (`calledService`) или та, о которой бригада
 * просила (`awaited`, HQ-055: «отправил» после «сейчас вызову, ждите»). `null` — не о службе.
 * О просимой службе (без названия или названной) весть засчитывается только в окне сервера
 * (`awaited.opened`): до звонка в службу и после её приезда — `null`, обычный ответ. О
 * службе, которую не просили, — только после набора её номера или 112 (`awaited.called`,
 * GP-28): «скорую вызвал» до звонка — неправда. `awaited` нет — сведений о звонках нет,
 * судим по одной фразе.
 */
export function newsService(
  text: string,
  awaited: AwaitedService | null = null,
): string | null {
  const parsed = parseServiceIntent(text);
  const named = parsed.services.map(serviceId);
  if (awaited === null) return named[0] ?? null;
  const admissible = named.find((service) =>
    awaited.asked.includes(service)
      ? awaited.opened.includes(service)
      : awaited.called.includes(service) || awaited.called.includes(SYSTEM_112),
  );
  if (admissible) return admissible;
  // Явная посторонняя служба не становится ожидаемой из-за общего слова «вызвал».
  if (parsed.claims.some((claim) => claim.services.length)) return null;
  return awaited.open &&
    awaited.service &&
    parseServiceIntent(text, awaited.opened).called
    ? awaited.service
    : null;
}

/** Как бригада понимает фразу диспетчера вне своего вопроса (docs/dds_gameplay.md, раздел 4). */
export type PhraseKind =
  /** Пусто, шум, одни «э-э»: бригада не расслышала. */
  | "unclear"
  /** Просьба доложить: последний доклад разговора или «едем, доложу». */
  | "report_request"
  /** Служба вызвана: «пожарные выехали», «скорая едет» — «Понял, ждём пожарных» (GP-28). */
  | "service_called"
  /** Новые сведения или распоряжение: «в квартире ребёнок», «выезжайте» — «Принял». */
  | "info";

export function phraseKind(
  text: string,
  awaited: AwaitedService | null = null,
): PhraseKind {
  const words = text.match(/[\p{L}]+/gu) ?? [];
  const meaningful = words.filter(
    (word) => word.length >= 2 && !FILLER.test(word),
  );
  if (meaningful.length === 0) return "unclear";
  if (newsService(text, awaited) !== null) return "service_called";
  return ASKS_REPORT.test(text) ? "report_request" : "info";
}

/**
 * Ответ бригады на «служба вызвана» — фраза её книги места `service_coming` о названной
 * службе: «Понял, пожарных ждём…». Из нескольких — та, где служба названа тем же словом
 * («спасатели», а не «пожарные»). Фразы о такой службе в книге нет — «Принял».
 */
export function serviceComingAnswer(
  text: string,
  service: string | null | undefined,
  awaited: AwaitedService | null = null,
): string {
  const named = newsService(text, awaited);
  const phrases = brigadePhrases(service, "service_coming").filter(
    (phrase) => phrase.needs === named,
  );
  const clean = text.toLowerCase().replace(/ё/g, "е");
  const stems = (clean.match(/[\p{L}]+/gu) ?? [])
    .filter((word) => word.length >= 5)
    .map((word) => word.slice(0, 5));
  const same = phrases.find((phrase) =>
    stems.some((stem) =>
      phrase.text.toLowerCase().replace(/ё/g, "е").includes(stem),
    ),
  );
  return (same ?? phrases[0])?.text ?? brigadePhrase(service, "ack");
}

/**
 * Что бригада отвечает на фразу диспетчера вне своего вопроса (DT-19, GP-11, эталон — раздел
 * 4): на просьбу доложить — «Повторяю» и последний доклад этого разговора или «едем, доложу»,
 * на «служба вызвана» — «Понял, ждём пожарных» (GP-28), на новые сведения — «Принял», на
 * непонятное — «Не понял, повторите». Всё — фразы банка
 * службы. Сведения о мире бригада сама не выдумывает: их выдаёт сервер по плану сценария.
 */
export function brigadeAnswer(
  text: string,
  report: string | null,
  service: string | null | undefined,
  awaited: AwaitedService | null = null,
): string {
  const kind = phraseKind(text, awaited);
  if (kind === "unclear") return notUnderstood(service);
  if (kind === "service_called")
    return serviceComingAnswer(text, service, awaited);
  if (kind === "info") return brigadePhrase(service, "ack");
  if (report) return `${brigadePhrase(service, "repeat_report")} ${report}`;
  // Доклада ещё не было — фраза пути, где бригада обещает доложить.
  const enroute = brigadePhrases(service, "enroute");
  const promise = enroute.find((phrase) => /доложу/i.test(phrase.text));
  return promise?.text ?? brigadePhrase(service, "enroute");
}
