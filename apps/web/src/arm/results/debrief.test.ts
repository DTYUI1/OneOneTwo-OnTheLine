import { describe, expect, it } from "vitest";
import {
  actionFeed,
  afterAction,
  attemptTimeline,
  attemptVerdict,
  buildDebrief,
  callReviews,
  criteriaSummary,
  criterionLevel,
  differences,
  criterionScoreLabel,
  focusFor,
  helpsUsed,
  LEVEL_LABELS,
  notApplicable,
  notApplicableLabels,
  partialReasonLabel,
  reportParts,
  repeatsExplanation,
  sinceText,
  scoreSourceLabel,
  traineeEvidence,
  verdictHeading,
} from "./debrief";

const criterion = (
  key: string,
  score: number,
  evidence: string[] = [],
  critical = false,
  weight = 1,
) => ({ key, score, weight, critical, evidence, explanation: "пояснение" });

describe("итоги попытки", () => {
  it("не показывает проценты за исключённые грамотность и время", () => {
    for (const key of ["spelling", "handling_time"]) {
      const unscored = criterion(key, 0, [], false, 0);
      expect(differences([unscored])).toEqual([]);
      expect(criteriaSummary([unscored])).toEqual({ matched: 0, differ: 0 });
      expect(criterionScoreLabel(criterion(key, 0, [], false, 0))).toBe(
        "не оценивается",
      );
    }
  });
  it("показывает балл критерия по отдельной шкале, не подменяя итог с весами", () => {
    expect(criterionScoreLabel(criterion("routing", 0.75, [], false, 3))).toBe(
      "75 из 100 · приемлемо",
    );
    expect(
      criterionScoreLabel(
        criterion("call", 1, ["Обязательный звонок не предусмотрен эталоном"]),
      ),
    ).toBe("не требуется");
  });

  it("различает автоматический итог и решение преподавателя", () => {
    expect(scoreSourceLabel(0.5, 0.8, "disagree")).toBe(
      "Автоматическая оценка: 50 % → после решения преподавателя: 80 %.",
    );
    expect(scoreSourceLabel(0.5, 0.5, "agree")).toContain(
      "преподаватель подтвердил",
    );
    expect(scoreSourceLabel(0.5, 0.5, null)).toContain(
      "решения преподавателя пока нет",
    );
    const passed = { passed: true, label: "Зачтено", detail: "" };
    expect(verdictHeading(passed, null)).toBe(
      "Автоматически, ждёт преподавателя: зачтено",
    );
    expect(verdictHeading(passed, "agree")).toBe(
      "Преподаватель подтвердил: зачтено",
    );
    expect(verdictHeading(passed, "disagree")).toBe(
      "Решение преподавателя: зачтено",
    );
  });

  it("объясняет частичную оценку без служебного имени слоя", () => {
    expect(
      partialReasonLabel(
        "Слой llm: Локальный ИИ-судья ещё не вернул проверенный ответ.",
      ),
    ).toBe(
      "Проверка свободного текста ИИ: Локальный ИИ-судья ещё не вернул проверенный ответ.",
    );
  });

  it("уровень словами вместо процентов", () => {
    expect(LEVEL_LABELS[criterionLevel(1)]).toBe("отлично");
    expect(LEVEL_LABELS[criterionLevel(0.8)]).toBe("хорошо");
    expect(LEVEL_LABELS[criterionLevel(0.5)]).toBe("приемлемо");
    expect(LEVEL_LABELS[criterionLevel(0.12)]).toBe("не освоено");
  });

  it("сначала критические ошибки, потом по потере балла; не больше трёх", () => {
    const result = buildDebrief([
      criterion("routing", 1),
      criterion("status_flow", 0.75, [
        "Эталон: Получена службой → Принята → Работы завершены",
      ]),
      criterion("reaction_time", 0.12, ["Реакция 56,4 с при нормативе 30 с"]),
      criterion("address", 0, [], true),
      criterion(
        "spelling",
        0.5,
        ["Проверено слов: 9, ошибок: 2", "«улце» → «улице»"],
        false,
        0.5,
      ),
      criterion("call", 0.9),
    ]);
    expect(result.good).toEqual(["Маршрутизация по службам"]);
    expect(result.improve.map((item) => item.key)).toEqual([
      "address",
      "reaction_time",
      "status_flow",
    ]);
    expect(result.improve[1].fact).toBe("Реакция 00:56 при нормативе 00:30");
    expect(result.improve[2].fact).toMatch(/^Эталон/);
    expect(result.improve[0].advice).toMatch(/уточнённый адрес в комментарии/);
    expect(result.improve[0].advice).not.toMatch(/Адрес — ввод диспетчера/);
  });

  it("не скрывает четвёртую критическую ошибку за лимитом главных замечаний", () => {
    const result = buildDebrief([
      criterion("call", 0, [], true),
      criterion("routing", 0, [], true),
      criterion("address", 0, [], true),
      criterion("status_flow", 0, [], true),
      criterion("reaction_time", 0.5),
    ]);
    expect(result.improve).toHaveLength(4);
    expect(result.improve.every((item) => item.critical)).toBe(true);
  });

  it("совет по звонку использует предъявленную смену задачи", () => {
    const result = buildDebrief([
      criterion(
        "call",
        0,
        [
          "Задача изменилась после доклада бригады: Загорелась машина — нужна пожарная охрана: сообщить в 112 (памятка ДДС, с. 32).",
          "Обязательный звонок отсутствует",
        ],
        true,
      ),
    ]);
    expect(result.improve[0].advice).toContain("сообщить в 112");
    expect(result.improve[0].advice).not.toContain("должностному лицу");
    expect(result.improve[0].advice.match(/памятка ДДС/g)).toHaveLength(1);
    expect(result.improve[0].fact).toBe("Обязательный звонок отсутствует");
  });

  it("при сброшенном звонке показывает отбой до доклада, а не только смену задачи", () => {
    const result = buildDebrief([
      criterion("call", 2 / 3, [
        "Задача изменилась после доклада бригады: Загорелась машина — сообщить в 112.",
        "Доклад службе 112: не сделан, трубка положена до доклада",
      ]),
    ]);
    expect(result.improve[0].fact).toContain("трубка положена до доклада");
    expect(result.improve[0].advice).toContain("112");
  });

  it("не прячет неверное перенаправление и две ошибки одного звонка", () => {
    const result = buildDebrief([
      criterion(
        "routing",
        0,
        [
          "Ожидались решения: Принята; получены: Перенаправлена",
          "Допустимые адресаты: 102; адресат перенаправления: 101",
        ],
        true,
      ),
      criterion(
        "call",
        0,
        [
          "Адресат 102/102: неверно",
          "Доклад службе 102: не сделан, трубка положена до доклада",
        ],
        true,
      ),
    ]);
    expect(result.improve[0].fact).toContain("адресат перенаправления: 101");
    expect(result.improve[1].fact).toContain("Адресат 102/102: неверно");
    expect(result.improve[1].fact).toContain("трубка положена до доклада");
  });

  it("статусы: называет, чего не хватает, а не требует работ всегда", () => {
    const flow = {
      ...criterion("status_flow", 0.6, [
        "Эталон: Получена службой → Принята → Отказ от выполнения работ",
      ]),
      explanation:
        "Не хватает: Отказ от выполнения работ. Лишние: Работы завершены.",
    };
    const [item] = buildDebrief([flow]).improve;
    expect(item.fact).toMatch(/^Не хватает: Отказ от выполнения работ/);
    expect(item.advice).not.toMatch(/работы, завершение/);
    expect(item.advice).toMatch(/Отказ от выполнения работ/);
  });

  it("опечатки и нехватка сведений — фактом из разбора", () => {
    const result = buildDebrief([
      criterion("spelling", 0.5, [
        "Проверено слов: 9, ошибок: 2",
        "«улце» → «улице»",
        "«улцеб» — нет в словаре",
      ]),
      criterion("comment_keywords", 0.5, [
        "Есть: Сведения о пострадавших",
        "Не хватает: Адрес",
      ]),
    ]);
    const fact = (key: string) =>
      result.improve.find((item) => item.key === key)?.fact;
    expect(fact("spelling")).toBe(
      "Ошибки: «улце» → «улице»; «улцеб» — нет в словаре",
    );
    expect(fact("comment_keywords")).toBe("Не хватает: Адрес");
  });

  it("обязательные поля: какое поле пусто или неверно, а не «1 из 2»", () => {
    const [wrong] = buildDebrief([
      criterion("required_fields", 0, [
        "Номер наряда 1 не совпадает с номером бригады: 201",
        "Не заполнен комментарий",
        "Заполнено 0 из 2 обязательных полей",
      ]),
    ]).improve;
    expect(wrong.fact).toBe(
      "Номер наряда 1 не совпадает с номером бригады: 201; Не заполнен комментарий",
    );
    // Оценки до сверки номера: только счётчик.
    const [old] = buildDebrief([
      criterion("required_fields", 0.5, [
        "Заполнено 1 из 2 обязательных полей",
      ]),
    ]).improve;
    expect(old.fact).toBe("Заполнено 1 из 2 обязательных полей");
    // Полный разбор: основание оценщика — те же проблемы, «Что повлияло» их не повторяет.
    const explanation =
      "Номер наряда 1 не совпадает с номером бригады: 201. Не заполнен комментарий.";
    expect(repeatsExplanation(wrong.fact ?? "", explanation)).toBe(true);
    expect(repeatsExplanation(old.fact ?? "", "Не заполнен комментарий.")).toBe(
      false,
    );
  });

  it("критерий без веса на итог не влияет — в итоги не попадает", () => {
    const result = buildDebrief([criterion("spelling", 0, [], false, 0)]);
    expect(result).toEqual({ good: [], improve: [], data: [] });
  });
});

describe("вердикт, «не требуется» и разбор по четырём вопросам", () => {
  const noCall = {
    ...criterion("call", 1, ["Обязательный звонок не предусмотрен эталоном"]),
    explanation: "Требований к звонку в этом сценарии нет.",
  };

  it("критерий, которого нет в сценарии, не хвалим и помечаем «не требуется»", () => {
    expect(notApplicable(noCall)).toBe(true);
    expect(
      notApplicable(
        criterion("required_fields", 1, [
          "Заполнено 0 из 0 обязательных полей",
        ]),
      ),
    ).toBe(true);
    expect(notApplicable(criterion("call", 1, ["Звонок в 102"]))).toBe(false);
    expect(buildDebrief([noCall, criterion("routing", 1)]).good).toEqual([
      "Маршрутизация по службам",
    ]);
  });

  it("критическая ошибка — «не зачтено» при любой сумме; решение преподавателя главнее", () => {
    const critical = [criterion("call", 0, [], true), criterion("routing", 1)];
    expect(attemptVerdict(0.5, critical)).toEqual({
      passed: false,
      label: "Не зачтено",
      detail: "критическая ошибка: доклад по телефону",
    });
    expect(attemptVerdict(0.95, [criterion("routing", 1)]).detail).toBe(
      "высокое соответствие",
    );
    expect(attemptVerdict(0.75, []).label).toBe("Зачтено");
    expect(attemptVerdict(0.6, []).label).toBe("Не зачтено");
    expect(attemptVerdict(0.5, critical, 0.8)).toEqual({
      passed: true,
      label: "Зачтено",
      detail: "соответствие с замечаниями · решение преподавателя",
    });
  });

  it("что ожидалось и что сделано — из разбора, эталонный текст не нужен", () => {
    const result = afterAction({
      criteria: [
        criterion("status_flow", 0.75, [
          "Эталон: Получена службой → Принята → Работы завершены",
        ]),
        criterion("call", 0, ["Обязательный звонок отсутствует"], true),
        criterion("comment_keywords", 0.5),
        {
          ...criterion("comment_completeness", 0.25),
          explanation: "Нет адреса.",
        },
      ],
      times: [
        {
          label: "Реакция — от направления карточки",
          seconds: 56,
          normative: 30,
        },
        { label: "Ожидание сведений", seconds: 0, normative: null },
      ],
      path: "Принята → Работы завершены",
      comments: [
        { status: "Принята", text: "пострадавших двое" },
        { status: "Работы завершены", text: "уехали" },
      ],
      teacherComment: "",
    });
    expect(result.expected).toEqual([
      "Статусы: Принята → Работы завершены",
      "Реакция — не дольше 00:30",
      "Доклад должностному лицу по телефону по памятке ДДС, с. 32: кто вы, адрес и повод, карточка, что изменилось",
      "Комментарий: где, что случилось, какое решение, есть ли пострадавшие",
    ]);
    expect(result.done).toEqual([
      "Статусы: Принята → Работы завершены",
      "Реакция — 00:56",
      "Доклада по телефону не было",
      "Комментарий при «Принята»: «пострадавших двое»",
      "Комментарий при «Работы завершены»: «уехали»",
    ]);
    expect(result.why).toBe("ИИ о комментарии: Нет адреса.");
  });
});

describe("доклад по памятке ДДС, с. 32, в разборе", () => {
  const parts =
    "Части доклада службе 102 по памятке ДДС, с. 32: кто вы ✓, адрес и повод ✓, карточка ✗, что изменилось ✓";
  const call = criterion("call", 2 / 3, [
    "Звонок отвечен: да",
    "Доклад службе 102: полного доклада нет — без карточки",
    parts,
  ]);

  it("что сделано — какие части прозвучали", () => {
    expect(reportParts(call.evidence)).toBe(
      "Доклад по телефону: кто вы ✓, адрес и повод ✓, карточка ✗, что изменилось ✓",
    );
    const result = afterAction({
      criteria: [call],
      times: [],
      path: "",
      comments: [],
      teacherComment: "",
    });
    expect(result.done).toContain(
      "Доклад по телефону: кто вы ✓, адрес и повод ✓, карточка ✗, что изменилось ✓",
    );
  });

  it("замечание по звонку показывает части, а не «звонок отвечен»", () => {
    const [item] = buildDebrief([call]).improve;
    expect(item?.fact).toContain(parts);
    expect(item?.fact).toContain("полного доклада нет");
    expect(item?.advice).toContain(
      "кто вы, адрес и повод, карточка, что изменилось",
    );
  });

  it("старая оценка без строки частей — как раньше", () => {
    expect(reportParts(["Звонок отвечен: да"])).toBeNull();
    const result = afterAction({
      criteria: [criterion("call", 1, ["Звонок отвечен: да"])],
      times: [],
      path: "",
      comments: [],
      teacherComment: "",
    });
    expect(result.done).toContain("Доклад по телефону был");
  });
});

describe("первый экран разбора", () => {
  it("главное исправление — критическая ошибка раньше большей потери балла", () => {
    const focus = focusFor(
      buildDebrief([
        criterion("status_flow", 0, [], false, 3),
        criterion("address", 0.8, [], true),
      ]),
    );
    expect(focus?.key).toBe("address");
  });

  it("без замечаний главного исправления нет", () => {
    expect(focusFor(buildDebrief([criterion("routing", 1)]))).toBeUndefined();
  });

  it("адрес: факт — что не совпало, без этой строки — пояснение", () => {
    const withMismatch = buildDebrief([
      criterion(
        "address",
        0,
        ["Проверен ручной адрес из полей ручного ввода", "Не совпали: дом"],
        true,
      ),
    ]);
    expect(withMismatch.improve[0].fact).toBe("Не совпали: дом");
    const without = buildDebrief([
      {
        ...criterion(
          "address",
          0,
          ["Проверен ручной адрес из полей ручного ввода"],
          true,
        ),
        explanation: "Не подтверждены компоненты адреса: улица.",
      },
    ]);
    expect(without.improve[0].fact).toBe(
      "Не подтверждены компоненты адреса: улица.",
    );
  });

  it("адрес в комментарии: факт — какую улицу написал обучаемый (DT-14)", () => {
    const [item] = buildDebrief([
      criterion(
        "address",
        2 / 3,
        [
          "Адрес карточки верен: в комментарии его можно не повторять, но не искажать",
          "Найдено 2 из 3 компонентов адреса в комментариях",
          "Не совпали: улица",
          "В комментарии другая улица: «Дубининская»",
        ],
        true,
      ),
    ]).improve;
    expect(item.fact).toBe("В комментарии другая улица: «Дубининская»");
  });

  it("совет по реакции — с нормативом занятия, а не с зашитыми 30 секундами", () => {
    const [item] = buildDebrief([
      criterion("reaction_time", 0.2, ["Реакция 70 с при нормативе 45 с"]),
    ]).improve;
    expect(item.advice).toContain("0:45");
    expect(item.advice).not.toContain("30 секунд");
    expect(item.fact).toBe("Реакция 01:10 при нормативе 00:45");
  });

  it("служебные строки методики времени обучаемому не показываются", () => {
    expect(
      traineeEvidence([
        "Методика I-TIME v3; политика default",
        "Источники времени: server_ts",
        "Реакция 12,5 с",
      ]),
    ).toEqual(["Реакция 00:13"]);
  });

  it("неприменимые критерии — одной строкой", () => {
    expect(notApplicableLabels([])).toBe("");
    expect(
      notApplicableLabels([
        {
          ...criterion("call", 1),
          explanation: "Звонок сценарием не предусмотрен",
        },
        criterion("routing", 1),
      ]),
    ).toBe("доклад по телефону");
  });
});

describe("хронология попытки", () => {
  const event = (
    type: string,
    at: string,
    payload: Record<string, unknown> = {},
  ) =>
    ({
      id: at,
      card_id: "c",
      actor_id: "u",
      client_event_id: at,
      client_ts: at,
      server_ts: at,
      clock_offset_ms: 0,
      type,
      payload,
    }) as never;

  const events = [
    event("status_change", "2026-09-29T10:01:10Z", { state: "completed" }),
    event("call_answer", "2026-09-29T10:00:50Z", { call_id: "k" }),
    event("status_change", "2026-09-29T10:00:40Z", { state: "accepted" }),
    event("open", "2026-09-29T10:00:05Z"),
    event("call_dial", "2026-09-29T10:00:45Z", {
      call_id: "k",
      phone_ext: "03",
    }),
  ];

  it("по времени, от показа карточки; просрочку помечает вердикт оценщика", () => {
    const rows = attemptTimeline(events, "2026-09-29T10:00:00Z", {
      reactionOver: true,
      handlingOver: false,
    });
    expect(rows).toEqual([
      { at: 5, label: "Карточка открыта", over: false },
      { at: 40, label: "Принята", over: true },
      { at: 45, label: "Звонок 03", over: false },
      { at: 50, label: "Звонок 03 — ответили", over: false },
      { at: 70, label: "Работы завершены", over: false },
    ]);
    const handling = attemptTimeline(events, "2026-09-29T10:00:00Z", {
      reactionOver: false,
      handlingOver: true,
    });
    expect(handling.map((row) => row.over)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it("без просрочки у оценщика — без пометок, даже если сырое время больше норматива", () => {
    // Оценщик вычел ожидание на звонке (v3) или не доверяет часам — флаг false/null.
    for (const verdicts of [{ reactionOver: false, handlingOver: false }, null])
      expect(
        attemptTimeline(events, "2026-09-29T10:00:00Z", verdicts).some(
          (row) => row.over,
        ),
      ).toBe(false);
  });

  it("помечается только первый первичный и последний итоговый статус", () => {
    const rows = attemptTimeline(
      [
        event("status_change", "2026-09-29T10:00:10Z", { state: "accepted" }),
        event("status_change", "2026-09-29T10:00:20Z", { state: "rejected" }),
        event("status_change", "2026-09-29T10:00:30Z", { state: "refused" }),
        event("status_change", "2026-09-29T10:00:40Z", { state: "completed" }),
      ],
      "2026-09-29T10:00:00Z",
      { reactionOver: true, handlingOver: true },
    );
    expect(rows.map((row) => row.over)).toEqual([true, false, false, true]);
  });

  it("без событий — пусто", () => {
    expect(attemptTimeline([], "2026-09-29T10:00:00Z", null)).toEqual([]);
  });
});

describe("замечание разбора: цитата, последствие, памятка (TC-10)", () => {
  const remark = (
    text: string,
    kind: "error" | "notice" | "data" = "error",
    quote: string | null = null,
  ) => ({
    text,
    quote,
    consequence: "Служба не оповещена — фактически не выехала.",
    memo_page: 21,
    repeat: "Повторите: поставьте «Принята» в течение 30 секунд.",
    kind,
  });

  it("у ошибки — замечание: «Повторите» вместо общего совета, время — м:сс", () => {
    const late = {
      ...criterion("reaction_time", 0.5),
      remarks: [
        remark("Первичный статус поставлен через 45 с при нормативе 30 с."),
      ],
    };
    const [item] = buildDebrief([late]).improve;
    expect(item.remarks).toHaveLength(1);
    expect(item.remarks[0].text).toBe(
      "Первичный статус поставлен через 00:45 при нормативе 00:30.",
    );
    expect(item.remarks[0].memo_page).toBe(21);
    expect(item.advice).toBe(
      "Повторите: поставьте «Принята» в течение 30 секунд.",
    );
    expect(item.notice).toBe(false);
  });

  it("цитата сказанного или написанного — как есть", () => {
    const routing = {
      ...criterion("routing", 0, [], true),
      remarks: [
        remark("Карточка вашей службы не принята.", "error", "Не наша"),
      ],
    };
    expect(buildDebrief([routing]).improve[0].remarks[0].quote).toBe("Не наша");
  });

  it("замечание без снижения балла — после ошибок, «Получилось» не теряется", () => {
    const flow = {
      ...criterion("status_flow", 1),
      remarks: [remark("Статусы подряд быстрее 3 секунд.", "notice")],
    };
    const result = buildDebrief([flow, criterion("address", 0.5)]);
    expect(result.improve.map((item) => [item.key, item.notice])).toEqual([
      ["address", false],
      ["status_flow", true],
    ]);
    expect(result.good).toEqual(["Последовательность статусов"]);
  });

  it("вопрос к данным — отдельно и не в «что исправить»", () => {
    const flow = {
      ...criterion("status_flow", 1),
      remarks: [remark("Вопрос к данным: нет доклада о прибытии.", "data")],
    };
    const result = buildDebrief([flow]);
    expect(result.improve).toEqual([]);
    expect(result.data.map((item) => item.text)).toEqual([
      "Вопрос к данным: нет доклада о прибытии.",
    ]);
  });

  it("старая оценка без замечаний — совет и факт, как раньше", () => {
    const [item] = buildDebrief([criterion("routing", 0, [], true)]).improve;
    expect(item.remarks).toEqual([]);
    expect(item.advice).toContain("«Не принята» с причиной");
  });

  it("подсказки видны в «Что сделано» и балл не снижают", () => {
    const events = [
      { type: "hint_open", payload: { hint_id: "status" } },
      { type: "open", payload: {} },
      { type: "hint_open", payload: { hint_id: "tutor:accepted" } },
    ] as unknown as Parameters<typeof helpsUsed>[0];
    expect(helpsUsed(events)).toBe(2);
    const result = afterAction({
      criteria: [criterion("routing", 1)],
      times: [],
      path: "",
      comments: [],
      teacherComment: "",
      helps: helpsUsed(events),
    });
    expect(result.done).toContain(
      "Подсказки открыты 2 раза: на оценку помощь не влияет",
    );
    const none = afterAction({
      criteria: [],
      times: [],
      path: "",
      comments: [],
      teacherComment: "",
    });
    expect(none.done.some((line) => line.startsWith("Подсказки"))).toBe(false);
  });
});

describe("лента действий и разбор звонков (TC-11)", () => {
  const event = (
    type: string,
    at: string,
    payload: Record<string, unknown> = {},
  ) =>
    ({
      id: `${type}-${at}`,
      card_id: "c",
      actor_id: "u",
      client_event_id: `${type}-${at}`,
      client_ts: at,
      server_ts: at,
      clock_offset_ms: 0,
      type,
      payload,
    }) as never;

  const events = [
    event("open", "2026-10-16T10:00:04.200Z"),
    event("hint_open", "2026-10-16T10:00:05.000Z", { hint_id: "status" }),
    event("status_change", "2026-10-16T10:00:16.500Z", {
      state: "accepted",
      comment: "Задымление в квартире.",
    }),
    event("call_dial_target", "2026-10-16T10:00:20.000Z", {
      call_id: "b",
      call_target_id: "t",
      brigade_id: "g",
    }),
    event("call_answer", "2026-10-16T10:00:22.000Z", { call_id: "b" }),
    event("brigade_reply", "2026-10-16T10:00:30.000Z", {
      call_id: "b",
      delivery_id: "d",
      option_key: "yes",
      mode: "voice",
      text: "Да, пятый этаж",
    }),
    event("call_hangup", "2026-10-16T10:00:31.000Z", { call_id: "b" }),
    event("message_presented", "2026-10-16T10:00:33.000Z", {
      delivery_id: "d",
      channel: "audio",
    }),
    event("status_change", "2026-10-16T10:01:50.000Z", {
      state: "responding",
      comment: "Задымление в квартире. Бригада выехала, пятый этаж.",
    }),
  ];

  it("у каждого действия — время от показа и «+N с» с прошлого действия", () => {
    const feed = actionFeed(events, "2026-10-16T10:00:00Z", {
      reactionOver: false,
      handlingOver: false,
    });
    expect(feed.map((row) => row.label)).toEqual([
      "Карточка открыта",
      "Подсказка",
      "Принята",
      "Звонок бригаде",
      "Звонок бригаде — ответили",
      "Ответ бригаде: «Да, пятый этаж»",
      "Звонок бригаде — отбой",
      "Доклад бригады прослушан",
      "Начало реагирования",
    ]);
    expect(feed.map((row) => row.since)).toEqual([
      4.2, 0.8, 11.5, 3.5, 2, 8, 1, 2, 77,
    ]);
    expect(feed[2].at).toBe(17);
    expect(sinceText(feed[2].since)).toBe("+11,5 с");
    expect(sinceText(feed[4].since)).toBe("+2,0 с");
    expect(sinceText(feed[8].since)).toBe("+1 мин 17 с");
  });

  it("лента не меняет прежнюю хронологию: в ней только статусы и звонки", () => {
    expect(
      attemptTimeline(events, "2026-10-16T10:00:00Z", null).map(
        (row) => row.label,
      ),
    ).toEqual([
      "Карточка открыта",
      "Принята",
      "Звонок бригаде",
      "Звонок бригаде — ответили",
      "Начало реагирования",
    ]);
  });

  it("просрочка реакции помечена и в ленте", () => {
    const feed = actionFeed(events, "2026-10-16T10:00:00Z", {
      reactionOver: true,
      handlingOver: false,
    });
    expect(feed.filter((row) => row.over).map((row) => row.label)).toEqual([
      "Принята",
    ]);
    expect(actionFeed([], null, null)).toEqual([]);
  });

  const call = (
    id: string,
    audio: string | null,
    transcript: string | null = null,
  ) => ({
    id,
    card_id: "c",
    phone_ext: "101",
    service_id: "101",
    state: "ended" as const,
    audio_url: audio,
    transcript,
  });

  it("звонок с записью: сказанное, распознанное и записанное после него", () => {
    const [review] = callReviews(
      [call("b", "/api/calls/b/audio"), call("x", null)],
      events,
      "2026-10-16T10:00:00Z",
    );
    expect(review).toEqual({
      id: "b",
      label: "Звонок бригаде",
      at: 20,
      audioUrl: "/api/calls/b/audio",
      recognized: ["Да, пятый этаж"],
      written: "Задымление в квартире. Бригада выехала, пятый этаж.",
    });
  });

  it("звонок без записи и без распознанного текста не показывается", () => {
    expect(callReviews([call("x", null)], events, null)).toEqual([]);
    const [only] = callReviews(
      [call("x", null, "  Служба 101, задымление  ")],
      [],
      null,
    );
    expect(only.recognized).toEqual(["Служба 101, задымление"]);
    expect(only.label).toBe("Звонок 101");
    expect(only.written).toBeNull();
  });

  it("сводка критериев: совпало и расхождения, «не требуется» не считается", () => {
    const criteria = [
      criterion("routing", 1),
      criterion("address", 0.5),
      criterion("status_flow", 0),
      criterion("call", 1, ["Обязательный звонок не предусмотрен эталоном"]),
    ];
    expect(criteriaSummary(criteria)).toEqual({ matched: 1, differ: 2 });
    expect(differences(criteria).map((item) => item.key)).toEqual([
      "address",
      "status_flow",
    ]);
  });
});
