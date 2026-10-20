// Свои наборы номеров служб по карточке — запасной признак «служба вызвана», пока выдача
// обучения (опрос раз в 2 с) не принесла звонок (`CardTraining.service_calls`,
// `delivery.service_called_at`). Живёт на уровне модуля, а не компонента: удержание и
// переход между линиями открывают окно карточки заново, а набор должен помниться.
import { LOCAL_DIAL_TRUST_MS, type ServiceDial } from "./logic";

const log = new Map<string, ServiceDial[]>();

/** Окно набрало номер службы `service` по карточке; `at` — время сервера. */
export function noteServiceDial(
  cardId: string,
  service: string,
  at: number,
): void {
  // Старые наборы уже не нужны: дальше верна только выдача.
  const kept = (log.get(cardId) ?? []).filter(
    (dial) => at - dial.at <= LOCAL_DIAL_TRUST_MS,
  );
  log.set(cardId, [...kept, { service, at, local: true }]);
}

export function localServiceDials(cardId: string): readonly ServiceDial[] {
  return log.get(cardId) ?? [];
}
