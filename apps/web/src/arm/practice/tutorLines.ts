// Строки полосы проводника и запас места под них. Полоса стоит над карточкой: если
// она растёт от действия ученика (появилось «Не забудьте…», сменился шаг), вся
// левая колонка уезжает вниз. Поэтому полоса заранее занимает высоту самой длинной
// своей строки: все варианты лежат в одной клетке сетки невидимыми.
import type { Card } from "../../shared/api";
import { WORKFLOW_STEPS } from "../../shared/workflow";
import { tutorProgress, type TutorEvent, type TutorProgress } from "./tutor";

export const ADDRESS_REMINDER =
  "впишите адрес в блок «Адрес — ввод диспетчера»";

export interface TutorHeadline {
  /** Жирное начало: номер шага или итог. */
  readonly strong: string;
  readonly rest: string;
}

const FINISHED: TutorHeadline = {
  strong: "Упражнение пройдено.",
  rest: "Бригада доложила о завершении, карточка закрыта. Посмотрите разбор — там видно, что получилось и что поправить.",
};
const REJECTED: TutorHeadline = {
  strong: "Карточка не принята.",
  rest: "В упражнении происшествие ваше: щёлкните плитку своей службы и поставьте «Принята».",
};
const stepHeadline = (index: number): TutorHeadline => ({
  strong: `Шаг ${index + 1} из ${WORKFLOW_STEPS.length}: ${WORKFLOW_STEPS[index].title}.`,
  rest: WORKFLOW_STEPS[index].action,
});

/** Строка полосы: текущий шаг, итог упражнения или просьба принять карточку. */
export function tutorHeadline(progress: TutorProgress): TutorHeadline | null {
  if (progress.finished) return FINISHED;
  if (progress.rejected) return REJECTED;
  const index = WORKFLOW_STEPS.findIndex(
    (item) => item.id === progress.current,
  );
  return index < 0 ? null : stepHeadline(index);
}

/** Все строки, какие полоса может показать, — под самую длинную держим место. */
export function headlineVariants(): TutorHeadline[] {
  return [
    ...WORKFLOW_STEPS.map((_, index) => stepHeadline(index)),
    FINISHED,
    REJECTED,
  ];
}

/** Пропущенные шаги и адрес — одной строкой, без «Не забудьте:». */
export function tutorReminders(progress: TutorProgress): string[] {
  if (progress.finished) return [];
  return [
    ...progress.missed.map((id) =>
      (
        WORKFLOW_STEPS.find((item) => item.id === id)?.title ?? id
      ).toLowerCase(),
    ),
    ...(progress.addressMissing ? [ADDRESS_REMINDER] : []),
  ];
}

const STATES: readonly Card["state"][] = [
  "added",
  "received",
  "accepted",
  "rejected",
  "responding",
  "arrived",
  "working",
];

/**
 * Все строки напоминаний, какие проводник может показать: перебор хода дела
 * (статус × бригада направлена × доклад службе × адрес вписан). Под самую
 * длинную из них полоса держит место с самого начала упражнения.
 */
export function reminderVariants(): string[] {
  const phone = "service";
  const report: TutorEvent[] = [
    { type: "call_dial", payload: { call_id: "r", phone_ext: phone } },
    { type: "call_answer", payload: { call_id: "r" } },
    { type: "call_hangup", payload: { call_id: "r" } },
  ];
  const brigade: TutorEvent = { type: "brigades_select", payload: {} };
  const address: TutorEvent = {
    type: "field_change",
    payload: { field: "address" },
  };
  const variants = new Set<string>();
  for (const state of STATES)
    for (let mask = 0; mask < 8; mask++) {
      const events = [
        ...(mask & 1 ? [brigade] : []),
        ...(mask & 2 ? report : []),
        ...(mask & 4 ? [address] : []),
      ];
      const lines = tutorReminders(
        tutorProgress({ state, events, servicePhone: phone }),
      );
      if (lines.length) variants.add(lines.join("; "));
    }
  return [...variants];
}
