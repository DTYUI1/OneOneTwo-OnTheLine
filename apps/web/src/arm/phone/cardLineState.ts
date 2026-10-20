// Разговор финальной смены в окне телефона (HQ-033, решение 18.10; `CardLine.tsx`): когда он
// начинается, сколько живёт софтфон карточки без открытой карточки и что он не обрывает.

/** Софтфон карточки, работающий в окне телефона без открытой карточки. */
export interface PhoneLine {
  readonly cardId: string;
  /** Какая карточка была открыта, когда ответили: переход к другой — уже действие обучаемого. */
  readonly openedAt: string | null;
  /** Разговор уже шёл: его конец отпускает линию. */
  readonly talked: boolean;
}

/**
 * Ответ из окна телефона ведётся там же, без открытия карточки, — только в финальной смене
 * (`brigadeOnly`, `settings.final_shift`): вне её, как прежде, открывается карточка вызова.
 * Карточка вызова уже открыта — разговор ведёт её софтфон, без переноса в окно телефона
 * (снятие трубки не перезапускает софтфон).
 */
export function talksInPhone(
  cardId: string,
  brigadeOnly: ReadonlySet<string>,
  openedId: string | null,
): boolean {
  return brigadeOnly.has(cardId) && openedId !== cardId;
}

/** Шёл ли разговор: таймер окна телефона (`PhoneCall`) есть, пока звонок идёт. */
export function noteTalk(line: PhoneLine, callActive: boolean): PhoneLine {
  return callActive && !line.talked ? { ...line, talked: true } : line;
}

/**
 * Пора ли вернуть софтфон открытой карточке. Пока разговор идёт — нет. После него (или если
 * обучаемый перешёл к другой карточке, а разговор так и не начался) — когда открыта другая
 * карточка: ей нужна своя связь. В реестре и в той же карточке окно оставляет ленту
 * разговора на виду — по ней ищут карточку по номеру бригады.
 */
export function lineReleased(
  line: PhoneLine,
  callActive: boolean,
  openedId: string | null,
): boolean {
  if (callActive) return false;
  const moved = openedId !== line.openedAt;
  return (
    (line.talked || moved) && openedId !== null && openedId !== line.cardId
  );
}

/**
 * Переход к другой карточке обрывает идущий разговор — кроме разговора в окне телефона:
 * его ведёт не карточка, и искать карточку вызова посреди разговора — задача обучаемого.
 */
export function interruptsCall(
  call: { readonly cardId: string } | null,
  line: PhoneLine | null,
): boolean {
  return call !== null && call.cardId !== line?.cardId;
}

/**
 * Ведёт ли окно телефона (контакты, табло сил, набор) софтфон открытой карточки. Нет, пока
 * окно занято линией другой карточки (`lineTaken`: от ответа — пока софтфон линии ждёт
 * сведений, чтобы снять трубку, — до отбоя или удержания): набор из контактов пошёл бы по
 * открытой карточке посреди разговора по линии.
 */
export function openedInPhone(
  lineCardId: string | null,
  lineTaken: boolean,
): boolean {
  return lineCardId === null || !lineTaken;
}
