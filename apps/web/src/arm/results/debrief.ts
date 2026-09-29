// Итоги попытки для обучаемого (29.09): «получилось / что исправить» сразу после
// закрытия карточки. Так разбирают упражнения на тренажёрах (плюс–дельта): главное
// обучение — на разборе, а не в самом упражнении. Баллы — с сервера, здесь только
// отбор, порядок и советы. Эталонный текст обучаемому не показываем (C-06).
import type { components } from "../../api-client/schema";
import { criterionLabel, readable } from "../../teacher/console/model";
import { formatDuration, STATE_LABELS, type CardState } from "../cardModel";

type Criterion = components["schemas"]["CriterionResult"];
type StoredEvent = components["schemas"]["StoredEvent"];

export type Level = "excellent" | "good" | "fair" | "poor";

/** Уровень словами вместо процентов — как шкала наставника: что значит этот балл. */
export const LEVEL_LABELS: Record<Level, string> = {
  excellent: "отлично",
  good: "хорошо",
  fair: "приемлемо",
  poor: "не освоено",
};

export function criterionLevel(score: number): Level {
  if (score >= 1) return "excellent";
  if (score >= 0.8) return "good";
  if (score >= 0.5) return "fair";
  return "poor";
}

/** Что сделать в следующий раз — по памятке ДДС и правилам оценки. */
const ADVICE: Record<string, string> = {
  status_flow:
    "Ставьте статус по докладу бригады: отмечайте только те этапы, о которых она доложила. Работ на месте не было — «Отказ от выполнения работ» с причиной.",
  routing:
    "Сверьте карточку со своей службой. Не ваша — «Не принята» с причиной и перенаправление.",
  required_fields:
    "Перед статусом заполните номер наряда и комментарий: без них карточка неполная.",
  address:
    "Запишите адрес со слов заявителя в блок «Адрес — ввод диспетчера»: город, улица, дом.",
  call: "Доложите должностному лицу: «Телефон», номер службы, доклад по карточке.",
  spelling:
    "Перечитайте комментарий перед сохранением: опечатки мешают следующему звену.",
  comment_keywords:
    "В поле «Комментарий» рядом со статусом (удобнее всего при «Принята») напишите главное: где, что случилось, какое решение, есть ли пострадавшие.",
  comment_completeness:
    "В поле «Комментарий» рядом со статусом (удобнее всего при «Принята») напишите главное: где, что случилось, какое решение, есть ли пострадавшие.",
  comment_clarity:
    "Пишите коротко и по делу: кто, где, что случилось, что сделано.",
};

/** Советы по времени: норматив берётся из факта оценщика, а не зашит в текст. */
function timeAdvice(key: string, normative: number | null): string | null {
  const limit =
    normative === null
      ? "в пределах норматива"
      : `не дольше ${formatDuration(normative)}`;
  if (key === "reaction_time")
    return `Откройте карточку и сразу примите решение: «Принята» или «Не принята» — ${limit}.`;
  if (key === "handling_time")
    return `Ведите карточку без пауз: от открытия до завершения — ${limit}.`;
  return null;
}

/** Норматив из строки оценщика «… при нормативе 30 с». */
export function normativeOf(line: string | null): number | null {
  const match = line?.match(/при нормативе (\d+(?:[.,]\d+)?)\s*с/);
  return match ? Math.round(Number(match[1].replace(",", "."))) : null;
}

/** Секунды в тексте оценщика («56,4 с») — в тот же вид, что и таблица времени (м:сс). */
export function clockText(line: string): string {
  return line.replace(
    /(\d+(?:[.,]\d+)?)\s*с(?![а-яёa-z])/gi,
    (_, value: string) =>
      formatDuration(Math.round(Number(value.replace(",", ".")))),
  );
}

/** Служебные строки методики времени обучаемому не нужны: они для преподавателя. */
export function traineeEvidence(lines: readonly string[]): string[] {
  return lines
    .map(readable)
    .filter(
      (line) =>
        !line.startsWith("Методика") && !line.startsWith("Источники времени"),
    )
    .map(clockText);
}

/** Факт из разбора, который подтверждает замечание: эталон, нехватка, опечатки, норматив. */
function factFor(criterion: Criterion): string | null {
  const lines = criterion.evidence.map(readable);
  const find = (test: (line: string) => boolean) => lines.find(test) ?? null;
  switch (criterion.key) {
    case "status_flow":
      // Оценщик называет, чего не хватает и что лишнее, — это конкретнее эталона.
      // У попыток, оценённых до этого, пояснение общее — тогда показываем эталон.
      return /^(Не хватает|Лишние|Статусы поставлены)/.test(
        criterion.explanation,
      )
        ? readable(criterion.explanation)
        : find((line) => line.startsWith("Эталон"));
    case "spelling": {
      const typos = lines.filter(
        (line) => line.includes("→") || line.includes("нет в словаре"),
      );
      return typos.length ? `Ошибки: ${typos.slice(0, 3).join("; ")}` : null;
    }
    case "comment_keywords":
    case "comment_completeness":
      return find((line) => line.startsWith("Не хватает"));
    case "reaction_time":
    case "handling_time":
      return find((line) => line.includes("при нормативе"));
    case "address":
      // «Проверен ручной адрес…» ничего не объясняет: показываем, что не совпало.
      return (
        find((line) => line.startsWith("Не совпали")) ??
        readable(criterion.explanation)
      );
    default:
      return lines[0] ?? null;
  }
}

export interface Improvement {
  key: string;
  title: string;
  level: Level;
  critical: boolean;
  advice: string;
  fact: string | null;
}

export interface Debrief {
  good: string[];
  improve: Improvement[];
}

/**
 * «Получилось» — критерии на 100 %; «что исправить» — до трёх: сначала критические,
 * потом по потере балла с учётом веса. Критерии с нулевым весом на итог не влияют.
 */
export function buildDebrief(
  criteria: readonly Criterion[],
  limit = 3,
): Debrief {
  const counted = criteria.filter(
    (item) => item.weight > 0 && !notApplicable(item),
  );
  const good = counted
    .filter((item) => item.score >= 1)
    .map((item) => criterionLabel(item.key));
  const improve = counted
    .filter((item) => item.score < 1)
    .sort(
      (a, b) =>
        Number(b.critical) - Number(a.critical) ||
        b.weight * (1 - b.score) - a.weight * (1 - a.score),
    )
    .slice(0, limit)
    .map((item) => {
      const fact = factFor(item);
      return {
        key: item.key,
        title: criterionLabel(item.key),
        level: criterionLevel(item.score),
        critical: item.critical,
        advice:
          timeAdvice(item.key, normativeOf(fact)) ??
          ADVICE[item.key] ??
          readable(item.explanation),
        fact: fact === null ? null : clockText(fact),
      };
    });
  return { good, improve };
}

/** Одно главное исправление на следующую попытку — первое из «что исправить». */
export function focusFor(debrief: Debrief): Improvement | undefined {
  return debrief.improve[0];
}

/**
 * Критерии, которые сценарий не проверяет, — одной строкой, чтобы они не пропадали
 * молча: жюри и обучаемый видят, почему их нет в итогах.
 */
export function notApplicableLabels(criteria: readonly Criterion[]): string {
  return criteria
    .filter(notApplicable)
    .map((item) => criterionLabel(item.key).toLowerCase())
    .join(", ");
}

/**
 * Критерий, которого в сценарии нет: звонок не предусмотрен, комментарий не обязателен,
 * ключевые сведения не заданы, обязательных полей нет. Оценщик ставит ему 100 % — это не
 * заслуга обучаемого, поэтому в «Получилось» он не идёт, а в списке — «не требуется»
 * (как ответ «не применимо» в стандартах разбора вызовов APCO/NENA).
 */
export function notApplicable(criterion: Criterion): boolean {
  const text = [criterion.explanation, ...criterion.evidence].join(" ");
  return /не предусмотрен|не обязателен|не заданы|\b0 из 0\b/.test(text);
}

/** Порог «зачтено» и уровни попытки — методика команды (пороги AQUA не публикуются). */
export const PASS_TOTAL = 0.7;
export const HIGH_TOTAL = 0.9;

export interface AttemptVerdict {
  passed: boolean;
  label: string;
  detail: string;
}

/**
 * Вердикт попытки: критическая ошибка — «не зачтено», какой бы ни была сумма (как
 * проваливающие задачи на экзаменах операторов). Решение преподавателя с новым баллом
 * главнее: флаг снимает он.
 */
export function attemptVerdict(
  total: number,
  criteria: readonly Criterion[],
  teacherTotal: number | null = null,
): AttemptVerdict {
  const level = (value: number) =>
    value >= HIGH_TOTAL
      ? "высокое соответствие"
      : value >= PASS_TOTAL
        ? "соответствие с замечаниями"
        : "низкое соответствие";
  if (teacherTotal !== null)
    return {
      passed: teacherTotal >= PASS_TOTAL,
      label: teacherTotal >= PASS_TOTAL ? "Зачтено" : "Не зачтено",
      detail: `${level(teacherTotal)} · решение преподавателя`,
    };
  const critical = criteria.filter((item) => item.critical && item.weight > 0);
  if (critical.length > 0)
    return {
      passed: false,
      label: "Не зачтено",
      detail: `критическая ошибка: ${critical
        .map((item) => criterionLabel(item.key).toLowerCase())
        .join(", ")}`,
    };
  return {
    passed: total >= PASS_TOTAL,
    label: total >= PASS_TOTAL ? "Зачтено" : "Не зачтено",
    detail: level(total),
  };
}

export interface TimeLine {
  label: string;
  seconds: number | null;
  normative: number | null;
}

export interface AfterAction {
  expected: string[];
  done: string[];
  why: string | null;
}

const clock = (seconds: number) => formatDuration(Math.round(seconds));

/**
 * Разбор по четырём вопросам (After Action Review): что ожидалось, что сделано,
 * почему так вышло; «что сделать иначе» — это buildDebrief().improve.
 */
export function afterAction({
  criteria,
  times,
  path,
  comment,
  teacherComment,
}: {
  criteria: readonly Criterion[];
  times: readonly TimeLine[];
  path: string;
  comment: string;
  teacherComment: string;
}): AfterAction {
  const find = (key: string) => criteria.find((item) => item.key === key);
  const applies = (key: string) => {
    const item = find(key);
    return item !== undefined && item.weight > 0 && !notApplicable(item);
  };
  const expected: string[] = [];
  const done: string[] = [];

  const reference = find("status_flow")
    ?.evidence.map(readable)
    .find((line) => line.startsWith("Эталон"));
  if (reference)
    expected.push(`Статусы: ${reference.replace(/^Эталон:\s*/, "")}`);
  if (path) done.push(`Статусы: ${path}`);

  const norms = times.filter((line) => line.normative !== null);
  if (norms.length)
    expected.push(
      norms
        .map(
          (line) =>
            `${line.label.split(" — ")[0]} — не дольше ${clock(line.normative ?? 0)}`,
        )
        .join("; "),
    );
  const measured = norms.filter((line) => line.seconds !== null);
  if (measured.length)
    done.push(
      measured
        .map(
          (line) =>
            `${line.label.split(" — ")[0]} — ${clock(line.seconds ?? 0)}`,
        )
        .join("; "),
    );

  if (applies("call")) {
    expected.push("Доклад должностному лицу по телефону");
    done.push(
      (find("call")?.score ?? 0) > 0
        ? "Доклад по телефону был"
        : "Доклада по телефону не было",
    );
  }
  if (applies("comment_keywords") || applies("comment_completeness"))
    expected.push(
      "Комментарий: где, что случилось, какое решение, есть ли пострадавшие",
    );
  const text = comment.trim();
  done.push(
    text
      ? `Комментарий: «${text.length > 140 ? `${text.slice(0, 140)}…` : text}»`
      : "Комментарий пуст",
  );

  const judge = find("comment_completeness");
  const why = teacherComment.trim()
    ? `Преподаватель: ${teacherComment.trim()}`
    : judge
      ? `ИИ о комментарии: ${readable(judge.explanation)}`
      : null;
  return { expected, done, why };
}

export interface TimelineRow {
  /** Секунды от показа карточки (delivered_at). */
  at: number;
  label: string;
  /** Шаг сделан позже норматива. */
  over: boolean;
}

const PRIMARY: CardState[] = ["accepted", "rejected"];
const FINAL: CardState[] = ["completed", "refused", "redirected"];

/** Вердикты оценщика по времени: только они решают, что «позже норматива». */
export interface TimeVerdicts {
  reactionOver: boolean;
  handlingOver: boolean;
}

/**
 * Хронология попытки: когда что сделано, от показа карточки. Первый первичный статус
 * помечается, если оценщик просрочил реакцию, последний итоговый — если просрочил
 * отработку. Время здесь не пересчитываем: методика (v3 вычитает ожидание на звонках,
 * недостоверные часы не штрафуются) есть только у оценщика, иначе хронология спорила бы
 * с таблицей времени. Обучаемый находит момент, где ушло время (разбор по AAR).
 */
export function attemptTimeline(
  events: readonly StoredEvent[],
  deliveredAt: string | null,
  verdicts: TimeVerdicts | null,
): TimelineRow[] {
  if (events.length === 0) return [];
  const sorted = [...events].sort(
    (a, b) => Date.parse(a.server_ts) - Date.parse(b.server_ts),
  );
  const start = Date.parse(deliveredAt ?? sorted[0].server_ts);
  const seconds = (event: StoredEvent) =>
    Math.max(0, (Date.parse(event.server_ts) - start) / 1000);
  const dialed = new Map<string, string>();
  const rows: TimelineRow[] = [];
  const kinds: ("primary" | "final" | null)[] = [];
  for (const event of sorted) {
    const payload = event.payload as Record<string, unknown>;
    const at = seconds(event);
    const callId = String(payload.call_id ?? "");
    let label: string | null = null;
    let kind: "primary" | "final" | null = null;
    if (event.type === "open") label = "Карточка открыта";
    else if (event.type === "status_change") {
      const state = payload.state as CardState | undefined;
      if (state && STATE_LABELS[state]) {
        label = STATE_LABELS[state];
        if (PRIMARY.includes(state)) kind = "primary";
        if (FINAL.includes(state)) kind = "final";
      }
    } else if (event.type === "redirect") label = "Перенаправлена";
    else if (event.type === "call_dial") {
      const number = String(payload.phone_ext ?? "").trim();
      const name = number ? `Звонок ${number}` : "Звонок";
      dialed.set(callId, name);
      label = name;
    } else if (event.type === "call_dial_target") {
      dialed.set(callId, "Звонок бригаде");
      label = "Звонок бригаде";
    } else if (event.type === "call_answer")
      label = `${dialed.get(callId) ?? "Звонок"} — ответили`;
    if (label) {
      rows.push({ at: Math.round(at), label, over: false });
      kinds.push(kind);
    }
  }
  const firstPrimary = kinds.indexOf("primary");
  const lastFinal = kinds.lastIndexOf("final");
  if (verdicts?.reactionOver && firstPrimary >= 0)
    rows[firstPrimary].over = true;
  if (verdicts?.handlingOver && lastFinal >= 0) rows[lastFinal].over = true;
  return rows;
}
