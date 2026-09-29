// Правила связи с бригадами без React и сети: что набранный номер значит для
// сервера, в каком состоянии бригады и какие выданные сведения ещё не предъявлены.
//
// Главное ограничение: очередь событий карточки останавливается на первом отказе
// сервера (любой 4xx). Поэтому событие, которое сервер заведомо отклонит, сюда
// не доходит — решение принимается до набора, а не после ответа.
//
// Связь у диспетчера ДДС есть со всеми своими бригадами (28.09): номер бригады не
// «разблокируется» выбором. Ограничено направление — только свободная бригада и
// только после решения реагировать. Ненаправленная бригада на звонок отвечает отказом.

import type { components } from "../../../api-client/schema";
import type { CardState } from "../../cardModel";
import type { Refusal } from "../machine";

type Brigade = components["schemas"]["Brigade"];
type Service = components["schemas"]["Service"];
type CallTarget = components["schemas"]["CallTarget"];
type InformationEvidence = components["schemas"]["InformationEvidence"];

export type DialPlan =
  /** Номер службы: прежнее событие `call_dial`. */
  | { readonly kind: "service"; readonly service: Service }
  /** Прямой номер направленной сюда бригады: событие `call_dial_target`, она доложит. */
  | { readonly kind: "target"; readonly target: CallTarget }
  /**
   * Бригада своей ДДС, но на это происшествие не направлена. Звонок уходит тем же
   * `call_dial_target`: сервер его принимает и записывает тот же отказ
   * (`Call.refusal`), бригада отвечает отказом и не докладывает.
   */
  | {
      readonly kind: "refused";
      readonly target: CallTarget;
      readonly reason: Refusal;
      /** Номер происшествия, где бригада занята; `null` — она свободна. */
      readonly busyOn: string | null;
    }
  /** Номер не обслуживается: сервер ответил бы 422. */
  | { readonly kind: "unknown" };

export function planDial(
  phoneExt: string,
  services: readonly Service[],
  targets: readonly CallTarget[],
  selectedBrigadeIds: readonly string[],
  busy: ReadonlyMap<string, string> = new Map(),
): DialPlan {
  // Номер общего диспетчера совпадает с номером службы — это обычный звонок в службу.
  const target = targets.find(
    (item) =>
      item.is_active && item.brigade_id !== null && item.phone_ext === phoneExt,
  );
  if (target) {
    const brigadeId = target.brigade_id as string;
    if (selectedBrigadeIds.includes(brigadeId))
      return { kind: "target", target };
    const busyOn = busy.get(brigadeId) ?? null;
    return {
      kind: "refused",
      target,
      reason: busyOn === null ? "not_assigned" : "busy",
      busyOn,
    };
  }
  const service = services.find(
    (item) => item.is_active && item.phone_ext === phoneExt,
  );
  return service ? { kind: "service", service } : { kind: "unknown" };
}

export const UNKNOWN_NUMBER =
  "Номер не обслуживается. Проверьте его в справочнике.";

/**
 * Почему доклада не будет и что делать дальше — после отказа бригады. Один текст для
 * пояснения под телефоном и для подсказки «?»: они не должны советовать разное.
 * `listed` — бригада есть в списке панели; иначе направить её нельзя.
 */
export function refusalNote(
  plan: { readonly reason: Refusal; readonly busyOn: string | null },
  decided: boolean,
  listed = true,
): string {
  if (plan.reason === "not_assigned" && !listed)
    return "Эта бригада сейчас не в вашем распоряжении — доклада не будет. Направьте свободную бригаду из списка и позвоните ей.";
  if (plan.reason === "busy")
    return `Бригада занята на происшествии ${plan.busyOn ?? ""} — доклада не будет. Направьте свободную бригаду и позвоните ей.`;
  return decided
    ? "Бригада не направлена на это происшествие — доклада не будет. Отметьте её в списке бригад, нажмите «Направить выбранные» и позвоните снова."
    : "Бригада не направлена на это происшествие — доклада не будет. Сначала поставьте статус «Принята», затем направьте бригаду и позвоните снова.";
}

/** Состояние бригады на табло сил: направлена сюда, свободна или занята другим. */
export type BrigadeState = "here" | "free" | "busy";

export interface BoardRow {
  readonly id: string;
  readonly name: string;
  /** Прямой номер бригады; `null` — номера в справочнике нет. */
  readonly ext: string | null;
  readonly state: BrigadeState;
  /** Номер происшествия, где бригада занята. */
  readonly busyOn: string | null;
}

/**
 * Табло сил: каждая доступная бригада с номером и состоянием. Диспетчер видит, кто
 * свободен, заранее — до решения по карточке, как на мониторе своей службы.
 */
export function forcesBoard(
  brigades: readonly Brigade[],
  targets: readonly CallTarget[],
  committed: readonly string[],
  busy: ReadonlyMap<string, string>,
): BoardRow[] {
  return brigades.map((brigade) => {
    const busyOn = busy.get(brigade.id) ?? null;
    const target = targets.find(
      (item) => item.is_active && item.brigade_id === brigade.id,
    );
    return {
      id: brigade.id,
      name: brigade.name,
      ext: target?.phone_ext ?? null,
      state: committed.includes(brigade.id)
        ? "here"
        : busyOn === null
          ? "free"
          : "busy",
      busyOn,
    };
  });
}

export function stateLabel(row: BoardRow): string {
  if (row.state === "here") return "направлена сюда";
  if (row.state === "busy") return `занята: происшествие ${row.busyOn ?? ""}`;
  return "свободна";
}

/** Бригаду направляют после решения реагировать: «Принята» (памятка ДДС, стр. 21). */
const DECIDED: ReadonlySet<CardState> = new Set<CardState>([
  "accepted",
  "responding",
  "arrived",
  "working",
]);

/**
 * Решение по карточке ещё не принято: до «Принята» или после «Не принята». Закрытая
 * карточка решение уже имеет — ей советовать «поставьте «Принята»» нельзя.
 */
export function awaitsDecision(state: CardState | null): boolean {
  return state === "added" || state === "received" || state === "rejected";
}

/** Почему бригаду сейчас не направить; `null` — можно. Сервер отклонил бы выбор. */
export function directBlock(state: CardState | null): string | null {
  if (state === null || DECIDED.has(state)) return null;
  if (state === "added" || state === "received")
    return "Сначала примите решение: поставьте статус «Принята» — после этого направьте бригаду.";
  if (state === "rejected")
    return "Карточка не принята — бригады не направляются. Решите реагировать — поставьте «Принята».";
  return "Карточка закрыта — бригады больше не направляются.";
}

function deliveredAt(item: InformationEvidence): string {
  return item.delivery.delivered_at;
}

/** Выданные, но ещё не предъявленные сведения — в порядке выдачи. */
export function pendingMessages(
  messages: readonly InformationEvidence[],
): InformationEvidence[] {
  return messages
    .filter((item) => item.state !== "presented")
    .sort((left, right) => deliveredAt(left).localeCompare(deliveredAt(right)));
}

/** Предъявленные сведения — по ним обучаемый пишет комментарий в карточку. */
export function presentedMessages(
  messages: readonly InformationEvidence[],
): InformationEvidence[] {
  return messages
    .filter((item) => item.state === "presented")
    .sort((left, right) =>
      (left.presented_at ?? "").localeCompare(right.presented_at ?? ""),
    );
}
