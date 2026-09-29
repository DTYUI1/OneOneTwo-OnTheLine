import { describe, expect, it } from "vitest";
import {
  actionLabel,
  actorless,
  adminWarnings,
  ago,
  backupBusy,
  backupSource,
  backupTime,
  describeStatus,
  liveUsers,
  trashReasonProblem,
  trashWaiting,
  formatBytes,
  auditChanges,
  describeHealth,
  entityLabel,
  emptyDraft,
  generatePassword,
  orderedWeightKeys,
  passwordProblem,
  screenName,
  settingsChanged,
  toCreate,
  toUpdate,
  userMatches,
  validateSettings,
  validateUserDraft,
  withRole,
  type AuditEntry,
  type BackupRun,
  type Settings,
  type SystemStatus,
  type User,
} from "./adminModel";

const base: Settings = {
  reaction_normative_s: 30,
  handling_normative_s: 180,
  critical_cap: 0.5,
  weights: {
    reaction_time: 1,
    handling_time: 1,
    status_flow: 1,
    routing: 1,
    required_fields: 1,
    address: 1,
    call: 1,
  },
  parallel_cards: 1,
  hints_level: 0,
  spelling_hints: false,
};

describe("нормативы и веса", () => {
  it("принимает настройки по умолчанию", () => {
    expect(validateSettings(base)).toEqual([]);
  });

  it("не пускает нулевой и дробный норматив", () => {
    expect(validateSettings({ ...base, reaction_normative_s: 0 })).toContain(
      "Норматив реакции — целое число секунд, не меньше 1.",
    );
    expect(
      validateSettings({ ...base, handling_normative_s: 2.5 }).length,
    ).toBeGreaterThan(0);
  });

  it("ловит отработку короче реакции", () => {
    expect(
      validateSettings({
        ...base,
        reaction_normative_s: 60,
        handling_normative_s: 30,
      }),
    ).toContain("Норматив отработки должен быть не меньше норматива реакции.");
  });

  it("держит границы параллельных карточек и потолка", () => {
    expect(validateSettings({ ...base, parallel_cards: 24 })).toContain(
      "Параллельных карточек — от 1 до 23.",
    );
    expect(validateSettings({ ...base, critical_cap: 1.5 })).toContain(
      "Потолок при критической ошибке — от 0 до 1.",
    );
  });

  it("не даёт обнулить все веса: итог Σ(w·s)/Σw не из чего сложить", () => {
    expect(
      validateSettings({ ...base, weights: { reaction_time: 0, routing: 0 } }),
    ).toContain("Все веса нулевые — итоговый балл не из чего сложить.");
    expect(
      validateSettings({
        ...base,
        weights: { ...base.weights, reaction_time: 0, routing: 2 },
      }),
    ).toEqual([]);
    expect(
      validateSettings({ ...base, weights: { reaction_time: -1, routing: 1 } }),
    ).toContain("Вес критерия не может быть отрицательным.");
  });

  it("ставит веса в порядке работы диспетчера, незнакомые — в конец", () => {
    expect(
      orderedWeightKeys({ call: 1, zeta: 1, reaction_time: 1, address: 1 }),
    ).toEqual(["reaction_time", "address", "call", "zeta"]);
  });

  it("не считает изменением другой порядок весов", () => {
    const reordered = {
      ...base,
      weights: Object.fromEntries(Object.entries(base.weights).reverse()),
    };
    expect(settingsChanged(base, reordered)).toBe(false);
    expect(settingsChanged(base, { ...base, parallel_cards: 2 })).toBe(true);
  });

  it("отклоняет неполный набор, бесконечный вес и переполнение суммы", () => {
    expect(validateSettings({ ...base, weights: {} })).toContain(
      "Нужны числовые веса всех семи критериев.",
    );
    expect(
      validateSettings({
        ...base,
        weights: { ...base.weights, call: Infinity },
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateSettings({
        ...base,
        weights: { ...base.weights, call: 1e308, address: 1e308 },
      }),
    ).toContain("Сумма весов должна быть конечной.");
  });
});

describe("состояние системы", () => {
  it("пишет словами и красит по смыслу", () => {
    const items = describeHealth({
      status: "degraded",
      mode: "database",
      database: "ok",
      worker: "error",
      ai_provider: "off",
    });
    const byLabel = Object.fromEntries(items.map((item) => [item.label, item]));
    expect(byLabel["Итог"]).toMatchObject({ value: "есть сбой", tone: "bad" });
    expect(byLabel["База данных"]).toMatchObject({
      value: "подключена",
      tone: "ok",
    });
    expect(byLabel["Фоновый обработчик"]).toMatchObject({
      value: "не отвечает",
      tone: "bad",
    });
    expect(byLabel["ИИ-оценка текста"].value).toBe("выключена");
  });
});

describe("сообщения об ошибках", () => {
  it("экран сообщения называется словами, без пути приложения", () => {
    expect(screenName("/app/arm")).toBe("АРМ диспетчера");
    expect(screenName("/app/arm/cards?tab=2")).toBe("АРМ диспетчера");
    expect(screenName("/app/results")).toBe("Мои результаты");
    expect(screenName("/app/teacher")).toBe("Пульт преподавателя");
    expect(screenName("/app/admin")).toBe("Администрирование");
    expect(screenName("/app/login")).toBe("Другой экран");
  });
});

describe("учётные записи (C-07)", () => {
  const draft = {
    ...emptyDraft(),
    login: "trainee06",
    full_name: "Обучаемый 06",
    password: "class-2026",
    workstation_number: 6,
    dds_service_id: "101",
  };

  it("правильная новая учётка проходит", () => {
    expect(validateUserDraft(draft, "create")).toEqual([]);
  });

  it("логин, пароль и ФИО — по правилам сервера", () => {
    const problems = validateUserDraft(
      { ...draft, login: "Иван", password: "short", full_name: "  " },
      "create",
    );
    expect(problems).toHaveLength(3);
    expect(validateUserDraft({ ...draft, login: "ab" }, "create")).toHaveLength(
      1,
    );
    expect(
      validateUserDraft({ ...draft, login: "t.ivanov-2" }, "create"),
    ).toEqual([]);
  });

  it("при правке логин и пароль не проверяются — их там нет", () => {
    expect(
      validateUserDraft({ ...draft, login: "", password: "" }, "edit"),
    ).toEqual([]);
  });

  it("смена роли очищает АРМ и службу, а не оставляет их молча", () => {
    const teacher = withRole(draft, "teacher");
    expect(teacher.workstation_number).toBeNull();
    expect(teacher.dds_service_id).toBeNull();
    expect(validateUserDraft(teacher, "create")).toEqual([]);
    expect(
      validateUserDraft({ ...draft, role: "teacher" }, "create"),
    ).toContain("АРМ и служба задаются только обучаемому.");
  });

  it("тело запроса без лишних полей и с обрезанным ФИО", () => {
    expect(toCreate({ ...draft, full_name: "  Иванов  " })).toEqual({
      login: "trainee06",
      full_name: "Иванов",
      role: "trainee",
      password: "class-2026",
      workstation_number: 6,
      dds_service_id: "101",
    });
    expect(toUpdate({ ...draft, is_active: false })).toEqual({
      full_name: "Обучаемый 06",
      role: "trainee",
      workstation_number: 6,
      dds_service_id: "101",
      is_active: false,
    });
  });

  it("временный пароль — 10 символов без похожих букв и цифр", () => {
    const password = generatePassword((bytes) => bytes.map((_, i) => i * 37));
    expect(password).toHaveLength(10);
    expect(password).toMatch(/^[a-km-z2-9]+$/);
    expect(password).not.toMatch(/[lo01]/);
    expect(passwordProblem(password)).toBeNull();
  });

  it("поиск и фильтры списка", () => {
    const user: User = {
      id: "u1",
      login: "ivanov",
      full_name: "Иванов Иван",
      role: "trainee",
      workstation_number: 3,
      dds_service_id: "102",
      is_active: false,
    };
    expect(userMatches(user, "иван", "all", "all")).toBe(true);
    expect(userMatches(user, "IVAN", "all", "all")).toBe(true);
    expect(userMatches(user, "петров", "all", "all")).toBe(false);
    expect(userMatches(user, "ivan", "trainee", "blocked")).toBe(true);
    expect(userMatches(user, "", "teacher", "all")).toBe(false);
    expect(userMatches(user, "", "all", "active")).toBe(false);
  });
});

describe("журнал аудита (C-07)", () => {
  const lookups = {
    userName: (id: string) => (id === "u1" ? "Иванов (ivanov)" : null),
    serviceName: (id: string) => (id === "102" ? "Служба 102" : null),
  };
  const base: AuditEntry = {
    id: "a1",
    ts: "2026-09-27T12:00:00.000Z",
    actor: null,
    action: "updateUser",
    category: "admin",
    entity: "users",
    entity_id: "u1",
    ok: true,
    status_code: null,
    before: null,
    after: null,
    details_hidden: false,
    ip: null,
  };

  it("действия и объекты — словами, без технических идентификаторов", () => {
    expect(actionLabel("createOverride")).toBe("Решение по оценке");
    expect(actionLabel("somethingNew")).toBe("Действие системы");
    expect(entityLabel(base, lookups)).toBe("Иванов (ivanov)");
    expect(entityLabel({ ...base, entity_id: null }, lookups)).toBe(
      "несуществующая учётная запись",
    );
    expect(
      entityLabel(
        { ...base, entity: "session", entity_id: "0caf000c" },
        lookups,
      ),
    ).toBe("занятие");
  });

  it("блокировка: только изменившееся поле, словами", () => {
    const changes = auditChanges(
      {
        ...base,
        before: { full_name: "Иванов", role: "trainee", is_active: true },
        after: { full_name: "Иванов", role: "trainee", is_active: false },
      },
      lookups,
    );
    expect(changes).toEqual([
      { label: "Доступ", before: "действует", after: "заблокирован" },
    ]);
  });

  it("создание учётки — заданные значения, служба по названию", () => {
    const changes = auditChanges(
      {
        ...base,
        action: "createUser",
        after: {
          login: "ivanov",
          full_name: "Иванов",
          role: "trainee",
          workstation_number: null,
          dds_service_id: "102",
          is_active: true,
        },
      },
      lookups,
    );
    expect(changes.map((c) => `${c.label}: ${c.after}`)).toEqual([
      "Логин: ivanov",
      "ФИО: Иванов",
      "Роль: обучаемый",
      "Служба: Служба 102",
      "Доступ: действует",
    ]);
  });

  it("служба, нормативы и пароль", () => {
    expect(
      auditChanges(
        {
          ...base,
          entity: "services",
          before: { is_active: true },
          after: { is_active: false },
        },
        lookups,
      ),
    ).toEqual([{ label: "Состояние", before: "включена", after: "выключена" }]);
    const settings = auditChanges(
      {
        ...base,
        entity: "settings",
        before: { reaction_normative_s: 30, weights: { address: 1, call: 1 } },
        after: { reaction_normative_s: 45, weights: { address: 2, call: 1 } },
      },
      lookups,
    );
    expect(settings).toEqual([
      { label: "Норматив реакции, с", before: "30", after: "45" },
      { label: "Вес: Адрес", before: "1", after: "2" },
    ]);
    expect(
      auditChanges({ ...base, after: { password_reset: true } }, lookups),
    ).toEqual([
      {
        label: "Пароль",
        before: null,
        after: "задан новый, сеансы пользователя закрыты",
      },
    ]);
  });
});

describe("состояние системы (C-07)", () => {
  const now = Date.parse("2026-09-27T12:00:00.000Z");
  const status: SystemStatus = {
    checked_at: "2026-09-27T12:00:00.000Z",
    database: { status: "ok", size_bytes: 52_428_800 },
    worker: { status: "ok", last_heartbeat_at: "2026-09-27T11:59:30.000Z" },
    realtime: { status: "ok", connections: 3, users_online: 2 },
    queue: { pending: 1, running: 0, failed: 2 },
    running_sessions: 1,
    machine: {
      cores: 8,
      load_1m: 0.4,
      memory_total_bytes: 32 * 1024 ** 3,
      memory_available_bytes: 20 * 1024 ** 3,
    },
    disk: { total_bytes: 500 * 1024 ** 3, free_bytes: 30 * 1024 ** 3 },
    backup: {
      status: "stale",
      last_at: "2026-09-25T02:00:00.000Z",
      count: 3,
      in_progress: false,
    },
    alerts: [
      { level: "error", message: "Фоновый обработчик не отвечает." },
      { level: "warning", message: "Последней резервной копии больше суток." },
    ],
  };

  it("байты и «сколько прошло» — по-русски", () => {
    expect(formatBytes(52_428_800)).toBe("50 МБ");
    expect(formatBytes(20 * 1024 ** 3)).toBe("20,0 ГБ");
    expect(formatBytes(500 * 1024 ** 3)).toBe("500 ГБ");
    expect(ago("2026-09-27T11:59:30.000Z", now)).toBe("30 с назад");
    expect(ago("2026-09-27T11:40:00.000Z", now)).toBe("20 мин назад");
    expect(ago("2026-09-25T02:00:00.000Z", now)).toBe("2 дн назад");
    expect(ago("2026-09-26T12:00:00.000Z", now)).toBe("24 ч назад");
    expect(ago("2026-09-20T12:00:00.000Z", now)).toBe("7 дн назад");
  });

  it("плитки: проблемы помечены, всё остальное — зелёное", () => {
    const tiles = Object.fromEntries(
      describeStatus(status, now).map((tile) => [tile.label, tile]),
    );
    expect(tiles["Очередь заданий"].value).toBe("с ошибкой: 2");
    expect(tiles["Очередь заданий"].tone).toBe("warn");
    expect(tiles["Резервные копии"].value).toBe("устарели");
    expect(tiles["Резервные копии"].hint).toMatch(/Последняя 2 дн назад/);
    // Время копии — по местному времени и без латиницы в интерфейсе.
    expect(tiles["Резервные копии"].hint).not.toMatch(/[A-Za-z]/);
    expect(backupTime()).toMatch(/^\d\d:00$/);
    expect(tiles["Место на диске"].tone).toBe("warn");
    expect(tiles["Нагрузка процессора"].value).toBe("0,4 на 8 ядер");
    expect(tiles["Канал обновлений"].hint).toMatch(/Онлайн: 2 чел\./);
    expect(tiles["Очередь заданий"].hint).toMatch(
      /Обработчик откликался 30 с назад\./,
    );
    // Обработчик уже есть в сводке капитана — второй плитки нет.
    expect(tiles["Фоновый обработчик"]).toBeUndefined();
  });

  it("полоса админки — только предупреждения: сбои уже в общей шапке", () => {
    expect(adminWarnings(status)).toEqual([
      "Последней резервной копии больше суток.",
    ]);
  });
});

describe("копии и корзина (C-07)", () => {
  const run = (patch: Partial<BackupRun>): BackupRun => ({
    id: "b1",
    status: "done",
    requested_by: null,
    requested_at: "2026-09-28T02:00:00.000Z",
    started_at: "2026-09-28T02:00:00.000Z",
    finished_at: "2026-09-28T02:01:00.000Z",
    name: "backup-20260928T020000Z",
    error: null,
    ...patch,
  });
  const now = Date.parse("2026-09-28T09:00:00.000Z");

  it("вторую копию кнопка не ставит, прерванная давно — не мешает", () => {
    expect(backupBusy([run({})], now)).toBe(false);
    expect(
      backupBusy([run({ status: "pending", started_at: null })], now),
    ).toBe(true);
    expect(
      backupBusy(
        [run({ status: "running", started_at: "2026-09-28T08:59:00.000Z" })],
        now,
      ),
    ).toBe(true);
    // Идёт дольше 6 часов — прервана перезапуском, backup-poll отметит ошибкой.
    expect(backupBusy([run({ status: "running" })], now)).toBe(false);
  });

  it("кто запустил копию — словами", () => {
    const names = (id: string) => (id === "a1" ? "Администратор" : null);
    expect(backupSource(run({}), names)).toBe("по расписанию или из консоли");
    expect(backupSource(run({ requested_by: "a1" }), names)).toBe(
      "по кнопке · Администратор",
    );
    expect(backupSource(run({ requested_by: "zz" }), names)).toBe(
      "по кнопке · администратор",
    );
  });

  it("причина удаления обязательна и попадает в журнал", () => {
    expect(trashReasonProblem("  ")).toMatch(/Укажите причину/);
    expect(trashReasonProblem("Выбыл")).toBeNull();
    expect(trashReasonProblem("я".repeat(301))).toMatch(/300/);
  });

  it("удалённые не видны в общем списке, корзина считает ждущих копии", () => {
    const user = (id: string, deleted_at: string | null = null): User => ({
      id,
      login: id,
      full_name: id,
      role: "trainee",
      workstation_number: null,
      dds_service_id: null,
      is_active: deleted_at === null,
      deleted_at,
    });
    expect(
      liveUsers([user("a"), user("b", "2026-09-28T09:00:00.000Z")]).map(
        (item) => item.id,
      ),
    ).toEqual(["a"]);
    const item = {
      kind: "user" as const,
      id: "b",
      title: "b",
      login: "b",
      role: "trainee" as const,
      reason: "Выбыл",
      deleted_at: "2026-09-28T09:00:00.000Z",
      deleted_by: null,
      purged_at: null,
    };
    expect(
      trashWaiting({
        last_backup_at: null,
        items: [
          { ...item, state: "waiting_backup" },
          { ...item, id: "c", state: "purged", purged_at: item.deleted_at },
        ],
      }),
    ).toBe(1);
  });

  it("журнал: удаление, обезличивание и копия — словами", () => {
    expect(actionLabel("trashUser")).toBe("Удаление учётной записи в корзину");
    expect(actionLabel("purgeUser")).toBe(
      "Обезличивание после резервной копии",
    );
    expect(actorless("purgeUser")).toBe("система");
    expect(actorless("login")).toBe("не вошёл");
    const lookups = { userName: () => null, serviceName: () => null };
    const trashed = {
      entity: "users",
      before: { login: "t1", is_active: true, deleted_at: null },
      after: {
        login: "t1",
        is_active: false,
        deleted_at: "2026-09-28T09:00:00.000Z",
        reason: "Выбыл",
      },
    } as unknown as AuditEntry;
    expect(auditChanges(trashed, lookups)).toEqual([
      { label: "Доступ", before: "действует", after: "заблокирован" },
      { label: "Корзина", before: "—", after: "в корзине" },
      { label: "Причина удаления", before: "—", after: "Выбыл" },
    ]);
    const backup = {
      entity: "backups",
      before: null,
      after: { status: "pending" },
    } as unknown as AuditEntry;
    expect(auditChanges(backup, lookups)).toEqual([
      {
        label: "Копия",
        before: null,
        after: "запрошена — начнётся в течение минуты",
      },
    ]);
  });
});
