// Адресная выдача (D-01, I-SESSION): у каждого рабочего места своя очередь заданий.
// Отправляется одной пачкой POST /sessions/{id}/assignments/batch — всё или ничего,
// повтор с тем же request_id безопасен (contracts/C01_INTERFACES.md, I-SESSION).
import type { components } from "../../api-client/schema";
import {
  scenarioServiceIds,
  type Assignment,
  type Participant,
  type Scenario,
} from "./model";

export type BatchInput = components["schemas"]["AssignmentBatchInput"];
export type BatchIssue = components["schemas"]["BatchValidationIssue"];
export type DeliveryMode = "profile" | "intentional_mismatch";

/** Предел пачки по контракту. */
export const MAX_BATCH = 230;
/** Предел задержки от старта — сутки. */
export const MAX_DELAY_S = 86_400;

export interface PlanItem {
  key: string;
  participantId: string;
  scenarioId: string;
  scenarioVersion: number;
  delayS: number;
  mode: DeliveryMode;
}

type Seat = Pick<Participant, "user_id" | "dds_service_id" | "level">;

/** Свой ли сценарий участнику: служба происшествия совпадает с его ДДС на занятии. */
export function matchesService(
  scenario: Scenario,
  participant: Pick<Participant, "dds_service_id">,
): boolean {
  const ids = scenarioServiceIds(scenario);
  return (
    ids.includes(participant.dds_service_id) ||
    scenario.target_service_id === participant.dds_service_id
  );
}

/**
 * Добавить сценарий в очередь места. Задержка — следующая после последнего
 * задания этого места; режим — «по профилю», если служба своя, иначе
 * осознанное упражнение неверной доставки (решает преподаватель).
 */
export function addItem(
  plan: PlanItem[],
  participant: Seat,
  scenario: Scenario,
  timing: { firstDelayS: number; intervalS: number },
  key: string,
): PlanItem[] {
  const queue = plan.filter(
    (item) => item.participantId === participant.user_id,
  );
  const last = queue[queue.length - 1];
  return [
    ...plan,
    {
      key,
      participantId: participant.user_id,
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      delayS: last ? last.delayS + timing.intervalS : timing.firstDelayS,
      mode: matchesService(scenario, participant)
        ? "profile"
        : "intentional_mismatch",
    },
  ];
}

/**
 * Подобрать каждому месту утверждённые сценарии его службы и его уровня —
 * так разные места получают разные задания без ручного перебора.
 */
export function suggestPlan(
  participants: Seat[],
  approved: Scenario[],
  timing: { firstDelayS: number; intervalS: number },
  newKey: () => string,
): PlanItem[] {
  let plan: PlanItem[] = [];
  for (const participant of participants)
    for (const scenario of approved)
      if (
        matchesService(scenario, participant) &&
        scenario.level === participant.level
      )
        plan = addItem(plan, participant, scenario, timing, newKey());
  return plan;
}

/** Проблемы плана до отправки — по ключу строки. */
export function planIssues(plan: PlanItem[]): Map<string, string[]> {
  const issues = new Map<string, string[]>();
  const add = (key: string, message: string) =>
    issues.set(key, [...(issues.get(key) ?? []), message]);
  const lastDelay = new Map<string, number>();
  for (const item of plan) {
    if (
      !Number.isInteger(item.delayS) ||
      item.delayS < 0 ||
      item.delayS > MAX_DELAY_S
    )
      add(item.key, "Задержка — целое число секунд от 0 до суток.");
    const previous = lastDelay.get(item.participantId);
    if (previous !== undefined && item.delayS < previous)
      add(
        item.key,
        "Задание приходит раньше предыдущего: задержки по очереди не убывают.",
      );
    lastDelay.set(item.participantId, Math.max(previous ?? 0, item.delayS));
  }
  return issues;
}

/**
 * План → тело пачки. Порядок продолжает уже выданные задания места: контракт
 * требует уникальности (занятие, участник, order) среди старых и новых.
 */
export function toBatch(
  plan: PlanItem[],
  existing: Pick<Assignment, "participant_id" | "order">[],
  requestId: string,
): BatchInput {
  const next = new Map<string, number>();
  for (const item of existing)
    next.set(
      item.participant_id,
      Math.max(next.get(item.participant_id) ?? 0, item.order),
    );
  return {
    request_id: requestId,
    items: plan.map((item) => {
      const order = (next.get(item.participantId) ?? 0) + 1;
      next.set(item.participantId, order);
      return {
        participant_id: item.participantId,
        scenario_id: item.scenarioId,
        scenario_version: item.scenarioVersion,
        order,
        delay_from_start_s: item.delayS,
        delivery_mode: item.mode,
      };
    }),
  };
}

/**
 * Ключ повтора: тот же план — тот же request_id (сервер вернёт тот же ответ и не
 * задвоит задания), изменённый план — новый ключ, иначе сервер ответит 409.
 */
export function requestIdFor(
  body: Omit<BatchInput, "request_id">,
  last: { body: string; requestId: string } | null,
  newId: () => string,
): { body: string; requestId: string } {
  const json = JSON.stringify(body);
  return last && last.body === json ? last : { body: json, requestId: newId() };
}

const ISSUE_TEXT: Record<BatchIssue["code"], string> = {
  unknown_participant: "Участника нет в этом занятии.",
  invalid_reference:
    "Эталон сценария непригоден для оценки — откройте его в студии.",
  service_mismatch:
    "Служба сценария не совпадает с ДДС места: сервер не принял его как упражнение.",
  duplicate_order: "Такой номер в очереди места уже занят.",
  unknown_scenario: "Сценарий не найден или его версия устарела.",
};

/** Ошибки 422 пачки — к своим строкам плана (index — позиция в items). */
export function issuesFromServer(
  plan: PlanItem[],
  items: BatchIssue[],
): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const issue of items) {
    const item = plan[issue.index];
    if (!item) continue;
    byKey.set(item.key, [
      ...(byKey.get(item.key) ?? []),
      ISSUE_TEXT[issue.code] ?? issue.message,
    ]);
  }
  return byKey;
}

/** мм:сс для задержки. */
export function formatDelay(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${String(m).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
