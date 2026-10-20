// Разговор, поставленный на удержание (вкладки линий телефона, проверка 17.10): что от него
// нужно сохранить, чтобы после снятия он шёл дальше, — лента, доклад службе и прозвучавшие
// части доклада. Софтфон карточки один и ведёт одну линию; удержанные линии живут снимками
// (`../phone/hold.ts`), а не отдельными софтфонами. Чистые функции без React.
import { BANK_BOOKS, OFFICIAL, bankAudio, type BankPhrase } from "./bank";
import type { LogLine } from "./callLog";
import type { AddressGap, ReportChoice, ReportPart } from "./report";
import type { Loudness, ReportMode } from "./voiceReport";

/** Доклад службе в звонке `callId` — уходит в его отбой (`call_hangup.report_*`). */
export interface ReportLog {
  readonly callId: string;
  readonly choices: readonly ReportChoice[];
  readonly modes: readonly ReportMode[];
  readonly parts: readonly (readonly ReportPart[])[];
  readonly loudness: readonly (Loudness | null)[];
  readonly voiceFailures: number;
  /** Номер регистрации, который назвал дежурный (TC-03). */
  readonly registration: string | null;
}

/** Поля доклада в `call_hangup`: по ним оценка видит, полным ли он был и как сказан. */
export function reportPayload(log: ReportLog) {
  return {
    report_choices: [...log.choices],
    report_modes: [...log.modes],
    report_parts: log.parts.map((parts) => [...parts]),
    report_loudness: [...log.loudness],
    voice_failures: log.voiceFailures,
    ...(log.registration ? { registration_number: log.registration } : {}),
  };
}

/** Что помнит линия на удержании, чтобы после снятия разговор шёл с того же места. */
export interface SavedTalk {
  /** Направление исходного звонка: входящий доклад и после удержания ждёт «Принял». */
  readonly inbound?: boolean;
  /** Лента разговора до удержания. */
  readonly lines: readonly LogLine[];
  /** Доклад службе: без него отбой после снятия ушёл бы без доклада. */
  readonly report: ReportLog | null;
  /** Части доклада, уже прозвучавшие в звонке: по частям спрашивают только остальные. */
  readonly said: readonly ReportPart[];
  /** Фразы доклада для `voice-report.earlier`: части не заменяют исходный текст. */
  readonly earlier?: readonly string[];
  /** Чего не хватило в адресе и поводе: `reason` — адрес прозвучал, по частям — без него. */
  readonly gap?: AddressGap | null;
}

/**
 * Должностное лицо снова на связи после удержания: фраза места `answer` его книги, которая
 * начинается с «Да,» («Да, слушаю.», «Да, пожарная охрана, слушаю.»), иначе первая. Своего текста нет.
 */
export function officialBackPhrase(book: string | null | undefined): {
  readonly text: string;
  readonly url: string | null;
} {
  const answers: readonly BankPhrase[] =
    BANK_BOOKS[book ?? OFFICIAL]?.slots.answer ??
    BANK_BOOKS[OFFICIAL]?.slots.answer ??
    [];
  const phrase =
    answers.find((item) => /^Да,/.test(item.text) && !item.only) ??
    answers.find((item) => !item.only) ??
    answers[0];
  return phrase
    ? { text: phrase.text, url: bankAudio(phrase.id) }
    : { text: "Да, слушаю.", url: null };
}
