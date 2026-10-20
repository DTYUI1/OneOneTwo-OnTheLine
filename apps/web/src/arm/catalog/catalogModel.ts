// Каталог сценариев обучаемого (17.10): как показать проработанные сценарии — по службам,
// своя служба первой, и чему учит каждый сценарий простыми словами.
import type { components } from "../../api-client/schema";

export type PracticeScenario = components["schemas"]["PracticeScenario"];

/** Виды событий сценария (ScenarioEvent.kind) — словами обучаемого. */
export const TRAIN_LABELS: Readonly<Record<string, string>> = {
  readback_error: "ловушка повтора адреса",
  clarify: "уточнение",
  request_service: "просьба вызвать службу",
  silence: "молчание бригады",
  alarm: "тревога",
};

/** «Тренирует: …» — неизвестные виды (новее клиента) не показываем. */
export function trainsText(kinds: readonly string[]): string {
  const labels = kinds.flatMap((kind) =>
    TRAIN_LABELS[kind] ? [TRAIN_LABELS[kind]] : [],
  );
  return labels.join(", ");
}

export interface ServiceGroup {
  readonly serviceId: string;
  readonly serviceName: string;
  /** Служба обучаемого: её группа первая и подписана. */
  readonly own: boolean;
  readonly items: readonly PracticeScenario[];
}

/** Группы по службам в порядке сервера; своя служба — первой. */
export function groupByService(
  items: readonly PracticeScenario[],
  ownServiceId: string | null,
): ServiceGroup[] {
  const groups = new Map<string, PracticeScenario[]>();
  for (const item of items) {
    const group = groups.get(item.service_id);
    if (group) group.push(item);
    else groups.set(item.service_id, [item]);
  }
  const result = [...groups.values()].map((group) => ({
    serviceId: group[0].service_id,
    serviceName: group[0].service_name,
    own: group[0].service_id === ownServiceId,
    items: group,
  }));
  return [
    ...result.filter((group) => group.own),
    ...result.filter((group) => !group.own),
  ];
}
