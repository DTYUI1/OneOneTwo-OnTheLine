// Чистая логика пульта преподавателя: состав занятия, раздача заданий «галочками»
// и правила старта. Без React и сети — покрывается vitest и переиспользуется в отчётах.
import type { components } from "../../api-client/schema";
import { STATE_LABELS } from "../../arm/cardModel";

export type User = components["schemas"]["User"];
export type Session = components["schemas"]["Session"];
export type Participant = components["schemas"]["Participant"];
export type Scenario = components["schemas"]["Scenario"];
export type Assignment = components["schemas"]["Assignment"];
export type Evaluation = components["schemas"]["Evaluation"];
export type Report = components["schemas"]["Report"];
export type Card = components["schemas"]["Card"];

/** Рабочих мест в классе — 23 (Q&A Q25); справочника /workstations пока нет. */
export const MAX_WORKSTATION = 23;
/** Четыре уровня сложности: простой / средний / сложный / особо сложный. */
export const MAX_LEVEL = 4;

export interface ParticipantDraft {
  user_id: string;
  workstation_number: number;
  dds_service_id: string;
  level: number;
}

/**
 * Проверка состава до отправки: сервер тоже проверяет, но преподаватель должен
 * увидеть ошибку сразу, а не после отказа на весь список.
 */
export function validateParticipants(draft: ParticipantDraft[]): string[] {
  const problems: string[] = [];
  if (draft.length === 0) problems.push("Добавьте хотя бы одного обучаемого.");
  const places = new Map<number, number>();
  const people = new Set<string>();
  for (const item of draft) {
    if (!item.user_id) problems.push("У участника не выбран обучаемый.");
    if (!item.dds_service_id)
      problems.push("У участника не выбрана служба ДДС.");
    if (
      !Number.isInteger(item.workstation_number) ||
      item.workstation_number < 1 ||
      item.workstation_number > MAX_WORKSTATION
    )
      problems.push(`Номер АРМ должен быть от 1 до ${MAX_WORKSTATION}.`);
    if (
      !Number.isInteger(item.level) ||
      item.level < 1 ||
      item.level > MAX_LEVEL
    )
      problems.push(`Уровень должен быть от 1 до ${MAX_LEVEL}.`);
    places.set(
      item.workstation_number,
      (places.get(item.workstation_number) ?? 0) + 1,
    );
    if (item.user_id && people.has(item.user_id))
      problems.push("Один обучаемый добавлен дважды.");
    people.add(item.user_id);
  }
  for (const [place, count] of places)
    if (count > 1) problems.push(`АРМ ${place} занят несколькими участниками.`);
  return [...new Set(problems)];
}

/** Утверждённые сценарии: назначать можно только их (ответ капитана §2). */
export function assignableScenarios(scenarios: Scenario[]): Scenario[] {
  return scenarios.filter((scenario) => scenario.status === "approved");
}

/**
 * Службы, которым адресовано происшествие сценария. В золотых сценариях служба
 * сейчас ровно одна, но контракт допускает несколько — читаем как список.
 */
export function scenarioServiceIds(scenario: Scenario): string[] {
  const ids = (scenario.card as { service_ids?: string[] }).service_ids;
  return Array.isArray(ids) ? ids : [];
}

export interface AssignmentQueue {
  participantId: string;
  scenarioIds: string[];
}

/**
 * Кому какое задание достанется. Сценарий уходит только тому, чья ДДС на занятии
 * значится среди служб происшествия: карточка чужой службы для обучаемого мертва
 * — статус по ней не ставится, и занятие проходит впустую.
 */
export function distribute(
  participants: Pick<Participant, "user_id" | "dds_service_id">[],
  scenarios: Scenario[],
  checkedIds: string[],
): { queues: AssignmentQueue[]; unmatched: Scenario[] } {
  const checked = scenarios.filter((scenario) =>
    checkedIds.includes(scenario.id),
  );
  const queues: AssignmentQueue[] = [];
  const matched = new Set<string>();
  for (const participant of participants) {
    const scenarioIds = checked
      .filter((scenario) =>
        scenarioServiceIds(scenario).includes(participant.dds_service_id),
      )
      .map((scenario) => scenario.id);
    for (const id of scenarioIds) matched.add(id);
    if (scenarioIds.length > 0)
      queues.push({ participantId: participant.user_id, scenarioIds });
  }
  return {
    queues,
    unmatched: checked.filter((scenario) => !matched.has(scenario.id)),
  };
}

export interface AssignmentPlan {
  participant_id: string;
  scenario_id: string;
  order: number;
  planned_at: string;
}

/**
 * Раздача «галочками»: выбранные сценарии превращаются в очередь заданий для
 * каждого участника. Первая карточка приходит через `firstDelayS` секунд,
 * следующие — каждые `intervalS`, чтобы преподаватель управлял нагрузкой.
 */
export function planAssignments(
  queues: AssignmentQueue[],
  options: { from: number; firstDelayS: number; intervalS: number },
): AssignmentPlan[] {
  const plans: AssignmentPlan[] = [];
  for (const { participantId, scenarioIds } of queues) {
    scenarioIds.forEach((scenarioId, index) => {
      const offset = (options.firstDelayS + index * options.intervalS) * 1000;
      plans.push({
        participant_id: participantId,
        scenario_id: scenarioId,
        order: index + 1,
        planned_at: new Date(options.from + offset).toISOString(),
      });
    });
  }
  return plans;
}

/**
 * Сколько заданий уже выдано каждому участнику. Нумерация продолжается
 * отдельно по участнику: общий счётчик по занятию давал бы разрывы в порядке
 * тем больше, чем больше рабочих мест.
 */
export function ordersByParticipant(
  assignments: Pick<Assignment, "participant_id">[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of assignments) {
    if (!item.participant_id) continue;
    counts.set(item.participant_id, (counts.get(item.participant_id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Старт разрешён только из draft и только когда у каждого участника есть
 * задание (ответ капитана §2): иначе сервер вернёт ошибку на всё занятие.
 */
export function startBlockers(
  session: Pick<Session, "status" | "participants">,
  assignments: Pick<Assignment, "participant_id">[],
): string[] {
  const problems: string[] = [];
  if (session.status === "running") problems.push("Занятие уже идёт.");
  if (session.status === "finished")
    problems.push("Занятие завершено: запустить его заново нельзя.");
  const assigned = new Set(assignments.map((item) => item.participant_id));
  const without = session.participants.filter(
    (participant) => !assigned.has(participant.user_id),
  );
  for (const participant of without)
    problems.push(`АРМ ${participant.workstation_number}: нет заданий.`);
  return problems;
}

/** Балл вердикта 0…1 в проценты: эксперты читают проценты, а не доли. */
export function formatScore(score: number): string {
  return `${Math.round(score * 100)} %`;
}

/**
 * Есть ли посчитанный балл. Пока оценщик недоступен, `total: 0` означает
 * «не считали», а не «ноль баллов» — показывать такой ноль нельзя (ответ капитана §2).
 */
export function hasScore(evaluation: Evaluation): boolean {
  const rules = evaluation.model_info?.rules;
  return !(rules && rules.startsWith("unavailable"));
}

/**
 * `partial` не означает отсутствие rules: фоновый AI-слой может быть отключён.
 */
export function evaluationNote(evaluation: Evaluation): string | null {
  const rules = evaluation.model_info?.rules;
  if (rules && rules.startsWith("unavailable"))
    return `Оценщик недоступен (${rules}): показан неполный результат.`;
  if (evaluation.status === "partial")
    return "Предварительная оценка: фоновая проверка не завершена или отключена.";
  return null;
}

/** Самые слабые критерии занятия — для «лидеров и отстающих и почему». */
export function weakestFirst(evaluation: Evaluation) {
  return [...evaluation.criteria].sort((a, b) => a.score - b.score);
}

/** Статусы занятия по-русски: сырые draft/running на экране преподавателя не показываем. */
export const SESSION_STATUS_LABELS: Record<Session["status"], string> = {
  draft: "черновик",
  running: "идёт",
  finished: "завершено",
};

const STATUS_ORDER: Record<Session["status"], number> = {
  running: 0,
  draft: 1,
  finished: 2,
};

/** Время завершения (или старта) для порядка завершённых; нет — самое старое. */
function finishedMoment(
  session: Pick<Session, "finished_at" | "started_at">,
): number {
  const moment = Date.parse(session.finished_at ?? session.started_at ?? "");
  return Number.isNaN(moment) ? -Infinity : moment;
}

/**
 * Порядок в списке занятий: сначала идущие — за ними преподаватель следит,
 * потом черновики, завершённые в конце. Завершённые — от недавних к старым;
 * внутри остальных групп — как отдал сервер.
 */
export function sortSessions<
  T extends Pick<Session, "status" | "finished_at" | "started_at">,
>(sessions: T[]): T[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort(
      (a, b) =>
        STATUS_ORDER[a.session.status] - STATUS_ORDER[b.session.status] ||
        (a.session.status === "finished"
          ? finishedMoment(b.session) - finishedMoment(a.session)
          : 0) ||
        a.index - b.index,
    )
    .map((item) => item.session);
}

export type SessionTab = "handout" | "live" | "verdicts" | "report";

/**
 * С какой вкладки открывать занятие: черновик готовят, идущее смотрят вживую,
 * завершённое разбирают по отчёту.
 */
export function defaultTab(status: Session["status"]): SessionTab {
  if (status === "draft") return "handout";
  if (status === "running") return "live";
  return "report";
}

export interface VerdictRow {
  evaluation: Evaluation;
  card: Card | null;
}

/**
 * Вердикты одного занятия. У оценки нет session_id — связь идёт через карточку,
 * поэтому оценка без известной карточки в занятие не попадает.
 */
export function verdictsForSession(
  evaluations: Evaluation[],
  cards: Pick<Card, "id" | "session_id">[],
  sessionId: string,
): VerdictRow[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  return evaluations
    .filter(
      (evaluation) => byId.get(evaluation.card_id)?.session_id === sessionId,
    )
    .map((evaluation) => ({
      evaluation,
      card: (byId.get(evaluation.card_id) as Card | undefined) ?? null,
    }));
}

/** Семь критериев T-006 по-русски — одни и те же в пульте и в результатах обучаемого. */
export const CRITERION_LABELS: Record<string, string> = {
  reaction_time: "Время реакции",
  handling_time: "Время отработки",
  status_flow: "Последовательность статусов",
  routing: "Маршрутизация по службам",
  required_fields: "Заполнение обязательных полей",
  address: "Адрес",
  call: "Доклад по телефону",
};

/**
 * Критерии комментария (28.09, evalcore/comment.py): вес по желанию — в занятиях,
 * созданных раньше, их нет. Проверка по словарю, без ИИ.
 */
export const COMMENT_CRITERION_LABELS: Record<string, string> = {
  spelling: "Грамотность комментария",
  comment_keywords: "Ключевые сведения в комментарии",
};

// Критерии ИИ-судьи (worker/judging.py): в разборе есть, весов в настройках нет.
const JUDGE_LABELS: Record<string, string> = {
  comment_completeness: "Полнота комментария",
  comment_clarity: "Понятность комментария",
};

/** Название критерия для экрана: ключ оценщика наружу не показываем. */
export function criterionLabel(key: string): string {
  return (
    CRITERION_LABELS[key] ??
    COMMENT_CRITERION_LABELS[key] ??
    JUDGE_LABELS[key] ??
    key
  );
}

// Служебные слова, которые оценщик вставляет в пояснения: поля, части адреса,
// события журнала, статусы. Обучаемому и преподавателю показываем их по-русски.
const TERMS: Record<string, string> = {
  ...STATE_LABELS,
  ...Object.fromEntries(
    Object.entries({
      ...CRITERION_LABELS,
      ...COMMENT_CRITERION_LABELS,
      ...JUDGE_LABELS,
    }).map(([key, label]) => [key, label.toLowerCase()]),
  ),
  city: "город",
  street: "улица",
  house: "дом",
  building: "корпус",
  apartment: "квартира",
  service_number: "номер наряда",
  comment: "комментарий",
  deliver: "доставка",
  open: "открытие",
  direct: "направление",
  evalcore: "оценщика",
  None: "нет",
};
const TERM_PATTERN = new RegExp(
  `\\b(${Object.keys(TERMS)
    .sort((a, b) => b.length - a.length)
    .join("|")})\\b`,
  "g",
);

/**
 * Пояснение оценщика без английских ключей: «city, street» → «город, улица»,
 * «['accepted']» → «Принята», «57.0845 с» → «57,1 с». Текст сервера не меняется
 * по смыслу — только подписи и запись чисел.
 */
export function readable(text: string): string {
  return text
    .replace(/current\.address/g, "поля ручного ввода")
    .replace(/\[((?:'[^']*'(?:,\s*)?)*)\]/g, (_, items: string) => {
      const list = [...items.matchAll(/'([^']*)'/g)].map((item) => item[1]);
      return list.length > 0 ? list.join(", ") : "нет";
    })
    .replace(TERM_PATTERN, (key: string) => TERMS[key] ?? key)
    .replace(/(\d+)\.(\d+)(?= с(?![а-яё]))/gi, (value: string) =>
      String(Math.round(Number(value) * 10) / 10).replace(".", ","),
    )
    .replace(/(\d)\.(\d)/g, "$1,$2");
}

/** «67» или «67,5» → 0.67 / 0.675; вне 0…100 — null. Баллы на экране в процентах. */
export function percentToTotal(value: string): number | null {
  const parsed = Number(value.replace(",", ".").trim());
  if (!value.trim() || Number.isNaN(parsed) || parsed < 0 || parsed > 100)
    return null;
  return Math.round(parsed * 10) / 1000;
}
