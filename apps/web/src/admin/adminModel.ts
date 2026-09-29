// Администрирование (T-016): чистая логика без React и сети.
import type { components } from "../api-client/schema";
import {
  COMMENT_CRITERION_LABELS,
  CRITERION_LABELS,
  criterionLabel,
} from "../teacher/console/model";

export type Settings = components["schemas"]["Settings"];
export type Health = components["schemas"]["Health"];
export type User = components["schemas"]["User"];

export const ROLE_LABELS: Record<User["role"], string> = {
  trainee: "обучаемый",
  teacher: "преподаватель",
  admin: "администратор",
};

/** Рабочих мест в классе — 23 (Q&A Q25); это же верхняя граница в контракте. */
export const MAX_PARALLEL = 23;

/**
 * Проверка настроек до отправки — те же границы, что в контракте Settings:
 * сервер тоже проверит, но администратор должен увидеть причину сразу.
 */
export function validateSettings(value: Settings): string[] {
  const problems: string[] = [];
  const whole = (n: number) => Number.isInteger(n);
  if (!whole(value.reaction_normative_s) || value.reaction_normative_s < 1)
    problems.push("Норматив реакции — целое число секунд, не меньше 1.");
  if (!whole(value.handling_normative_s) || value.handling_normative_s < 1)
    problems.push("Норматив отработки — целое число секунд, не меньше 1.");
  if (
    value.reaction_normative_s >= 1 &&
    value.handling_normative_s >= 1 &&
    value.handling_normative_s < value.reaction_normative_s
  )
    problems.push(
      "Норматив отработки должен быть не меньше норматива реакции.",
    );
  if (
    !whole(value.parallel_cards) ||
    value.parallel_cards < 1 ||
    value.parallel_cards > MAX_PARALLEL
  )
    problems.push(`Параллельных карточек — от 1 до ${MAX_PARALLEL}.`);
  if (
    Number.isNaN(value.critical_cap) ||
    value.critical_cap < 0 ||
    value.critical_cap > 1
  )
    problems.push("Потолок при критической ошибке — от 0 до 1.");
  const weights = Object.values(value.weights);
  if (
    weights.some(
      (weight) =>
        typeof weight !== "number" || !Number.isFinite(weight) || weight < 0,
    )
  )
    problems.push("Вес критерия не может быть отрицательным.");
  if (
    Object.keys(CRITERION_LABELS).some(
      (key) => weightValue(value.weights, key) === undefined,
    )
  )
    problems.push("Нужны числовые веса всех семи критериев.");
  if (
    !Number.isFinite(
      weights.reduce<number>(
        (sum, weight) => sum + (typeof weight === "number" ? weight : 0),
        0,
      ),
    )
  )
    problems.push("Сумма весов должна быть конечной.");
  if (weights.length > 0 && weights.every((weight) => weight === 0))
    problems.push("Все веса нулевые — итоговый балл не из чего сложить.");
  return problems;
}

/** Generated union включает required-поля; неизвестное значение не подменяем нулём. */
export function weightValue(
  weights: Settings["weights"],
  key: string,
): number | undefined {
  const value: unknown = Object.entries(weights).find(
    ([name]) => name === key,
  )?.[1];
  return typeof value === "number" ? value : undefined;
}

/** Есть ли несохранённые изменения. */
export function settingsChanged(a: Settings, b: Settings): boolean {
  return JSON.stringify(normalize(a)) !== JSON.stringify(normalize(b));
}

function normalize(value: Settings) {
  return {
    ...value,
    weights: Object.fromEntries(
      Object.entries(value.weights).sort(([x], [y]) => x.localeCompare(y)),
    ),
  };
}

export type Tone = "ok" | "bad" | "neutral";

/**
 * Состояние системы словами. Коды из Health переводим в то, что администратор
 * класса поймёт без документации, и в тон: зелёный, красный или нейтральный.
 */
export function describeHealth(health: Health): {
  label: string;
  value: string;
  hint: string;
  tone: Tone;
}[] {
  return [
    {
      label: "Итог",
      value: health.status === "ok" ? "всё работает" : "есть сбой",
      hint: "Сводка по базе и фоновому обработчику.",
      tone: health.status === "ok" ? "ok" : "bad",
    },
    {
      label: "База данных",
      value: {
        ok: "подключена",
        error: "ошибка",
        not_connected: "не подключена",
      }[health.database],
      hint: "Хранит занятия, карточки, события и оценки.",
      tone:
        health.database === "ok"
          ? "ok"
          : health.database === "error"
            ? "bad"
            : "neutral",
    },
    {
      label: "Фоновый обработчик",
      value: { ok: "работает", error: "не отвечает", stub: "заглушка" }[
        health.worker
      ],
      hint: "Выдаёт карточки по расписанию занятия и запускает оценку.",
      tone:
        health.worker === "ok"
          ? "ok"
          : health.worker === "error"
            ? "bad"
            : "neutral",
    },
    {
      label: "Режим сервера",
      value: {
        database: "рабочий",
        mock: "демонстрационный (без базы)",
        skeleton: "каркас",
      }[health.mode],
      hint: "В демонстрационном режиме данные живут в памяти и пропадают при перезапуске.",
      tone: health.mode === "database" ? "ok" : "neutral",
    },
    {
      label: "ИИ-оценка текста",
      value: health.ai_provider === "off" ? "выключена" : health.ai_provider,
      hint: "Проверка понятности свободного текста в карточке.",
      tone: "neutral",
    },
  ];
}

/**
 * Критерии в порядке работы диспетчера (как в CRITERION_LABELS: реакция →
 * отработка → статусы → службы → поля → адрес → доклад), затем критерии комментария,
 * незнакомые — в конце.
 */
export function orderedWeightKeys(weights: Settings["weights"]): string[] {
  const known = [
    ...Object.keys(CRITERION_LABELS),
    ...Object.keys(COMMENT_CRITERION_LABELS),
  ];
  const rank = (key: string) =>
    known.includes(key) ? known.indexOf(key) : known.length;
  return Object.keys(weights).sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  );
}

/**
 * Экран, с которого пришло сообщение об ошибке, — словами. В сообщении хранится путь
 * приложения; администратору он не нужен, а латиница на экране запрещена правилами UI.
 */
export function screenName(page: string): string {
  const path = page.replace(/^\/app(?=\/|$)/, "");
  if (path.startsWith("/arm")) return "АРМ диспетчера";
  if (path.startsWith("/results")) return "Мои результаты";
  if (path.startsWith("/teacher")) return "Пульт преподавателя";
  if (path.startsWith("/admin")) return "Администрирование";
  return "Другой экран";
}

// Учётные записи (C-07). Правила — те же, что у сервера (UserCreate/UserUpdate),
// чтобы администратор видел причину до отправки.
export type UserCreate = components["schemas"]["UserCreate"];
export type UserUpdate = components["schemas"]["UserUpdate"];

export const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 128;
export const MAX_FULL_NAME = 120;

export interface UserDraft {
  login: string;
  full_name: string;
  role: User["role"];
  password: string;
  workstation_number: number | null;
  dds_service_id: string | null;
  is_active: boolean;
}

export function emptyDraft(): UserDraft {
  return {
    login: "",
    full_name: "",
    role: "trainee",
    password: "",
    workstation_number: null,
    dds_service_id: null,
    is_active: true,
  };
}

export function draftFromUser(user: User): UserDraft {
  return { ...user, password: "" };
}

/** АРМ и служба профиля — только у обучаемого: при смене роли они очищаются. */
export function withRole(draft: UserDraft, role: User["role"]): UserDraft {
  return role === "trainee"
    ? { ...draft, role }
    : { ...draft, role, workstation_number: null, dds_service_id: null };
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD)
    return `Пароль — не короче ${MIN_PASSWORD} символов.`;
  if (password.length > MAX_PASSWORD)
    return `Пароль — не длиннее ${MAX_PASSWORD} символов.`;
  return null;
}

export function validateUserDraft(
  draft: UserDraft,
  mode: "create" | "edit",
): string[] {
  const problems: string[] = [];
  const name = draft.full_name.trim();
  if (!name) problems.push("Укажите ФИО.");
  else if (name.length > MAX_FULL_NAME)
    problems.push(`ФИО — не длиннее ${MAX_FULL_NAME} символов.`);
  if (mode === "create") {
    if (!LOGIN_PATTERN.test(draft.login))
      problems.push(
        "Логин: 3–32 символа — строчные латинские буквы, цифры, точка, дефис или подчёркивание; начинается с буквы или цифры.",
      );
    const password = passwordProblem(draft.password);
    if (password) problems.push(password);
  }
  if (
    draft.role !== "trainee" &&
    (draft.workstation_number !== null || draft.dds_service_id !== null)
  )
    problems.push("АРМ и служба задаются только обучаемому.");
  return problems;
}

export function toCreate(draft: UserDraft): UserCreate {
  return {
    login: draft.login,
    full_name: draft.full_name.trim(),
    role: draft.role,
    password: draft.password,
    workstation_number: draft.workstation_number,
    dds_service_id: draft.dds_service_id,
  };
}

export function toUpdate(draft: UserDraft): UserUpdate {
  return {
    full_name: draft.full_name.trim(),
    role: draft.role,
    workstation_number: draft.workstation_number,
    dds_service_id: draft.dds_service_id,
    is_active: draft.is_active,
  };
}

// Без похожих символов (l/1, o/0): пароль диктуют вслух или пишут на листке.
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** Временный пароль из 10 символов; источник случайности — криптографический. */
export function generatePassword(
  random: (bytes: Uint8Array) => Uint8Array = (bytes) =>
    crypto.getRandomValues(bytes),
): string {
  const bytes = random(new Uint8Array(10));
  return Array.from(
    bytes,
    (byte) => PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length],
  ).join("");
}

export type RoleFilter = User["role"] | "all";
export type StatusFilter = "all" | "active" | "blocked";

/** Поиск по ФИО и логину без учёта регистра и фильтры по роли и доступу. */
export function userMatches(
  user: User,
  query: string,
  role: RoleFilter,
  status: StatusFilter,
): boolean {
  const needle = query.trim().toLowerCase();
  if (role !== "all" && user.role !== role) return false;
  if (status === "active" && !user.is_active) return false;
  if (status === "blocked" && user.is_active) return false;
  return (
    !needle ||
    user.full_name.toLowerCase().includes(needle) ||
    user.login.includes(needle)
  );
}

// Журнал аудита (C-07): названия действий и объектов словами, изменения «было → стало».
export type AuditEntry = components["schemas"]["AuditEntry"];
export type AuditCategory = AuditEntry["category"] | "all";

export const AUDIT_CATEGORIES: Record<AuditCategory, string> = {
  admin: "администрирование",
  access: "входы и выходы",
  training: "учебный процесс",
  technical: "технические",
  all: "все",
};

export const ACTION_LABELS: Record<string, string> = {
  login: "Вход",
  logout: "Выход",
  createUser: "Создание учётной записи",
  updateUser: "Изменение учётной записи",
  resetUserPassword: "Новый пароль",
  trashUser: "Удаление учётной записи в корзину",
  restoreUser: "Восстановление из корзины",
  purgeUser: "Обезличивание после резервной копии",
  requestBackup: "Резервная копия по кнопке",
  updateService: "Включение или выключение службы",
  updateSettings: "Нормативы и оценка класса",
  registerClockSample: "Замер часов",
  createScenario: "Создание сценария",
  updateScenario: "Правка сценария",
  retireScenario: "Сценарий в архив",
  previewScenario: "Сборка сценария по классификатору",
  reviseScenario: "Доработка сценария",
  updateScenarioContent: "Правка эталона",
  generatePack: "Генерация пакета",
  approvePack: "Утверждение пакета",
  createSession: "Создание занятия",
  startSession: "Начало занятия",
  finishSession: "Завершение занятия",
  createAssignment: "Выдача задания",
  createAssignmentBatch: "Выдача заданий пачкой",
  postEvent: "Действие по карточке",
  uploadAudio: "Запись звонка",
  createOverride: "Решение по оценке",
  uploadMaterial: "Загрузка материала",
  assignMaterials: "Справка на занятие",
};

const ENTITY_LABELS: Record<string, string> = {
  auth_sessions: "сеанс",
  session: "занятие",
  scenario: "сценарий",
  scenario_pack: "пакет сценариев",
  job: "генерация пакета",
  card_event: "карточка",
  clock_sample: "замер часов",
  assignment: "задание",
  assignment_batch: "выдача заданий",
  teacher_override: "оценка",
  call_audio: "запись звонка",
  material: "материал",
  session_materials: "справка занятия",
  settings: "нормативы класса",
  backups: "резервная копия",
};

/** Кто действовал, если человека нет: обезличивание делает сама система после копии. */
export function actorless(action: string): string {
  return action === "purgeUser" ? "система" : "не вошёл";
}

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? "Действие системы";
}

export interface AuditLookups {
  userName: (id: string) => string | null;
  serviceName: (id: string) => string | null;
}

/** Над чем выполнено действие — словами; технические идентификаторы не показываем. */
export function entityLabel(entry: AuditEntry, lookups: AuditLookups): string {
  if (entry.entity === "users")
    return entry.entity_id
      ? (lookups.userName(entry.entity_id) ?? "учётная запись")
      : "несуществующая учётная запись";
  if (entry.entity === "services")
    return entry.entity_id
      ? (lookups.serviceName(entry.entity_id) ?? "служба")
      : "служба";
  return ENTITY_LABELS[entry.entity] ?? "—";
}

export interface AuditChange {
  label: string;
  before: string | null;
  after: string;
}

const USER_FIELDS: [string, string][] = [
  ["login", "Логин"],
  ["full_name", "ФИО"],
  ["role", "Роль"],
  ["workstation_number", "АРМ"],
  ["dds_service_id", "Служба"],
  ["is_active", "Доступ"],
  ["deleted_at", "Корзина"],
  ["reason", "Причина удаления"],
];
const SETTINGS_FIELDS: [string, string][] = [
  ["reaction_normative_s", "Норматив реакции, с"],
  ["handling_normative_s", "Норматив отработки, с"],
  ["parallel_cards", "Параллельных карточек"],
  ["hints_level", "Подсказки новичку"],
  ["spelling_hints", "Подсказки орфографии"],
  ["critical_cap", "Потолок при критической ошибке"],
];

type Json = Record<string, unknown> | null | undefined;

function show(
  entity: string,
  key: string,
  value: unknown,
  lookups: AuditLookups,
): string {
  if (value === null || value === undefined) return "—";
  if (key === "is_active")
    return entity === "services"
      ? value
        ? "включена"
        : "выключена"
      : value
        ? "действует"
        : "заблокирован";
  if (key === "role")
    return ROLE_LABELS[value as User["role"]] ?? String(value);
  if (key === "dds_service_id")
    return lookups.serviceName(String(value)) ?? String(value);
  if (key === "hints_level" || key === "spelling_hints")
    return value ? "включены" : "выключены";
  if (key === "deleted_at") return "в корзине";
  if (key === "status" && entity === "backups")
    return BACKUP_STATUSES[value as BackupRun["status"]] ?? String(value);
  return String(value);
}

/** Что изменилось — по известным полям; для создания — заданные значения. */
export function auditChanges(
  entry: AuditEntry,
  lookups: AuditLookups,
): AuditChange[] {
  const before = entry.before as Json;
  const after = entry.after as Json;
  if (!after) return [];
  if (after.password_reset)
    return [
      {
        label: "Пароль",
        before: null,
        after: "задан новый, сеансы пользователя закрыты",
      },
    ];
  const fields: [string, string][] =
    entry.entity === "users"
      ? USER_FIELDS
      : entry.entity === "services"
        ? [["is_active", "Состояние"]]
        : entry.entity === "backups"
          ? [["status", "Копия"]]
          : entry.entity === "settings"
            ? [
                ...SETTINGS_FIELDS,
                ...Object.keys(
                  (after.weights as Record<string, unknown>) ?? {},
                ).map((key): [string, string] => [
                  `weights.${key}`,
                  `Вес: ${criterionLabel(key)}`,
                ]),
              ]
            : [];
  const read = (value: Json, path: string): unknown =>
    path
      .split(".")
      .reduce<unknown>(
        (node, key) =>
          node && typeof node === "object"
            ? (node as Record<string, unknown>)[key]
            : undefined,
        value,
      );
  const changes: AuditChange[] = [];
  for (const [path, label] of fields) {
    const next = read(after, path);
    if (next === undefined) continue;
    const key = path.split(".")[0];
    if (before) {
      const previous = read(before, path);
      if (JSON.stringify(previous) === JSON.stringify(next)) continue;
      changes.push({
        label,
        before: show(entry.entity, key, previous, lookups),
        after: show(entry.entity, key, next, lookups),
      });
    } else if (next !== null) {
      changes.push({
        label,
        before: null,
        after: show(entry.entity, key, next, lookups),
      });
    }
  }
  return changes;
}

// Состояние системы (C-07): расширенные плитки из GET /admin/status.
export type SystemStatus = components["schemas"]["SystemStatus"];

export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 100 ? 0 : 1).replace(".", ",")} ГБ`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} МБ`;
}

/** «2 мин назад», «3 ч назад», «2 дн назад» — для отклика и последней копии. */
export function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds} с назад`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

/** Время ежедневной копии (cron 02:00 по Гринвичу) — в часовом поясе браузера. */
export function backupTime(): string {
  const at = new Date();
  at.setUTCHours(2, 0, 0, 0);
  return at.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export interface StatusTile {
  label: string;
  value: string;
  hint: string;
  tone: Tone | "warn";
}

export function describeStatus(
  status: SystemStatus,
  now: number,
): StatusTile[] {
  const tiles: StatusTile[] = [];
  tiles.push({
    label: "Канал обновлений",
    value: status.realtime.status === "ok" ? "работает" : "не работает",
    hint: `Онлайн: ${status.realtime.users_online} чел., открытых вкладок: ${status.realtime.connections}.`,
    tone: status.realtime.status === "ok" ? "ok" : "bad",
  });
  const { pending, running, failed } = status.queue;
  tiles.push({
    label: "Очередь заданий",
    value: failed > 0 ? `с ошибкой: ${failed}` : "без ошибок",
    hint:
      `Ждут: ${pending}, выполняются: ${running}. ` +
      (status.worker.last_heartbeat_at
        ? `Обработчик откликался ${ago(status.worker.last_heartbeat_at, now)}.`
        : "Обработчик ещё не откликался."),
    tone: failed > 0 ? "warn" : "ok",
  });
  tiles.push({
    label: "Идёт занятий",
    value: String(status.running_sessions),
    hint: "Занятия, которые преподаватели начали и ещё не завершили.",
    tone: "neutral",
  });
  const machine = status.machine;
  tiles.push({
    label: "Нагрузка процессора",
    value:
      machine.load_1m === null
        ? "нет данных"
        : `${String(machine.load_1m).replace(".", ",")} на ${machine.cores} ядер`,
    hint: "Средняя загрузка за минуту: выше числа ядер — сервер не успевает.",
    tone:
      machine.load_1m === null
        ? "neutral"
        : machine.load_1m > machine.cores * 2
          ? "warn"
          : "ok",
  });
  if (
    machine.memory_total_bytes !== null &&
    machine.memory_available_bytes !== null
  )
    tiles.push({
      label: "Память",
      value: `свободно ${formatBytes(machine.memory_available_bytes)}`,
      hint: `Всего ${formatBytes(machine.memory_total_bytes)}.`,
      tone:
        machine.memory_available_bytes < machine.memory_total_bytes * 0.1
          ? "warn"
          : "ok",
    });
  if (status.disk)
    tiles.push({
      label: "Место на диске",
      value: `свободно ${formatBytes(status.disk.free_bytes)}`,
      hint: `Всего ${formatBytes(status.disk.total_bytes)}; база занимает ${
        status.database.size_bytes === null
          ? "—"
          : formatBytes(status.database.size_bytes)
      }.`,
      tone:
        status.disk.free_bytes < status.disk.total_bytes * 0.1 ? "warn" : "ok",
    });
  const backup = status.backup;
  tiles.push({
    label: "Резервные копии",
    value: {
      ok: "свежие",
      stale: "устарели",
      missing: "нет копий",
      unknown: "нет данных",
    }[backup.status],
    hint:
      (backup.last_at
        ? `Последняя ${ago(backup.last_at, now)} (${new Date(backup.last_at).toLocaleString("ru-RU")}), всего ${backup.count}. `
        : "") +
      (backup.in_progress ? "Сейчас идёт копирование. " : "") +
      `Копия делается каждый день в ${backupTime()}.`,
    tone: backup.status === "ok" ? "ok" : "warn",
  });
  return tiles;
}

/** Предупреждения для полосы на всех страницах админки: сбои компонентов уже в шапке. */
export function adminWarnings(status: SystemStatus): string[] {
  return status.alerts
    .filter((alert) => alert.level === "warning")
    .map((alert) => alert.message);
}

// Корзина и резервные копии (C-07): удаление — пометка, обезличивание — после копии.
export type TrashList = components["schemas"]["TrashList"];
export type TrashItem = components["schemas"]["TrashItem"];
export type BackupRun = components["schemas"]["BackupRun"];

export const TRASH_STATES: Record<TrashItem["state"], string> = {
  waiting_backup: "ждёт резервной копии",
  ready: "копия есть — обезличится в течение минуты",
  purged: "обезличено",
};

export const BACKUP_STATUSES: Record<BackupRun["status"], string> = {
  pending: "запрошена — начнётся в течение минуты",
  running: "идёт",
  done: "готова",
  failed: "не удалась",
};

export const MIN_TRASH_REASON = 3;
export const MAX_TRASH_REASON = 300;

export function trashReasonProblem(reason: string): string | null {
  const length = reason.trim().length;
  if (length < MIN_TRASH_REASON)
    return "Укажите причину удаления — она попадёт в журнал аудита.";
  if (length > MAX_TRASH_REASON)
    return `Причина — не длиннее ${MAX_TRASH_REASON} символов.`;
  return null;
}

/** Действующие учётки: удалённые живут в корзине, а в общем списке не показываются. */
export function liveUsers(users: User[]): User[] {
  return users.filter((user) => !user.deleted_at);
}

// Копия «идёт» дольше — прервана, контейнер backup отметит её ошибкой (backup-poll).
const RUNNING_STALE_MS = 6 * 60 * 60 * 1000;

/** Уже запрошена или идёт — вторую кнопка не ставит (сервер ответит 409). */
export function backupBusy(runs: BackupRun[], now: number): boolean {
  return runs.some(
    (run) =>
      run.status === "pending" ||
      (run.status === "running" &&
        run.started_at !== null &&
        now - Date.parse(run.started_at) < RUNNING_STALE_MS),
  );
}

/** Кто запустил копию: ночные и консольные — без автора. */
export function backupSource(
  run: BackupRun,
  userName: (id: string) => string | null,
): string {
  if (!run.requested_by) return "по расписанию или из консоли";
  return `по кнопке · ${userName(run.requested_by) ?? "администратор"}`;
}

export function moment(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("ru-RU") : "—";
}

/** Сколько учёток ждут копии: после неё их ФИО и логины сотрутся. */
export function trashWaiting(list: TrashList): number {
  return list.items.filter((item) => item.state !== "purged").length;
}
