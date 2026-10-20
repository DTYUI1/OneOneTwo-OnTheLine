// Чужие службы на полосе служб (TC-07, «Живая смена»; contracts/C01_INTERFACES.md). Статус
// чужой службы контракт не передаёт, поэтому мир здесь — расписание: служба получает
// карточку, принимает её, а две из трёх затем начинают реагирование; третья остаётся
// «Принята» — бригады у неё пока нет. Только вид: оценка и журнал карточки этого не знают.
import type { Card } from "../shared/api";

type CardState = Card["state"];

/** Шаг чужой службы: статус и с какого момента он стоит. */
export interface ServiceStep {
  readonly state: CardState;
  readonly atMs: number;
}

/** FNV-1a, 32 бита: один и тот же сдвиг у всех экранов для пары «карточка, служба». */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/** Расписание чужой службы от появления карточки — все шаги, включая «Добавлена». */
export function otherServiceSteps(
  cardId: string,
  serviceId: string,
  appearedMs: number,
): ServiceStep[] {
  const h = hash(`${cardId}:${serviceId}`);
  const received = appearedMs + (8 + (h % 12)) * 1000;
  const accepted = received + (10 + ((h >>> 4) % 25)) * 1000;
  const steps: ServiceStep[] = [
    { state: "added", atMs: appearedMs },
    { state: "received", atMs: received },
    { state: "accepted", atMs: accepted },
  ];
  if ((h >>> 9) % 3 !== 0)
    steps.push({
      state: "responding",
      atMs: accepted + (30 + ((h >>> 12) % 60)) * 1000,
    });
  return steps;
}

/** Статус чужой службы на момент `nowMs`: последний наступивший шаг расписания. */
export function otherServiceStatus(
  cardId: string,
  serviceId: string,
  appearedAt: string,
  nowMs: number,
): ServiceStep {
  const steps = otherServiceSteps(cardId, serviceId, Date.parse(appearedAt));
  return steps.filter((step) => step.atMs <= nowMs).at(-1) ?? steps[0];
}
