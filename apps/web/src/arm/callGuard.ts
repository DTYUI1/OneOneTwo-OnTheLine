// Идущий разговор софтфона — один на АРМ. Переход к другому происшествию посреди
// разговора его обрывает, поэтому перед переходом АРМ спрашивает и сам кладёт трубку.
// Модульное состояние, а не контекст: софтфон живёт внутри карточки, а переход
// начинается во вкладках и реестре — снаружи неё.

export interface ActiveCall {
  cardId: string;
  /** Кому звонят — для вопроса «Разговор с … будет завершён». */
  label: string;
  hangup: () => Promise<void>;
}

let active: ActiveCall | null = null;

export function setActiveCall(call: ActiveCall | null): void {
  active = call;
}

/** Звонок, который оборвётся при переходе к карточке `cardId`; null — переходить можно. */
export function callInterruptedBy(cardId: string | null): ActiveCall | null {
  return active && active.cardId !== cardId ? active : null;
}
