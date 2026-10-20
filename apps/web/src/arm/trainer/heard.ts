// «Услышано по телефону» (TC-05, docs/competitors/touches.md, «Входящий доклад бригады», п. 4):
// статус, который старший бригады назвал словами («Работы закончены», «Прибыли»), всплывает в
// подсказке «Вместе» у строки статуса с кнопкой «Подставить». Подставляет его обучаемый сам — нажатием;
// строка статусов АРМ без нажатия не меняется, статус уходит только по «Подтвердить».
//
// Называет — значит сказал прямо: «работы завершены», «на месте». Обстановку («участники
// разъехались», «работ не было») тренажёр за обучаемого не переводит в статус: это и есть
// его работа (ловушка «Отказ от выполнения работ» сценария 102, docs/dds_gameplay.md, раздел 8).
import type { DispatcherStatus } from "../cardModel";

// Границы слова для кириллицы: `\b` в JavaScript знает только латиницу.
const B = "(?<![а-яё])";
const E = "(?![а-яё])";
const word = (body: string) => new RegExp(`${B}(?:${body})${E}`, "iu");

/** Статус → как его называет старший. Порядок — от позднего: «закончили» важнее «на месте». */
const NAMED: readonly (readonly [DispatcherStatus, RegExp])[] = [
  ["refused", word("отказ от выполнения работ")],
  [
    "completed",
    word(
      "работы (?:завершены|закончены|завершили|закончили)|(?:завершили|закончили) работы",
    ),
  ],
  // «Всё, закончили.», «Закончили.» — в начале фразы.
  ["completed", new RegExp(`(?:^|[.!?]\\s*)(?:всё,\\s*)?закончили${E}`, "iu")],
  ["working", word("(?:приступили|приступаем) к работ[аеу]?м?|начали работы")],
  // «Прибыли.», «Экипаж на месте», «На месте, …» — но не «машин на месте нет», не «едем, на
  // месте доложу» и не «газовая служба прибыла» (прибыл не тот, кто докладывает).
  [
    "arrived",
    new RegExp(
      `(?:^|[.!?]\\s*)(?:прибыли${E}|на месте[.,])|${B}(?:экипаж|бригада|расч[её]т|наряд)\\s+на месте${E}`,
      "iu",
    ),
  ],
  [
    "responding",
    word(
      "выезжаем|выехали|выехало|выехала|выдвигаемся|выдвигается|направляется",
    ),
  ],
];

/** Статус, который фраза называет прямо; null — не называет. */
export function namedStatus(text: string): DispatcherStatus | null {
  const found = NAMED.find(([, pattern]) => pattern.test(text));
  return found ? found[0] : null;
}

/** Реплика бригады на карточке (CardTraining.messages[]): что сказано и когда прозвучало. */
export interface HeardMessage {
  readonly state: string;
  readonly presented_at?: string | null;
  readonly delivery: { readonly message: { readonly text: string } };
}

/**
 * Что показать строкой «Услышано по телефону»: статус из последней прозвучавшей реплики, если
 * его сейчас можно поставить (`available`) и он ещё не выбран в строке статуса (`chosen`).
 */
export function heardStatus(
  messages: readonly HeardMessage[],
  available: readonly DispatcherStatus[],
  chosen: DispatcherStatus | "",
): DispatcherStatus | null {
  const last = messages
    .filter((item) => item.state === "presented" && item.presented_at)
    .reduce<HeardMessage | null>(
      (latest, item) =>
        !latest || (item.presented_at ?? "") >= (latest.presented_at ?? "")
          ? item
          : latest,
      null,
    );
  if (!last) return null;
  const named = namedStatus(last.delivery.message.text);
  if (!named || !available.includes(named) || named === chosen) return null;
  return named;
}
