// Звонок отдела контроля реагирования (TC-07; памятка ДДС, с. 26–28): карточка дольше срока
// без «Принята» или «Не принята» — специалист звонит и просит пояснить причину. Чистые
// правила окна телефона и разбора; звонок и пояснение — CardTraining.control.
import type { components } from "../../api-client/schema";
import { formatDuration } from "../cardModel";
import { bankText } from "../softphone/bank";
import { PROBLEM, type VoiceProblem } from "../softphone/voiceReport";

export type ControlCall = components["schemas"]["ControlCall"];

/** Кто звонит: подпись строки входящего и шапки разговора. */
export const CONTROL_NAME = "Отдел контроля реагирования";
/** Номер вызова — Служба 112 (contracts/C01_INTERFACES.md, «Живая смена»). */
export const CONTROL_EXT = "112";
/**
 * Вопрос и отбой отдела контроля — фразы банка озвучки голосом общего дежурного (номер 112:
 * один абонент — один голос, проверка 17.10). Номер карточки и время — в подписи окна.
 */
export const CONTROL_ASK_ID = "OFFICIAL.control_ask.any.1";
export const CONTROL_BYE_ID = "OFFICIAL.end_call.any.3";
/** Сколько звучит отбой, прежде чем отдел контроля положит трубку. */
export const CONTROL_HANGUP_MS = 2500;

/** «1:05» — сколько карточка была без статуса. */
export function clock(seconds: number): string {
  return formatDuration(Math.round(seconds), { compact: true });
}

/** Вызов звонит: ещё не отвечен и не кончился. */
export function ringing(control: ControlCall | null | undefined): boolean {
  return Boolean(
    control && control.answered_at === null && control.ended_at === null,
  );
}

/** Отдел контроля больше не перезванивает: пропуск остаётся на значке и в окне. */
export function missed(control: ControlCall | null | undefined): boolean {
  return Boolean(
    control &&
      control.answered_at === null &&
      control.ended_at !== null &&
      control.end_reason === "missed",
  );
}

/** Разговор идёт: отвечен и не кончился. */
export function talking(control: ControlCall | null | undefined): boolean {
  return Boolean(
    control && control.answered_at !== null && control.ended_at === null,
  );
}

/** Вопрос отдела контроля — фраза банка. */
export function controlQuestion(): string {
  return bankText(CONTROL_ASK_ID);
}

/** Подпись разговора: сколько карточка без статуса (не реплика, её не произносят). */
export function controlWaited(withoutStatusS: number): string {
  return `Карточка без статуса ${clock(withoutStatusS)}.`;
}

/** Отбой отдела контроля после пояснения. */
export function controlBye(): string {
  return bankText(CONTROL_BYE_ID);
}

/**
 * Строка разбора: сколько карточка была без статуса и что ответил диспетчер. На балл не
 * влияет — опоздание со статусом уже считает критерий реакции.
 */
export function controlReview(
  control: ControlCall | null | undefined,
): string | null {
  if (!control) return null;
  const head = `Отдел контроля звонил: карточка была без статуса ${clock(control.without_status_s)}.`;
  if (control.reply)
    return `${head} Ваше пояснение${control.reply.mode === "voice" ? " голосом" : ""}: «${control.reply.text}».`;
  if (control.answered_at === null && control.ended_at !== null)
    return `${head} Вызов остался без ответа.`;
  if (control.answered_at !== null) return `${head} Пояснения не было.`;
  return head;
}

/** Пояснение под кнопкой: голосом не вышло — вариантом; фразу не расслышали — ещё раз. */
export function controlNote(
  problem: VoiceProblem | null,
  unclear: boolean,
): string | null {
  if (problem) return `${PROBLEM[problem]} Выберите вариант пояснения.`;
  if (unclear)
    return "Пояснение не расслышано. Повторите голосом или выберите вариант.";
  return null;
}
