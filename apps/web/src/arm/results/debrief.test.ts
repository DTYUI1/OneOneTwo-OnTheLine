import { describe, expect, it } from "vitest";
import {
  afterAction,
  attemptTimeline,
  attemptVerdict,
  buildDebrief,
  criterionLevel,
  focusFor,
  LEVEL_LABELS,
  notApplicable,
  notApplicableLabels,
  traineeEvidence,
} from "./debrief";

const criterion = (
  key: string,
  score: number,
  evidence: string[] = [],
  critical = false,
  weight = 1,
) => ({ key, score, weight, critical, evidence, explanation: "пояснение" });

describe("итоги попытки", () => {
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
    expect(result.improve[0].advice).toMatch(/Адрес — ввод диспетчера/);
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

  it("критерий без веса на итог не влияет — в итоги не попадает", () => {
    const result = buildDebrief([criterion("spelling", 0, [], false, 0)]);
    expect(result).toEqual({ good: [], improve: [] });
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
      comment: "пострадавших двое",
      teacherComment: "",
    });
    expect(result.expected).toEqual([
      "Статусы: Получена службой → Принята → Работы завершены",
      "Реакция — не дольше 00:30",
      "Доклад должностному лицу по телефону",
      "Комментарий: где, что случилось, какое решение, есть ли пострадавшие",
    ]);
    expect(result.done).toEqual([
      "Статусы: Принята → Работы завершены",
      "Реакция — 00:56",
      "Доклада по телефону не было",
      "Комментарий: «пострадавших двое»",
    ]);
    expect(result.why).toBe("ИИ о комментарии: Нет адреса.");
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
