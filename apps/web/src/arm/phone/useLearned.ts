import { useCallback, useSyncExternalStore } from "react";
import { useSession } from "../../shared/session";
import {
  isLearned,
  learn,
  learnedCounts,
  subscribeLearned,
  type LearnedHint,
} from "./learned";

/**
 * Пояснения окна телефона для вошедшего пользователя (GP-24): `shown` — показывать ли
 * пояснение, `done` — действие сделано верно ещё раз.
 */
export function useLearned() {
  const { user } = useSession();
  const counts = useSyncExternalStore(subscribeLearned, () =>
    learnedCounts(user.id),
  );
  const shown = useCallback(
    (hint: LearnedHint) => !isLearned(counts, hint),
    [counts],
  );
  const done = useCallback(
    (hint: LearnedHint) => learn(user.id, hint),
    [user.id],
  );
  return { shown, done };
}
