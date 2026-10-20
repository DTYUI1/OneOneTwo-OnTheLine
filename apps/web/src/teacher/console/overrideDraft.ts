import type { AttemptAnalysis } from "../../arm/useAnalysis";

export const AGREE_REASON = "Согласен с оценкой системы";
export const REASONS = {
  disagree: "Не согласен с системой",
  miscalculated: "Система неверно рассчитала",
  other: "Другое",
} as const;
export type ReasonChoice = keyof typeof REASONS;
export type Decision = "agree" | "disagree";

type StoredOverride = NonNullable<
  NonNullable<AttemptAnalysis["evaluation"]>["effective_override"]
>;

/** Последнее решение — исходные значения формы, чтобы его не отменить случайно. */
export function overrideDraft(override: StoredOverride) {
  const choice =
    override.decision === "agree"
      ? "disagree"
      : override.reason === REASONS.miscalculated
        ? "miscalculated"
        : override.reason === REASONS.disagree
          ? "disagree"
          : "other";
  return {
    decision: override.decision,
    choice: choice as ReasonChoice,
    otherReason: choice === "other" ? override.reason : "",
    comment: override.teacher_comment,
    newTotal:
      override.new_total === null
        ? ""
        : String(Math.round(override.new_total * 100)),
  };
}
