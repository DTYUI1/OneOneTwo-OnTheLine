// Пакеты сценариев (D-01, п. 3): генерация, разбор пакета, утверждение пригодных.
import type { components } from "../../api-client/schema";
import { formFromScenario, validateForm, type Scenario } from "./studioModel";

export type Pack = components["schemas"]["Pack"];
export type Job = components["schemas"]["Job"];

export const JOB_LABELS: Record<Job["status"], string> = {
  cancelled: "Остановлено",
  pending: "в очереди",
  running: "генерируется",
  done: "готово",
  failed: "ошибка",
};

/** Старое служебное название переводится в UI без перезаписи исторического пакета. */
export function displayPackTitle(title: string): string {
  const personal = packPersonalization(title);
  if (personal) return personal.title;
  return title.replace(
    /^Сгенерированный пакет \((?:seed|исходное число) (-?\d+)\)$/,
    "Сгенерированный пакет (число для генерации $1)",
  );
}

/** Старые пакеты хранят объяснение подбора прямо в названии. */
export function packPersonalization(title: string) {
  const match = /^Подобрано для ([^:]+): (.+)$/s.exec(title);
  if (!match) return null;
  const labels: Record<string, string> = {
    "ловушкой повтора адреса": "Повтор адреса",
    "вызовом другой службы": "Вызов другой службы",
    "проверкой связи с молчащей бригадой": "Проверка связи с молчащей бригадой",
    "ответом на вопрос бригады": "Ответ на вопрос бригады",
    "быстрой реакцией на тревогу": "Реакция на тревогу",
  };
  const errors = [
    ...match[2].matchAll(/(\d+) из (\d+) с (.+?) — ранее допускал ошибки/g),
  ].map(([, count, total, skill]) => ({
    skill: labels[skill] ?? `Задания с ${skill}`,
    count: Number(count),
    total: Number(total),
  }));
  return { title: `Подобрано для ${match[1]}`, errors, explanation: match[2] };
}

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

/** Исходное число для повторяемого выбора фактов происшествий. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}
