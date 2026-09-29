import { describe, expect, it } from "vitest";
import type { components } from "../../api-client/schema";
import type { Evaluation } from "../../teacher/console/model";
import type { AttemptAnalysis } from "../useAnalysis";
import {
  formatPath,
  fullCycle,
  groupResults,
  isEmptyState,
  practiceStepOf,
  rowScore,
  rowVerdict,
  statusPath,
  summarize,
} from "./resultsModel";

type Card = components["schemas"]["Card"];
type StoredEvent = components["schemas"]["StoredEvent"];

function card(
  id: string,
  patch: Partial<Card> & { session_id?: string } = {},
): Card {
  return {
    id,
    session_id: "s1",
    trainee_id: "u1",
    state: "completed",
    appeared_at: "2026-09-23T10:00:00Z",
    delivered_at: "2026-09-23T10:00:01Z",
    opened_at: "2026-09-23T10:00:12Z",
    closed_at: "2026-09-23T10:02:12Z",
    source: { number: "10000001", incident_class: "ДТП" },
    ...patch,
  } as unknown as Card;
}

function evaluation(cardId: string, patch: Partial<Evaluation> = {}) {
  return {
    id: "e-" + cardId,
    card_id: cardId,
    trainee_id: "u1",
    total: 0.8,
    criteria: [],
    model_info: { rules: "v1" },
    status: "complete",
    teacher_comment: "",
    version: 1,
    ...patch,
  } as unknown as Evaluation;
}

function statusEvent(state: string): StoredEvent {
  return {
    type: "status_change",
    payload: { state, comment: "" },
  } as unknown as StoredEvent;
}

describe("результаты обучаемого", () => {
  it("берёт только закрытые карточки и цепляет к ним вердикт", () => {
    const groups = groupResults(
      [card("c1"), card("c2", { state: "accepted", closed_at: null })],
      [evaluation("c1")],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].rows.map((row) => row.card.id)).toEqual(["c1"]);
    expect(groups[0].rows[0].evaluation?.id).toBe("e-c1");
  });

  it("незакрытая карточка завершённого занятия — прерванная попытка", () => {
    const groups = groupResults(
      [card("c1"), card("c2", { state: "accepted", closed_at: null })],
      [evaluation("c1")],
      new Set(["s1"]),
    );
    expect(groups[0].rows.map((row) => [row.card.id, row.interrupted])).toEqual(
      expect.arrayContaining([
        ["c1", false],
        ["c2", true],
      ]),
    );
    const summary = summarize(groups, new Map());
    expect(summary.closed).toBe(1);
    expect(summary.interrupted).toBe(1);
  });

  it("группирует по занятиям, свежие карточки выше", () => {
    const groups = groupResults(
      [
        card("old", { closed_at: "2026-09-22T09:00:00Z", session_id: "s0" }),
        card("a", { closed_at: "2026-09-23T10:05:00Z" }),
        card("b", { closed_at: "2026-09-23T10:09:00Z" }),
      ],
      [],
    );
    expect(groups.map((group) => group.sessionId)).toEqual(["s1", "s0"]);
    expect(groups[0].rows.map((row) => row.card.id)).toEqual(["b", "a"]);
    expect(groups[0].rows[0].evaluation).toBeNull();
  });

  it("собирает путь статусов и узнаёт полный цикл", () => {
    const full = statusPath([
      { type: "open", payload: {} } as unknown as StoredEvent,
      statusEvent("accepted"),
      statusEvent("responding"),
      statusEvent("completed"),
    ]);
    expect(full).toEqual(["accepted", "responding", "completed"]);
    expect(fullCycle(full)).toBe(true);
    expect(formatPath(full)).toBe(
      "Принята → Начало реагирования → Работы завершены",
    );
    const refused = statusPath([
      statusEvent("accepted"),
      statusEvent("refused"),
    ]);
    expect(fullCycle(refused)).toBe(false);
    expect(formatPath([])).toBe("статусов не ставили");
  });

  it("цикл v3: этапы можно пропускать, возврат после «Не принята» — законный", () => {
    expect(
      fullCycle(["accepted", "arrived", "completed"] as const as never),
    ).toBe(true);
    expect(
      fullCycle(["rejected", "accepted", "working", "completed"] as never),
    ).toBe(true);
    expect(fullCycle(["rejected"] as never)).toBe(false);
  });

  it("считает счётчики шапки, не усредняя баллы", () => {
    const groups = groupResults(
      [
        card("fast"),
        card("slow", { opened_at: "2026-09-23T10:00:45Z" }),
        card("stub"),
      ],
      [
        evaluation("fast", { teacher_comment: "Хорошо." }),
        evaluation("stub", { model_info: { rules: "unavailable:T-006" } }),
      ],
    );
    // Время — из разбора сервера: норматив берётся из того же результата.
    const analysis = (reaction: number | null) =>
      ({
        timing: { reaction_s: reaction, reaction_normative_s: 30 },
      }) as unknown as AttemptAnalysis;
    const analyses = new Map([
      ["fast", analysis(12)],
      ["slow", analysis(45)],
      ["stub", analysis(null)],
    ]);
    expect(summarize(groups, analyses)).toEqual({
      closed: 3,
      interrupted: 0,
      scored: 1,
      passed: 1,
      reactionInNorm: 1,
      withComment: 1,
    });
    expect(summarize(groups, new Map()).reactionInNorm).toBe(0);
  });

  it("балл в списке — с учётом решения преподавателя, как в разборе", () => {
    const [group] = groupResults([card("c1")], [evaluation("c1")]);
    const row = group.rows[0];
    const agreed = {
      evaluation: { effective_total: 0.5, effective_override: null },
    } as unknown as AttemptAnalysis;
    expect(rowScore(row, agreed)).toBe(0.5);
    expect(rowScore(row, undefined)).toBe(0.8);
    const changed = {
      evaluation: {
        effective_total: 0.4,
        effective_override: { decision: "disagree", new_total: 0.4 },
      },
    } as unknown as AttemptAnalysis;
    expect(rowVerdict(row, changed)?.label).toBe("Не зачтено");
    expect(rowVerdict(row, undefined)?.label).toBe("Зачтено");
  });

  it("пустое состояние — только когда обе загрузки удались", () => {
    expect(isEmptyState(false, true, 0)).toBe(false);
    expect(isEmptyState(true, false, 0)).toBe(false);
    expect(isEmptyState(true, true, 1)).toBe(false);
    expect(isEmptyState(true, true, 0)).toBe(true);
  });

  it("ступень тренировки — из заголовка тренировки", () => {
    expect(
      practiceStepOf({
        title: "Тренировка: ступень 2 — самостоятельная работа",
      }),
    ).toBe(2);
    expect(practiceStepOf({ title: "Тренировка: полный цикл карточки" })).toBe(
      undefined,
    );
    expect(practiceStepOf({})).toBeUndefined();
  });
});
