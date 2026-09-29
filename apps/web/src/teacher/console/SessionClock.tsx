// Сколько длится занятие — видно только преподавателю (обучаемому свои таймеры карточек).
import type { components } from "../../api-client/schema";
import { useNow } from "../../arm/useNow";
import { formatLessonDuration, lessonDurationS } from "./lessonClock";

type Session = components["schemas"]["Session"];

export function SessionClock({
  session,
  className,
}: {
  session: Pick<Session, "status" | "started_at" | "finished_at">;
  className?: string;
}) {
  const now = useNow();
  const seconds = lessonDurationS(session, now);
  if (seconds === null) return null;
  const label = session.status === "running" ? "Идёт" : "Длилось";
  return (
    <span className={className}>
      {label} {formatLessonDuration(seconds)}
    </span>
  );
}
