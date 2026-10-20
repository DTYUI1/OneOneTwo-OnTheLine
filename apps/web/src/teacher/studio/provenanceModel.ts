// Источник задания и происхождение эталона (D-01/D-02) — по GET /scenarios/{id}/content.
// Только то, что отдаёт сервер: отметки «проверено преподавателем» в контракте пока нет,
// поэтому задание не показывается проверенным, пока API этого не подтвердит.
import type { components } from "../../api-client/schema";

export type ScenarioContent = components["schemas"]["ScenarioContent"];
type Provenance = ScenarioContent["provenance"];

export const SOURCE_KIND_LABELS: Record<Provenance["source_kind"], string> = {
  template: "готовый учебный шаблон",
  llm: "сгенерировано ИИ",
  imported: "загружено из файла",
  manual: "составлено вручную",
};

export const AUTHOR_KIND_LABELS: Record<Provenance["author_kind"], string> = {
  system: "разработчики тренажёра",
  teacher: "преподаватель",
  trainee: "обучаемый",
};

export interface SourceLine {
  label: string;
  value: string;
}

/** Строки блока «Источник задания» для преподавателя; эталон ученику не раскрывается. */
export function provenanceLines(content: ScenarioContent): SourceLine[] {
  const p = content.provenance;
  const reference = [
    p.source_id && `«${p.source_id}»`,
    p.source_version && `версия ${p.source_version}`,
  ]
    .filter(Boolean)
    .join(", ");
  const lines: SourceLine[] = [
    {
      label: "Источник задания",
      value: `${p.synthetic ? "учебная история" : "задание из материалов"} · ${SOURCE_KIND_LABELS[p.source_kind]}${reference ? ` (${reference})` : ""}`,
    },
    {
      label: "Эталон",
      value: AUTHOR_KIND_LABELS[p.author_kind],
    },
  ];
  const plan = content.training_plan;
  if (plan)
    lines.push({
      label: "План сообщений",
      value: `сообщений: ${plan.messages.length}, обязательных бригад: ${plan.required_brigade_ids.length}`,
    });
  lines.push({
    label: "Проверка преподавателем",
    value: "Нет сведений о проверке преподавателем",
  });
  return lines;
}
