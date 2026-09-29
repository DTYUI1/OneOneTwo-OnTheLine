import { describe, expect, it } from "vitest";
import {
  percentToTotal,
  assignableScenarios,
  defaultTab,
  distribute,
  evaluationNote,
  formatScore,
  hasScore,
  ordersByParticipant,
  planAssignments,
  scenarioServiceIds,
  sortSessions,
  startBlockers,
  validateParticipants,
  verdictsForSession,
  weakestFirst,
  readable,
  criterionLabel,
  type Evaluation,
  type Scenario,
} from "./model";

function scenarioFor(id: string, serviceId: string): Scenario {
  return {
    id,
    status: "approved",
    level: 1,
    weight: 1,
    card: { service_ids: [serviceId] },
  } as unknown as Scenario;
}

const participant = {
  user_id: "u1",
  workstation_number: 1,
  dds_service_id: "102",
  level: 1,
};

describe("состав занятия", () => {
  it("принимает корректный состав", () => {
    expect(validateParticipants([participant])).toEqual([]);
  });

  it("не пускает пустой состав", () => {
    expect(validateParticipants([])).toContain(
      "Добавьте хотя бы одного обучаемого.",
    );
  });

  it("ловит двух участников на одном рабочем месте", () => {
    const problems = validateParticipants([
      participant,
      { ...participant, user_id: "u2" },
    ]);
    expect(problems).toContain("АРМ 1 занят несколькими участниками.");
  });

  it("ловит повтор обучаемого", () => {
    const problems = validateParticipants([
      participant,
      { ...participant, workstation_number: 2 },
    ]);
    expect(problems).toContain("Один обучаемый добавлен дважды.");
  });

  it("держит границы АРМ и уровня", () => {
    expect(
      validateParticipants([{ ...participant, workstation_number: 24 }]),
    ).toContain("Номер АРМ должен быть от 1 до 23.");
    expect(validateParticipants([{ ...participant, level: 5 }])).toContain(
      "Уровень должен быть от 1 до 4.",
    );
  });
});

describe("раздача заданий", () => {
  const draft = { id: "s1", status: "draft" } as unknown as Scenario;
  const approved = { id: "s2", status: "approved" } as unknown as Scenario;
  const retired = { id: "s3", status: "retired" } as unknown as Scenario;

  it("назначать можно только утверждённые сценарии", () => {
    expect(assignableScenarios([draft, approved, retired])).toEqual([approved]);
  });

  it("каждому участнику — своя очередь заданий по порядку", () => {
    const from = Date.parse("2026-09-22T10:00:00Z");
    const plans = planAssignments(
      [
        { participantId: "u1", scenarioIds: ["s1", "s2"] },
        { participantId: "u2", scenarioIds: ["s1", "s2"] },
      ],
      { from, firstDelayS: 10, intervalS: 60 },
    );
    expect(plans).toHaveLength(4);
    expect(plans[0]).toEqual({
      participant_id: "u1",
      scenario_id: "s1",
      order: 1,
      planned_at: "2026-09-22T10:00:10.000Z",
    });
    expect(plans[1].planned_at).toBe("2026-09-22T10:01:10.000Z");
    expect(plans[3].participant_id).toBe("u2");
  });

  it("выдаёт сценарий только своей службе", () => {
    const scenarios = [scenarioFor("s101", "101"), scenarioFor("s102", "102")];
    const { queues, unmatched } = distribute(
      [
        { user_id: "u1", dds_service_id: "102" },
        { user_id: "u2", dds_service_id: "101" },
      ],
      scenarios,
      ["s101", "s102"],
    );
    expect(queues).toEqual([
      { participantId: "u1", scenarioIds: ["s102"] },
      { participantId: "u2", scenarioIds: ["s101"] },
    ]);
    expect(unmatched).toEqual([]);
  });

  it("называет сценарий, которому в составе нет службы", () => {
    const scenarios = [scenarioFor("s104", "104")];
    const { queues, unmatched } = distribute(
      [{ user_id: "u1", dds_service_id: "102" }],
      scenarios,
      ["s104"],
    );
    expect(queues).toEqual([]);
    expect(unmatched.map((item) => item.id)).toEqual(["s104"]);
  });

  it("читает службы происшествия из карточки сценария", () => {
    expect(scenarioServiceIds(scenarioFor("s1", "103"))).toEqual(["103"]);
    expect(
      scenarioServiceIds({ id: "s2", card: {} } as unknown as Scenario),
    ).toEqual([]);
  });

  it("продолжает нумерацию отдельно по каждому участнику", () => {
    // Общий счётчик по занятию давал бы второму кругу order 3 вместо 2.
    const counts = ordersByParticipant([
      { participant_id: "u1" },
      { participant_id: "u2" },
    ]);
    expect(counts.get("u1")).toBe(1);
    expect(counts.get("u2")).toBe(1);
  });

  it("не считает задания без участника", () => {
    const counts = ordersByParticipant([
      { participant_id: "u1" },
      { participant_id: "" },
      { participant_id: "u1" },
    ]);
    expect(counts.get("u1")).toBe(2);
    expect(counts.size).toBe(1);
  });
});

describe("готовность к старту", () => {
  const session = {
    status: "draft" as const,
    participants: [
      participant,
      { ...participant, user_id: "u2", workstation_number: 4 },
    ],
  };

  it("называет места, которым не раздали задания", () => {
    expect(startBlockers(session, [{ participant_id: "u1" }])).toEqual([
      "АРМ 4: нет заданий.",
    ]);
  });

  it("разрешает старт, когда задания есть у всех", () => {
    expect(
      startBlockers(session, [
        { participant_id: "u1" },
        { participant_id: "u2" },
      ]),
    ).toEqual([]);
  });

  it("не даёт запустить идущее или завершённое занятие", () => {
    expect(startBlockers({ ...session, status: "running" }, [])).toContain(
      "Занятие уже идёт.",
    );
    expect(startBlockers({ ...session, status: "finished" }, [])).toContain(
      "Занятие завершено: запустить его заново нельзя.",
    );
  });
});

describe("вердикты", () => {
  const evaluation = {
    id: "e1",
    card_id: "c1",
    trainee_id: "u1",
    version: 1,
    status: "complete",
    total: 0.75,
    criteria: [
      {
        key: "routing",
        score: 0.2,
        weight: 1,
        critical: true,
        evidence: [],
        explanation: "",
      },
      {
        key: "reaction_time",
        score: 1,
        weight: 1,
        critical: false,
        evidence: [],
        explanation: "",
      },
    ],
    model_info: {},
    teacher_comment: "",
  } as Evaluation;

  it("балл показывается процентами", () => {
    expect(formatScore(0.75)).toBe("75 %");
    expect(formatScore(0)).toBe("0 %");
  });

  it("неполную оценку и недоступный оценщик не выдаём за готовый результат", () => {
    expect(evaluationNote(evaluation)).toBeNull();
    expect(evaluationNote({ ...evaluation, status: "partial" })).toMatch(
      /Предварительная оценка/,
    );
    expect(
      evaluationNote({
        ...evaluation,
        model_info: { rules: "unavailable:T-006" },
      }),
    ).toMatch(/Оценщик недоступен/);
  });

  it("недоступный оценщик не даёт показывать ноль как балл", () => {
    expect(hasScore(evaluation)).toBe(true);
    expect(
      hasScore({ ...evaluation, model_info: { rules: "unavailable:T-006" } }),
    ).toBe(false);
  });

  it("слабые критерии идут первыми — это ответ на «почему отстающий»", () => {
    expect(weakestFirst(evaluation)[0].key).toBe("routing");
  });
});

describe("раскладка пульта", () => {
  it("ставит идущие занятия первыми, завершённые — в конец", () => {
    const sorted = sortSessions([
      { id: "a", status: "finished" as const },
      { id: "b", status: "draft" as const },
      { id: "c", status: "running" as const },
      { id: "d", status: "draft" as const },
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["c", "b", "d", "a"]);
  });

  it("показывает завершённые от недавних к старым", () => {
    const finished = (id: string, finished_at: string | null) => ({
      id,
      status: "finished" as const,
      finished_at,
      started_at: "2026-09-20T09:00:00Z",
    });
    const sorted = sortSessions([
      finished("old", "2026-09-21T10:00:00Z"),
      finished("unknown", null),
      finished("new", "2026-09-27T18:00:00Z"),
      finished("mid", "2026-09-25T12:00:00Z"),
    ]);
    expect(sorted.map((item) => item.id)).toEqual([
      "new",
      "mid",
      "old",
      "unknown",
    ]);
  });

  it("открывает занятие на вкладке по его статусу", () => {
    expect(defaultTab("draft")).toBe("handout");
    expect(defaultTab("running")).toBe("live");
    expect(defaultTab("finished")).toBe("report");
  });

  it("берёт в занятие только вердикты его карточек", () => {
    const evaluation = (id: string, cardId: string) =>
      ({ id, card_id: cardId }) as unknown as Evaluation;
    const rows = verdictsForSession(
      [evaluation("e1", "c1"), evaluation("e2", "c2"), evaluation("e3", "c9")],
      [
        { id: "c1", session_id: "s1" },
        { id: "c2", session_id: "s2" },
      ],
      "s1",
    );
    expect(rows.map((row) => row.evaluation.id)).toEqual(["e1"]);
    expect(rows[0].card?.id).toBe("c1");
  });
});

describe("readable — пояснения оценщика без английских ключей", () => {
  it("части адреса и обязательные поля — по-русски", () => {
    expect(
      readable("Не подтверждены компоненты адреса: city, street, house."),
    ).toBe("Не подтверждены компоненты адреса: город, улица, дом.");
    expect(readable("Не заполнены поля: service_number, comment.")).toBe(
      "Не заполнены поля: номер наряда, комментарий.",
    );
  });

  it("статусы в эталоне и факте — подписями АРМ", () => {
    expect(
      readable("Эталон: received → accepted → responding → completed"),
    ).toBe(
      "Эталон: Получена службой → Принята → Начало реагирования → Работы завершены",
    );
  });

  it("списки Python и None — обычным перечислением", () => {
    expect(
      readable(
        "Ожидались решения ['accepted']; получены ['rejected', 'accepted']",
      ),
    ).toBe("Ожидались решения Принята; получены Не принята, Принята");
    expect(readable("получены []; адресат перенаправления: None")).toBe(
      "получены нет; адресат перенаправления: нет",
    );
  });

  it("секунды округляются, дробная часть — через запятую", () => {
    expect(readable("Реакция 57.0845 с при нормативе 30 с")).toBe(
      "Реакция 57,1 с при нормативе 30 с",
    );
    expect(readable("Понятность следующему звену: 0.70.")).toBe(
      "Понятность следующему звену: 0,70.",
    );
  });

  it("ключи критериев и путь поля не остаются в тексте", () => {
    expect(readable("reaction_time: 0.10")).toBe("время реакции: 0,10");
    expect(readable("Проверен ручной адрес из current.address")).toBe(
      "Проверен ручной адрес из поля ручного ввода",
    );
    expect(readable("Детерминированные критерии evalcore")).toBe(
      "Детерминированные критерии оценщика",
    );
  });

  it("русский текст и составные ключи не трогает", () => {
    const text = "Комментарий слишком краток: нет адреса и сведений.";
    expect(readable(text)).toBe(text);
    expect(criterionLabel("comment_completeness")).toBe("Полнота комментария");
    expect(criterionLabel("unknown_key")).toBe("unknown_key");
  });
});

describe("новый балл преподавателя", () => {
  it("вводится в процентах, как на экране", () => {
    expect(percentToTotal("67")).toBe(0.67);
    expect(percentToTotal("67,5")).toBe(0.675);
    expect(percentToTotal("0")).toBe(0);
    expect(percentToTotal("100")).toBe(1);
  });

  it("вне 0…100 и пустое — не балл", () => {
    expect(percentToTotal("")).toBeNull();
    expect(percentToTotal("101")).toBeNull();
    expect(percentToTotal("-1")).toBeNull();
    expect(percentToTotal("абв")).toBeNull();
  });
});
