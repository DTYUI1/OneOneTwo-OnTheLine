// Пакеты сценариев (D-01, п. 3): генерация, разбор пакета, утверждение пригодных.
import type { components } from "../../api-client/schema";
import { formFromScenario, validateForm, type Scenario } from "./studioModel";

export type Pack = components["schemas"]["Pack"];
export type Job = components["schemas"]["Job"];

export const JOB_LABELS: Record<Job["status"], string> = {
  pending: "в очереди",
  running: "генерируется",
  done: "готово",
  failed: "ошибка",
};

/** Пакет, появившийся после генерации: legacy generate не возвращает его ID. */
export function newPack(before: Pack[], after: Pack[]): Pack | null {
  const known = new Set(before.map((pack) => pack.id));
  return after.find((pack) => !known.has(pack.id)) ?? null;
}

/**
 * Пригоден ли сценарий к утверждению — те же правила, что у кнопки «Утвердить»
 * в редакторе. Неполный эталон не выдаётся: такой сценарий отмечать нельзя.
 */
export function readiness(scenario: Scenario): {
  ready: boolean;
  reasons: string[];
} {
  if (scenario.status === "approved") return { ready: false, reasons: [] };
  if (scenario.status === "retired")
    return { ready: false, reasons: ["в архиве"] };
  const reasons = Object.values(
    validateForm(formFromScenario(scenario), "approve"),
  ).flat();
  return { ready: reasons.length === 0, reasons };
}

export interface PackSummary {
  total: number;
  approved: number;
  ready: number;
  blocked: number;
}

export function summarizePack(scenarios: Scenario[]): PackSummary {
  let approved = 0;
  let ready = 0;
  let blocked = 0;
  for (const scenario of scenarios) {
    if (scenario.status === "approved") approved += 1;
    else if (readiness(scenario).ready) ready += 1;
    else blocked += 1;
  }
  return { total: scenarios.length, approved, ready, blocked };
}

/** Случайный seed для воспроизводимой генерации: тот же seed — тот же пакет. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}
