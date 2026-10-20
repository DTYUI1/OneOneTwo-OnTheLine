// Входящий доклад бригады как настоящий (TC-01, docs/dds_touches.md): старший называет себя,
// докладывает и спрашивает «Как приняли?»; «Принял» диспетчера — подтверждение приёма
// (событие `report_confirmed`); молчание 8 с — «Диспетчер, слышите меня?» один раз за паузу.
// Реплики — фразы банка озвучки службы бригады (GP-25, `../bank.ts`), своих текстов нет.

import { brigadePhrase, brigadePhrases, type BrigadeSlot } from "../bank";
import { phraseKind } from "./voiceReply";

/** Тишина диспетчера после вопроса бригады, после которой она переспрашивает. */
export const NO_REPLY_MS = 8000;

/**
 * Фраза места разговора: та, что дословно названа в эталоне (touches.md), если она есть в
 * книге службы, иначе первая. Первая фраза места — самая нейтральная: «… на связи.»
 */
function phrase(
  service: string | null | undefined,
  slot: BrigadeSlot,
  preferred?: string,
): string {
  const found = preferred
    ? brigadePhrases(service, slot).find((item) => item.text === preferred)
    : undefined;
  return found?.text ?? brigadePhrase(service, slot);
}

/** Первая фраза старшего во входящем вызове: кто на связи (место `intro`). */
export function introPhrase(service: string | null | undefined): string {
  return phrase(service, "intro");
}

/** Конец доклада: подтвердите приём (место `confirm_request`). */
export function confirmRequestPhrase(
  service: string | null | undefined,
): string {
  return phrase(service, "confirm_request", "Как приняли?");
}

/** Диспетчер молчит после вопроса бригады (место `no_reply`). */
export function noReplyPhrase(service: string | null | undefined): string {
  return phrase(service, "no_reply", "Диспетчер, слышите меня?");
}

/**
 * Сняли с удержания (TC-02): старший снова на связи. «На связи, слушаю» из эталона
 * (touches.md) дословно в банке нет — звучит фраза места `answer` со словами «на связи»
 * («Да, диспетчер, на связи.»), иначе первая фраза места.
 */
export function backOnLinePhrase(service: string | null | undefined): string {
  return (
    brigadePhrases(service, "answer").find((item) =>
      /на связи/i.test(item.text),
    )?.text ?? brigadePhrase(service, "answer")
  );
}

/**
 * Снят с удержания: старший снова на связи (`backOnLinePhrase`). Ждал ответа на свой вопрос
 * с вариантами (`question` — его реплика) — повторяет вопрос (решение капитана 18.10, HQ-058);
 * ждал «Принял» на свой «Как приняли?» — переспрашивает его. Не говорит поверх вопроса
 * (прогон связности, `talks_over_question`; так же `app.tools.coherence.phone.resumed_phrase`).
 */
export function resumedPhrase(
  service: string | null | undefined,
  waitingConfirm: boolean,
  question: string | null = null,
): string {
  if (question) return question;
  return waitingConfirm
    ? confirmRequestPhrase(service)
    : backOnLinePhrase(service);
}

/** Фраза снятой с удержания бригады и её запись, если она не из книг банка. */
export interface ResumedSay {
  readonly text: string;
  /** Повтор вопроса — запись его реплики из сценария; фразы банка находятся по тексту. */
  readonly url: string | null;
  /** Повторённый вопрос (id выдачи): до ответа или срока бригада придерживает новость. */
  readonly repeated: string | null;
  /** Срок ответа на повторённый вопрос (мс); `null` — срока сервер не отдал. */
  readonly replyBy: number | null;
  /**
   * Вопрос, срок которого истёк на удержании (id выдачи): бригада его не повторила — кнопок
   * ответа на него в окне нет, ответа на непрозвучавший вопрос не будет.
   */
  readonly dropped: string | null;
}

/** Сказанное при снятии с удержания (`resumedSaid`) — с ключом этого снятия. */
export interface ResumedSaid extends ResumedSay {
  readonly key: string;
}

/** Вопрос бригады, на который она ждала ответа (`BrigadeQuestion`). */
interface AskedQuestion {
  readonly deliveryId: string;
  readonly text: string;
  readonly url: string | null;
  readonly replyBy: number | null;
}

/**
 * Что говорит бригада, снятая с удержания в миг `now` (`resumedPhrase`), с записью повтора
 * (решение капитана 18.10, HQ-058). Вопрос в своём сроке (`replyBy`, срок события) и без
 * ответа — повторяет его; новую реплику, выданную сервером за это время (он ждёт ответа
 * только `ANSWER_PAUSE`), придерживает до ответа или до срока (`holdsNews`). Срок истёк на
 * удержании (событие уже решено как пропущенное) — «на связи» и новость; вопрос не повторён,
 * ответить на него в окне нечем (`dropped`).
 */
export function resumedSay(
  service: string | null | undefined,
  waitingConfirm: boolean,
  question: AskedQuestion | null,
  now: number,
): ResumedSay {
  const due =
    question !== null && question.replyBy !== null && now >= question.replyBy;
  return question && !due
    ? {
        text: resumedPhrase(service, waitingConfirm, question.text),
        url: question.url,
        repeated: question.deliveryId,
        replyBy: question.replyBy,
        dropped: null,
      }
    : {
        text: resumedPhrase(service, waitingConfirm),
        url: null,
        repeated: null,
        replyBy: null,
        dropped: question?.deliveryId ?? null,
      };
}

/**
 * Бригада придерживает новую реплику (доклад, ответ) в миг `now`: после снятия с удержания она
 * повторила вопрос (`resumedSay`), он ещё без ответа (`open` — открытый вопрос звонка) и срок
 * ответа не прошёл (HQ-058). Так же `app.tools.coherence.runner` (`_holds_news`).
 */
export function holdsNews(
  said: ResumedSay | null,
  open: { readonly deliveryId: string } | null,
  now: number,
): boolean {
  if (!said?.repeated || open?.deliveryId !== said.repeated) return false;
  return said.replyBy === null || now < said.replyBy;
}

/**
 * Фраза снятия с удержания фиксируется в миг снятия (`key` — звонок и начало разговора после
 * снятия; новое удержание — новый ключ): ответ на вопрос, «Принял» или новый вопрос бригады
 * её уже не меняют — шапка окна и лента показывают то, что бригада сказала. `now` — что она
 * сказала бы сейчас; `null` — разговор не снят с удержания (или уже кончился).
 */
export function resumedSaid(
  prev: ResumedSaid | null,
  key: string,
  now: ResumedSay | null,
): ResumedSaid | null {
  if (prev?.key === key) return prev;
  return now === null ? null : { key, ...now };
}

/**
 * После реплики бригада спрашивает «Как приняли?»: только доклад во входящем вызове. Вопрос
 * бригады (варианты ответа) и её ответ на действие диспетчера (`answer`) подтверждения не ждут
 * (проверка 17.10). То же правило у сервера (`app.api.training.turns.asks_confirmation`): по нему
 * бригада ждёт «Принял», прежде чем говорить дальше. Примеры — `confirmRequest.cases.json`.
 */
export function asksConfirmation(input: {
  readonly inbound: boolean;
  readonly question: boolean;
  readonly answer: boolean;
}): boolean {
  return input.inbound && !input.question && !input.answer;
}

/** Подтверждение приёма: «Принял», «Понял», «Принято», «Записал». */
const CONFIRMS =
  /(?<!\p{L})(принял|приняла|принято|понял|поняла|записал|записала)(?!\p{L})/giu;

/**
 * Сказанное голосом на «Как приняли?» — подтверждение приёма? Просьба доложить («понял, а
 * где вы сейчас?») — не подтверждение: бригада на неё ответит как на любую фразу.
 */
export function confirmsReport(text: string): boolean {
  const kind = phraseKind(text);
  // «Принял, пожарные выехали» — и подтверждение, и сведения о службе (GP-28).
  if (kind !== "info" && kind !== "service_called") return false;
  return [...text.matchAll(CONFIRMS)].some((match) => {
    // Отрицание действует до глагола в той же клаузе, в том числе через «совсем»,
    // «всё», «до конца». Отдельное «не выезжайте» не отменяет «Принял».
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    return (
      !/(?<!\p{L})не(?!\p{L})[^,.;:!?…—\r\n]*$/iu.test(before) &&
      !/^\s*\?/.test(after)
    );
  });
}

/**
 * Ключ паузы, в которой бригада ждёт ответа диспетчера: `null` — не ждёт. Пауза новая, когда
 * бригада снова спросила или диспетчер что-то сказал, — тогда переспрос возможен снова.
 */
export function pauseKey(input: {
  /** Разговор с бригадой идёт. */
  readonly talking: boolean;
  /** Выдача доклада, о приёме которого спросила бригада; `null` — не спрашивала. */
  readonly asked: string | null;
  /** Сколько раз бригада спросила «Как приняли?» в этом разговоре. */
  readonly asks: number;
  /** Сколько фраз сказал диспетчер в этом разговоре. */
  readonly said: number;
}): string | null {
  if (!input.talking || input.asked === null) return null;
  return `${input.asked}:${input.asks}:${input.said}`;
}
