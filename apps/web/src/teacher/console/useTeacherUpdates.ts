// WS сообщает об изменениях; HTTP остаётся источником эффективных оценок и отчёта.
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "../../shared/session";

export function teacherQueryKeys(type: string): string[] {
  switch (type) {
    case "snapshot":
      return [
        "sessions",
        "session",
        "assignments",
        "cards",
        "evaluations",
        "report",
        "analytics",
        "replay",
      ];
    case "session.started":
    case "session.finished":
      return ["sessions", "session", "assignments", "report", "analytics"];
    case "card.appeared":
    case "card.updated":
      return ["cards", "assignments", "report", "analytics", "replay"];
    case "evaluation.partial":
    case "evaluation.complete":
      return ["evaluations", "report", "analytics", "replay"];
    default:
      return [];
  }
}

export function useTeacherUpdates() {
  const { realtime } = useSession();
  const queries = useQueryClient();
  useEffect(
    () =>
      realtime.subscribe((event) => {
        for (const key of teacherQueryKeys(event.type)) {
          void queries.invalidateQueries({ queryKey: [key] });
        }
      }),
    [realtime, queries],
  );
}
