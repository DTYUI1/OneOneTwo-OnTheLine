// Итоги попытки для обучаемого (29.09): «получилось / что исправить» сразу после
// закрытия карточки. Так разбирают упражнения на тренажёрах (плюс–дельта): главное
// обучение — на разборе, а не в самом упражнении. Баллы — с сервера, здесь только
// отбор, порядок и советы. Эталонный текст обучаемому не показываем (C-06).
import type { components } from "../../api-client/schema";
import {
  criterionLabel,
  formatScore,
  readable,
} from "../../teacher/console/model";
import { formatDuration, STATE_LABELS, type CardState } from "../cardModel";

type Criterion = components["schemas"]["CriterionResult"];
type StoredEvent = components["schemas"]["StoredEvent"];
type Call = components["schemas"]["Call"];
export type Remark = components["schemas"]["CriterionRemark"];

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

/** Балл отдельного критерия — по шкале 0–100, не вклад в итог с весами и cap. */
export function criterionScoreLabel(criterion: Criterion): string {
  if (criterion.weight === 0) return "не оценивается";
  if (notApplicable(criterion)) return "не требуется";
  return `${Math.round(criterion.score * 100)} из 100 · ${LEVEL_LABELS[criterionLevel(criterion.score)]}`;
}

/** Сравнение двух готовых итогов API без пересчёта на клиенте. */
export function scoreSourceLabel(
  automaticTotal: number,
  effectiveTotal: number,
  decision: "agree" | "disagree" | null,
): string {
  const automatic = `Автоматическая оценка: ${formatScore(automaticTotal)}`;
  if (decision === "disagree")
    return `${automatic} → после решения преподавателя: ${formatScore(effectiveTotal)}.`;
  if (decision === "agree")
    return `${automatic} · преподаватель подтвердил её.`;
  return `${automatic} · решения преподавателя пока нет.`;
}

/** Названия обязательных слоёв в причинах частичной оценки от API. */
export function partialReasonLabel(reason: string): string {
  return readable(reason)
    .replace(/^Слой rules:/, "Проверка по правилам:")
    .replace(/^Слой llm:/, "Проверка свободного текста ИИ:");
}

/** Что сделать в следующий раз — по памятке ДДС и правилам оценки. */
const ADVICE: Record<string, string> = {
  status_flow:
    "Ставьте статус по докладу бригады: отмечайте только те этапы, о которых она доложила. Работ на месте не было — «Отказ от выполнения работ» с причиной.",
  routing:
    "Сверьте карточку со своей службой. Не ваша — «Не принята» с причиной и перенаправление.",
  required_fields:
    "Со статусом «Начало реагирования» впишите в «Номер наряда» номер выехавшей бригады (201…), к каждому статусу — комментарий: без них карточка неполная.",
  address:
    "Адрес из карточки не переписывайте с искажениями: сверяйте название улицы по буквам. Если бригада доложила другой адрес — напишите уточнённый адрес в комментарии к статусу: улица и дом.",
  call: "Проверьте, кому по заданию нужен звонок, и сделайте доклад по памятке ДДС, с. 32: кто вы, адрес и повод, карточка, что изменилось.",
  spelling:
    "Перечитайте комментарий перед сохранением: опечатки мешают следующему звену.",
  comment_keywords:
    "В поле «Комментарий» рядом со статусом (удобнее всего при «Принята») напишите главное: где, что случилось, какое решение, есть ли пострадавшие.",
  comment_completeness:
    "В поле «Комментарий» рядом со статусом (удобнее всего при «Принята») напишите главное: где, что случилось, какое решение, есть ли пострадавшие.",
  comment_clarity:
    "Пишите коротко и по делу: кто, где, что случилось, что сделано.",
  brigade_work:
    "Бригада ждёт вашей реакции. На вопрос ответьте по карточке, просьбу о другой службе выполните сразу. Долго молчащей бригаде позвоните сами, на тревогу — ответ и скорая.",
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
    case "routing":
      return lines.slice(0, 2).join("; ") || null;
    case "call": {
      // Не теряем вторую ошибку того же звонка: неверный адресат и отсутствие
      // доклада — разные факты, но оба входят в один критерий.
      const errors = lines.filter(
        (line) =>
          line.startsWith("Обязательный звонок отсутствует") ||
          (line.startsWith("Адресат") && line.includes("неверно")) ||
          /Доклад службе .*?(не сделан|полного доклада нет)/.test(line),
      );
      const parts = find((line) => line.startsWith("Части"));
      return (
        [...errors, ...(parts ? [parts] : [])].join("; ") || lines[0] || null
      );
    }
    case "brigade_work":
      // Первое событие, где реакции не было, она была поздней или неверной.
      return (
        find((line) =>
          /не (позвонили|ответили|услышали)|неверно|позже срока/.test(line),
        ) ??
        lines[0] ??
        null
      );
    case "required_fields": {
      // Какое поле пусто или неверно — конкретнее, чем «Заполнено 1 из 2».
      const problems = lines.filter((line) => !line.startsWith("Заполнено"));
      return problems.length ? problems.join("; ") : (lines[0] ?? null);
    }
    case "address":
      // Первая строка — режим проверки, она ничего не объясняет: показываем, что не так.
      return (
        find((line) => line.startsWith("В комментарии другая улица")) ??
        find((line) => line.startsWith("Не совпали")) ??
        readable(criterion.explanation)
      );
    default:
      return lines[0] ?? null;
  }
}

/**
 * Факт уже сказан основанием критерия: у обязательных полей основание — те же тексты
 * проблем, что и факт. В полном разборе рядом с «Основанием» такой факт не повторяем;
 * в кратком («Что сделать иначе») основания нет, там факт остаётся.
 */
export function repeatsExplanation(fact: string, explanation: string): boolean {
  const said = readable(explanation).replace(/\.$/, "");
  return fact
    .split("; ")
    .every((part) => said.includes(readable(part).replace(/\.$/, "")));
}

/** Смена задачи уже записана оценщиком в фактах только предъявленного доклада. */
function callAdvice(criterion: Criterion): string {
  const change = criterion.evidence
    .map(readable)
    .find((line) =>
      line.startsWith("Задача изменилась после доклада бригады: "),
    )
    ?.replace("Задача изменилась после доклада бригады: ", "")
    .replace(/\.$/, "");
  return change
    ? `${change}. В звонке назовите: кто вы, адрес и повод, номер карточки, что изменилось.`
    : ADVICE.call;
}

export interface Improvement {
  key: string;
  title: string;
  level: Level;
  critical: boolean;
  advice: string;
  fact: string | null;
  /**
   * Замечания разбора (TC-10): что не так, цитата, последствие, страница памятки ДДС и
   * «Повторите: …». Пусто — оценка без замечаний (тогда показываются advice и fact).
   */
  remarks: Remark[];
  /** Балл не снижен: только замечание (статусы подряд быстрее порога). */
  notice: boolean;
}

export interface Debrief {
  good: string[];
  improve: Improvement[];
  /** Вопросы к данным сценария: ошибка в данных, обучаемому не вменяется. */
  data: Remark[];
}

/** Секунды в тексте замечания — в вид таблицы времени (м:сс), как и в фактах. */
function shown(remark: Remark): Remark {
  return {
    ...remark,
    text: clockText(remark.text),
    consequence: clockText(remark.consequence),
  };
}

const ownRemarks = (item: Criterion) =>
  (item.remarks ?? []).filter((remark) => remark.kind !== "data").map(shown);

/**
 * «Получилось» — критерии на 100 %; «что исправить» — до трёх: сначала критические,
 * потом по потере балла с учётом веса, в конце — замечания без снижения балла.
 * Критерии с нулевым весом на итог не влияют. Вопросы к данным — отдельно.
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
  const errors = counted
    .filter((item) => item.score < 1)
    .sort(
      (a, b) =>
        Number(b.critical) - Number(a.critical) ||
        b.weight * (1 - b.score) - a.weight * (1 - a.score),
    );
  const notices = counted.filter(
    (item) =>
      item.score >= 1 &&
      ownRemarks(item).some((remark) => remark.kind === "notice"),
  );
  const criticalCount = errors.filter((item) => item.critical).length;
  const improve = [...errors, ...notices]
    .slice(0, Math.max(limit, criticalCount))
    .map((item) => {
      const fact = factFor(item);
      const remarks = ownRemarks(item);
      return {
        key: item.key,
        title: criterionLabel(item.key),
        level: criterionLevel(item.score),
        critical: item.critical,
        advice:
          remarks[0]?.repeat ??
          timeAdvice(item.key, normativeOf(fact)) ??
          (item.key === "call" ? callAdvice(item) : ADVICE[item.key]) ??
          readable(item.explanation),
        fact: fact === null ? null : clockText(fact),
        remarks,
        notice: item.score >= 1,
      };
    });
  const data = criteria.flatMap((item) =>
    (item.remarks ?? []).filter((remark) => remark.kind === "data"),
  );
  return { good, improve, data };
}

/** Сколько раз открыта помощь — подсказки (`hint_open`): видна в разборе, балл не снижает. */
export function helpsUsed(events: readonly StoredEvent[]): number {
  return events.filter((event) => event.type === "hint_open").length;
}

function timesWord(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return "раз";
  return ones >= 2 && ones <= 4 ? "раза" : "раз";
}

/**
 * Какие части памятки прозвучали в докладе: «Доклад по телефону: кто вы ✓, адрес и
 * повод ✓, карточка ✗, что изменилось ✓» из строки оценщика «Части доклада службе …».
 * Нет строки (звонок без доклада, старые оценки) — `null`.
 */
export function reportParts(evidence: readonly string[]): string | null {
  const line = evidence.map(readable).find((item) => item.startsWith("Части"));
  const marks = line?.split(": ").slice(1).join(": ");
  return marks ? `Доклад по телефону: ${marks}` : null;
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

/** Крупный вердикт должен сразу показывать, кто принял решение. */
export function verdictHeading(
  verdict: AttemptVerdict,
  decision: "agree" | "disagree" | null,
): string {
  const source =
    decision === "agree"
      ? "Преподаватель подтвердил"
      : decision === "disagree"
        ? "Решение преподавателя"
        : "Автоматически, ждёт преподавателя";
  return `${source}: ${verdict.label.toLowerCase()}`;
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
  comments,
  teacherComment,
  helps = 0,
}: {
  criteria: readonly Criterion[];
  times: readonly TimeLine[];
  path: string;
  /** Все комментарии карточки, которые читает оценка (`statusComments`), по порядку. */
  comments: readonly { status: string | null; text: string }[];
  teacherComment: string;
  /** Сколько раз открывали подсказки (`helpsUsed`). */
  helps?: number;
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
  // «Получена службой» ставит система, а не диспетчер: в «что ожидалось» её нет, иначе
  // строки «ожидалось» и «сделано» расходятся без ошибки (проверка 17.10).
  if (reference)
    expected.push(
      `Статусы: ${reference.replace(/^Эталон:\s*/, "").replace(/^Получена службой → /, "")}`,
    );
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
    expected.push(
      "Доклад должностному лицу по телефону по памятке ДДС, с. 32: кто вы, адрес и повод, карточка, что изменилось",
    );
    done.push(
      (find("call")?.score ?? 0) > 0
        ? (reportParts(find("call")?.evidence ?? []) ??
            "Доклад по телефону был")
        : "Доклада по телефону не было",
    );
  }
  if (applies("comment_keywords") || applies("comment_completeness"))
    expected.push(
      "Комментарий: где, что случилось, какое решение, есть ли пострадавшие",
    );
  // Оценка читает все комментарии карточки, а не последний («уехали» при отказе):
  // показываем каждый, иначе сведения из «Принята» в разборе не видны.
  const written = comments.filter((item) => item.text.trim());
  if (written.length === 0) done.push("Комментарий пуст");
  for (const { status, text } of written) {
    const clean = text.trim();
    done.push(
      `Комментарий${status ? ` при «${status}»` : ""}: «${clean.length > 300 ? `${clean.slice(0, 300)}…` : clean}»`,
    );
  }
  if (helps > 0)
    done.push(
      `Подсказки открыты ${helps} ${timesWord(helps)}: на оценку помощь не влияет`,
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

interface ExactRow {
  /** Секунды от показа карточки, без округления. */
  at: number;
  label: string;
  over: boolean;
}

/** Все действия ленты (TC-11): кроме статусов и звонков — отбой, ответы бригаде, доклады. */
type Detail = "short" | "full";

function timelineRows(
  events: readonly StoredEvent[],
  deliveredAt: string | null,
  verdicts: TimeVerdicts | null,
  detail: Detail,
): ExactRow[] {
  if (events.length === 0) return [];
  const sorted = [...events].sort(
    (a, b) => Date.parse(a.server_ts) - Date.parse(b.server_ts),
  );
  const start = Date.parse(deliveredAt ?? sorted[0].server_ts);
  const seconds = (event: StoredEvent) =>
    Math.max(0, (Date.parse(event.server_ts) - start) / 1000);
  const dialed = new Map<string, string>();
  const rows: ExactRow[] = [];
  const kinds: ("primary" | "final" | null)[] = [];
  const full = detail === "full";
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
    else if (full && event.type === "call_hangup")
      label = `${dialed.get(callId) ?? "Звонок"} — отбой`;
    else if (full && event.type === "message_presented")
      label =
        payload.channel === "audio"
          ? "Доклад бригады прослушан"
          : "Доклад бригады показан";
    else if (full && event.type === "brigade_reply") {
      const text = String(payload.text ?? "").trim();
      label = text ? `Ответ бригаде: «${text}»` : "Ответ бригаде";
    } else if (full && event.type === "comment") label = "Комментарий";
    else if (full && event.type === "hint_open") label = "Подсказка";
    if (label) {
      rows.push({ at, label, over: false });
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
  return timelineRows(events, deliveredAt, verdicts, "short").map((row) => ({
    ...row,
    at: Math.round(row.at),
  }));
}

export interface FeedRow extends TimelineRow {
  /** Секунды с прошлого действия, до десятых; у первого — с показа карточки. */
  since: number;
}

/**
 * Лента действий (TC-11, docs/dds_touches.md): хронология со всеми действиями — отбой,
 * доклады бригады, ответы ей, комментарии, подсказки — и отметкой «+12,3 с» с прошлого
 * действия. Паузы видны сразу: где обучаемый ждал, а где медлил сам.
 */
export function actionFeed(
  events: readonly StoredEvent[],
  deliveredAt: string | null,
  verdicts: TimeVerdicts | null,
): FeedRow[] {
  const rows = timelineRows(events, deliveredAt, verdicts, "full");
  return rows.map((row, index) => ({
    at: Math.round(row.at),
    label: row.label,
    over: row.over,
    since:
      Math.round((row.at - (index > 0 ? rows[index - 1].at : 0)) * 10) / 10,
  }));
}

/** Отметка ленты: «+12,3 с»; от минуты — «+1 мин 05 с». */
export function sinceText(seconds: number): string {
  if (seconds < 60) return `+${seconds.toFixed(1).replace(".", ",")} с`;
  const whole = Math.round(seconds);
  return `+${Math.floor(whole / 60)} мин ${String(whole % 60).padStart(2, "0")} с`;
}

/**
 * Сводка «Все критерии» (TC-11): сколько совпало с правилами (полный балл) и сколько
 * расхождений. Критерии, которых в сценарии нет («не требуется»), не считаются ни там, ни там.
 */
export function criteriaSummary(criteria: readonly Criterion[]): {
  matched: number;
  differ: number;
} {
  const counted = criteria.filter(
    (item) => item.weight > 0 && !notApplicable(item),
  );
  const differ = counted.filter((item) => item.score < 1).length;
  return { matched: counted.length - differ, differ };
}

/** Фильтр «только расхождения»: критерии с баллом ниже полного. */
export function differences(criteria: readonly Criterion[]): Criterion[] {
  return criteria.filter(
    (item) => item.weight > 0 && !notApplicable(item) && item.score < 1,
  );
}

export interface CallReview {
  id: string;
  label: string;
  /** Секунды от показа карточки до начала звонка; null — в журнале нет. */
  at: number | null;
  /** Запись звонка (сказанное), если сохранена. */
  audioUrl: string | null;
  /** Распознанное: текст записи и ответы бригаде голосом. */
  recognized: string[];
  /** Записанное в комментарий первым статусом или комментарием после звонка. */
  written: string | null;
}

/**
 * Разбор звонков (TC-11): у звонка с записью или распознанным текстом — сказанное (запись),
 * распознанное и записанное в комментарий после него, чтобы сверить одно с другим.
 */
export function callReviews(
  calls: readonly Call[],
  events: readonly StoredEvent[],
  deliveredAt: string | null,
): CallReview[] {
  const sorted = [...events].sort(
    (a, b) => Date.parse(a.server_ts) - Date.parse(b.server_ts),
  );
  const start = Date.parse(deliveredAt ?? sorted[0]?.server_ts ?? "");
  const payloadOf = (event: StoredEvent) =>
    event.payload as Record<string, unknown>;
  const reviews: CallReview[] = [];
  for (const call of calls) {
    const own = sorted.filter(
      (event) => String(payloadOf(event).call_id ?? "") === call.id,
    );
    const recognized = [
      call.transcript?.trim() ?? "",
      ...own
        .filter(
          (event) =>
            event.type === "brigade_reply" && payloadOf(event).mode === "voice",
        )
        .map((event) => String(payloadOf(event).text ?? "").trim()),
    ].filter(Boolean);
    if (!call.audio_url && recognized.length === 0) continue;
    const target = own.some((event) => event.type === "call_dial_target");
    const label = target
      ? "Звонок бригаде"
      : call.direction === "inbound"
        ? "Бригада звонила"
        : `Звонок ${call.phone_ext}`;
    const first = own[0];
    const last = own[own.length - 1];
    const after = last ? Date.parse(last.server_ts) : Number.NaN;
    const comment = sorted.find(
      (event) =>
        (event.type === "status_change" || event.type === "comment") &&
        Date.parse(event.server_ts) >= after,
    );
    reviews.push({
      id: call.id,
      label,
      at:
        first && Number.isFinite(start)
          ? Math.max(
              0,
              Math.round((Date.parse(first.server_ts) - start) / 1000),
            )
          : null,
      audioUrl: call.audio_url,
      recognized,
      written: comment
        ? String(payloadOf(comment).comment ?? "").trim() || null
        : null,
    });
  }
  return reviews.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}
