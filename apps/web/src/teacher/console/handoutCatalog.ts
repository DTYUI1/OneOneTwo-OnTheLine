import {
  trainsText,
  type PracticeScenario,
} from "../../arm/catalog/catalogModel";
import type { Scenario } from "./model";
import { creationTime, NEWEST_FIRST, sortedRows } from "../studio/sorting";

export type HandoutScenario = Scenario & {
  catalog: PracticeScenario;
  displayTitle: string;
  specifics: string;
};

const ORIGIN_LABELS: Record<Scenario["origin"], string> = {
  template: "Шаблон",
  llm: "ИИ",
  imported: "Импорт",
  trainee: "Обучаемый",
};

/** Ассортимент и названия — из общего каталога; новые ИИ-карточки — первыми. */
export function catalogScenarios(
  catalog: readonly PracticeScenario[],
  scenarios: readonly Scenario[],
): HandoutScenario[] {
  const approved = new Map(
    scenarios
      .filter((item) => item.status === "approved")
      .map((item) => [item.id, item]),
  );
  const available = catalog.flatMap((item) => {
    const scenario = approved.get(item.id);
    if (!scenario || scenario.version !== item.version) return [];
    const call = scenario.reference.expected_call;
    const specifics = [
      call.required && call.contact_role === "caller" ? "звонок заявителю" : "",
      trainsText([...new Set(item.trains)]),
    ]
      .filter(Boolean)
      .join(", ");
    const displayTitle = `№ ${scenario.card.number} · ${item.title} · ${ORIGIN_LABELS[scenario.origin]}`;
    return [{ ...scenario, catalog: item, displayTitle, specifics }];
  });
  // Категории служебного выбора фильтруют этот порядок, не меняя принадлежность.
  return [
    ...sortedRows(
      available.filter((item) => item.origin === "llm"),
      NEWEST_FIRST,
      (item) => creationTime(item.created_at),
    ),
    ...available.filter((item) => item.origin !== "llm"),
  ];
}
