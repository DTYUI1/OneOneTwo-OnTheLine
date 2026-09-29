// Строки времени попытки для экранов разбора — по результату сервера и его версии
// методики. Ничего не пересчитывает: только подписывает величины и сравнивает их
// с нормативом того же результата.
import type { TimingResult } from "./useAnalysis";

export interface TimeRow {
  label: string;
  seconds: number | null;
  normative: number | null;
  verdict: "ok" | "over" | "unknown" | "info";
}

export const QUALITY_LABELS: Record<TimingResult["quality"], string> = {
  verified: "достоверное время",
  estimated:
    "оценочное время: часы устройства не подтверждены, штраф за превышение не начисляется",
  invalid: "время недостоверно: нарушен порядок событий",
  legacy: "время по прежней методике",
};

function verdict(
  seconds: number | null,
  normative: number,
  overdue: boolean | null,
): TimeRow["verdict"] {
  if (seconds === null) return "unknown";
  if (overdue !== null) return overdue ? "over" : "ok";
  // Сервер не выносит превышение по недостоверному времени — показываем сравнение
  // для ориентира, а качество объясняем отдельной строкой.
  return seconds > normative ? "over" : "ok";
}

export function timeRows(timing: TimingResult): TimeRow[] {
  if (timing.timing_version === 3)
    return [
      {
        label: "Реакция — от направления карточки до «Принята / Не принята»",
        seconds: timing.reaction_s,
        normative: timing.reaction_normative_s,
        verdict: verdict(
          timing.reaction_s,
          timing.reaction_normative_s,
          timing.reaction_overdue,
        ),
      },
      {
        label:
          "Активная отработка — от открытия до завершения, без подтверждённого ожидания",
        seconds: timing.active_handling_s,
        normative: timing.handling_normative_s,
        verdict: verdict(
          timing.active_handling_s,
          timing.handling_normative_s,
          timing.handling_overdue,
        ),
      },
      {
        label: "Ожидание сведений, подтверждённое журналом",
        seconds: timing.waiting_s,
        normative: null,
        verdict: "info",
      },
      {
        label: "Полная отработка — от открытия до завершения",
        seconds: timing.handling_s,
        normative: null,
        verdict: "info",
      },
    ];
  return [
    {
      label: "Реакция — от показа карточки до открытия",
      seconds: timing.reaction_s,
      normative: timing.reaction_normative_s,
      verdict: verdict(
        timing.reaction_s,
        timing.reaction_normative_s,
        timing.reaction_overdue,
      ),
    },
    {
      label: "Отработка — от открытия до завершения",
      seconds: timing.handling_s,
      normative: timing.handling_normative_s,
      verdict: verdict(
        timing.handling_s,
        timing.handling_normative_s,
        timing.handling_overdue,
      ),
    },
  ];
}
