// Подсказка «нулевого уровня» к телефону (FR-1.6): что происходит сейчас и что
// можно сделать. Текст зависит от ситуации, а не описывает телефон целиком —
// человек открывает подсказку, когда не понимает именно этот момент.
//
// Подсказка ничего не обещает сверх того, что знает АРМ: сколько докладов
// будет у бригады, знает только сервер.

import type { Refusal } from "./machine";

export interface PhoneSituation {
  /** Занятие завершено: новых действий нет. */
  readonly finished: boolean;
  readonly call: "idle" | "dialing" | "ringing" | "talking" | "ended";
  /** Вызов сброшен до ответа. */
  readonly aborted: boolean;
  /** Кому звоним: служба или бригада; `null`, если номер не из справочника. */
  readonly callee: string | null;
  readonly withBrigade: boolean;
  /** Бригада не направлена на это происшествие и отвечает отказом (28.09). */
  readonly refusal: Refusal | null;
  /** Что делать после отказа — тот же текст, что под телефоном (`refusalNote`). */
  readonly refusalAdvice: string | null;
  /** Решение по карточке принято: бригаду можно направить. */
  readonly decided: boolean;
  readonly panelOpen: boolean;
  readonly brigadesAvailable: boolean;
  readonly brigadesSent: number;
  readonly reportsAccepted: number;
  /** Выданный, но ещё не засчитанный доклад и как он пришёл. */
  readonly report: "none" | "audio" | "text";
}

export interface PhoneHint {
  /** Что происходит — одной фразой. */
  readonly now: string;
  /** Что можно сделать дальше. */
  readonly next: string;
}

const TO_COMMENT = "Перенесите главное в комментарий к статусу карточки.";

function refusalNow(refusal: Refusal): string {
  return refusal === "busy"
    ? "Бригада отказала: она занята на другом происшествии."
    : "Бригада отказала: на это происшествие она не направлена.";
}

export function phoneHint(s: PhoneSituation): PhoneHint {
  const reports = s.reportsAccepted > 0;

  if (s.finished)
    return {
      now: "Занятие завершено.",
      next: reports
        ? "Звонить больше нельзя. Доклады бригад остаются под телефоном."
        : "Звонить больше нельзя.",
    };

  if (s.call === "dialing" || s.call === "ringing")
    return {
      now: s.callee ? `Идёт вызов: ${s.callee}.` : "Идёт вызов.",
      next: "Ждите ответа. Передумали — «Положить трубку».",
    };

  if ((s.call === "talking" || (s.call === "ended" && !s.aborted)) && s.refusal)
    return {
      now: refusalNow(s.refusal),
      next: s.refusalAdvice ?? "Доклада по этому звонку не будет.",
    };

  if (s.call === "talking" && s.withBrigade) {
    if (s.report === "audio")
      return {
        now: "Бригада докладывает.",
        next: "Дослушайте: доклад засчитывается, только когда прозвучал целиком.",
      };
    if (s.report === "text")
      return {
        now: "Бригада прислала доклад текстом.",
        next: "Прочитайте его и ответьте «Принял» в окне разговора.",
      };
    return {
      now: s.callee ? `На связи: ${s.callee}.` : "На связи бригада.",
      next: reports
        ? `Принятые доклады — под телефоном. ${TO_COMMENT}`
        : "Ждите: бригада доложит обстановку.",
    };
  }

  if (s.call === "talking")
    return {
      now: s.callee ? `На связи: ${s.callee}.` : "Абонент на связи.",
      next: s.decided
        ? "Сообщите, что случилось и где. После паузы адресат подтвердит приём. Если микрофона нет — «Положить трубку». О выезде докладывает направленная бригада по прямому номеру."
        : "Общий адресат подтвердит доклад после паузы. Для выезда поставьте статус «Принята», направьте бригаду и позвоните ей по прямому номеру.",
    };

  if (s.call === "ended")
    return {
      now: s.aborted ? "Вызов сброшен." : "Разговор завершён.",
      next: reports
        ? `Доклады бригад — под телефоном. ${TO_COMMENT}`
        : "Позвонить снова — выберите службу или наберите номер в панели телефона.",
    };

  // Линия свободна.
  if (reports)
    return { now: "Доклады бригад — под телефоном.", next: TO_COMMENT };
  if (s.brigadesSent > 0)
    return {
      now: "Бригады направлены, но ещё не докладывали.",
      next: "Позвоните бригаде — доклад придёт во время разговора.",
    };
  if (!s.panelOpen)
    return {
      now: "Линия свободна.",
      next: "Нажмите «Телефон»: откроются список служб и набор номера.",
    };
  if (s.brigadesAvailable && !s.decided)
    return {
      now: "Линия свободна.",
      next: "Бригаду направляют после решения: поставьте статус «Принята». Позвонить службе можно сразу.",
    };
  return {
    now: "Линия свободна.",
    next: s.brigadesAvailable
      ? "Выберите службу слева или наберите номер справа. Бригады отмечаются ниже."
      : "Выберите службу слева или наберите номер справа.",
  };
}
