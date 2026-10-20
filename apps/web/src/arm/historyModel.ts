import type { Card, CardEvent } from "../shared/api";
import type { components } from "../api-client/schema";
import { STATE_LABELS } from "./cardModel";
import { memoryScore, memoryText } from "./memory/memoryCheck";

export type HistoryEvent = Pick<
  components["schemas"]["StoredEvent"],
  "id" | "type" | "payload" | "server_ts" | "actor_id"
>;

export interface HistoryEntry {
  readonly id: string;
  readonly at: string;
  readonly label: string;
  readonly comment: string;
  readonly operator: string;
  readonly operatorTitle: string;
  readonly primary: boolean;
  readonly late: boolean;
}

const ACTION_LABELS = {
  deliver: STATE_LABELS.received,
  open: "карточка открыта",
  field_change: "Правка поля",
  status_change: "Изменён статус",
  comment: "Комментарий",
  redirect: STATE_LABELS.redirected,
  hint_open: "открыта подсказка",
  call_dial: "набран номер",
  call_dial_target: "вызван адресат",
  call_answer: "абонент ответил",
  call_hangup: "звонок завершён",
  call_hold: "звонок на удержании",
  call_resume: "снят с удержания",
  caller_said: "реплика заявителя",
  brigades_select: "выбраны бригады",
  message_presented: "учебное сообщение предъявлено",
  message_failed: "учебное сообщение не предъявлено",
  brigade_reply: "ответ бригаде",
  brigade_briefing: "вводная бригаде",
  brigade_said: "передано бригаде",
  report_confirmed: "доклад бригады принят",
  control_reply: "пояснение отделу контроля",
} satisfies Record<CardEvent["type"], string>;

const FIELD_LABELS: Record<string, string> = {
  service_number: "Указан номер наряда",
  comment: "Правка комментария",
  address: "Введён адрес",
};

function eventLabel(event: HistoryEvent): string {
  const state = typeof event.payload.state === "string" ? event.payload.state : "";
  const stateLabel = STATE_LABELS[state as Card["state"]] ?? state;
  if (event.type === "status_change") return stateLabel || "Изменён статус";
  if (event.type === "status_denied") return `Статус не принят: ${stateLabel}`;
  if (event.type === "memory_check") return "Проверка памяти показана";
  if (event.type === "memory_check_answer") {
    const memory = memoryScore([event]);
    if (memory) return memoryText(memory).toLowerCase();
  }
  if (event.type === "field_change")
    return FIELD_LABELS[String(event.payload.field)] ?? ACTION_LABELS.field_change;
  return (ACTION_LABELS as Record<string, string>)[event.type] ?? "Служебное действие";
}

function eventComment(
  event: HistoryEvent,
  services: readonly { id: string; name: string }[],
): string {
  const parts: string[] = [];
  if (event.type === "redirect" && typeof event.payload.service_id === "string") {
    const id = event.payload.service_id;
    parts.push(`Куда: ${services.find((service) => service.id === id)?.name ?? id}`);
  }
  if (typeof event.payload.comment === "string" && event.payload.comment.trim())
    parts.push(event.payload.comment);
  if (typeof event.payload.text === "string" && event.payload.text.trim())
    parts.push(event.payload.text);
  if (event.type === "field_change" && typeof event.payload.value === "string")
    parts.push(event.payload.value);
  if (typeof event.payload.phone_ext === "string")
    parts.push(`Номер: ${event.payload.phone_ext}`);
  if (event.type === "status_denied" && typeof event.payload.message === "string")
    parts.push(event.payload.message);
  return [...new Set(parts)].join("\n");
}

/** Подтверждённый журнал; синтетические строки — только для фактов из самой карточки. */
export function buildHistory({
  card,
  events,
  workstation,
  traineeName,
  services = [],
  lateId,
}: {
  card: Pick<Card, "id" | "trainee_id" | "appeared_at" | "delivered_at">;
  events: readonly HistoryEvent[];
  workstation: string | number;
  traineeName?: string;
  services?: readonly { id: string; name: string }[];
  lateId?: string | null;
}): HistoryEntry[] {
  const ownOperator = workstation === "" ? "Диспетчер" : `оп. ${workstation}`;
  const entries: HistoryEntry[] = [
    {
      id: `${card.id}:added`,
      at: card.appeared_at,
      label: STATE_LABELS.added,
      comment: "",
      operator: "Оператор 112",
      operatorTitle: "Карточка поступила из системы 112",
      primary: true,
      late: false,
    },
  ];
  if (card.delivered_at && !events.some((event) => event.type === "deliver"))
    entries.push({
      id: `${card.id}:delivered`,
      at: card.delivered_at,
      label: STATE_LABELS.received,
      comment: "",
      operator: ownOperator,
      operatorTitle: traineeName ?? card.trainee_id,
      primary: true,
      late: false,
    });
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const own = event.actor_id === card.trainee_id;
    entries.push({
      id: event.id,
      at: event.server_ts,
      label: eventLabel(event),
      comment: eventComment(event, services),
      operator: own ? ownOperator : "Участник",
      operatorTitle: own ? (traineeName ?? event.actor_id) : event.actor_id,
      primary: ["deliver", "status_change", "redirect", "comment"].includes(event.type),
      late: event.id === lateId,
    });
  }
  // Стабильная сортировка сохраняет порядок API для записей с одинаковым временем.
  return entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
