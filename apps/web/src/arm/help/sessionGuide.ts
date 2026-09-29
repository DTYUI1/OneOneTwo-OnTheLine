import type { components } from "../../api-client/schema";
type Session = components["schemas"]["Session"];
type Card = components["schemas"]["Card"];

/** UUID в ответе API не задаёт хронологию: вне карточки ориентируемся на выдачу. */
export function guideSession(
  sessions: Session[],
  cards: Pick<Card, "session_id" | "appeared_at">[],
  userId: string,
  sessionId?: string,
) {
  const mine = sessions.filter((session) =>
    session.participants.some((participant) => participant.user_id === userId),
  );
  if (sessionId) return mine.find((session) => session.id === sessionId);
  const newest = new Map<string, number>();
  for (const card of cards)
    newest.set(
      card.session_id,
      Math.max(newest.get(card.session_id) ?? 0, Date.parse(card.appeared_at)),
    );
  return [...mine].sort(
    (a, b) =>
      Number(b.status === "running") - Number(a.status === "running") ||
      (newest.get(b.id) ?? 0) - (newest.get(a.id) ?? 0),
  )[0];
}

/**
 * Объяснение экрана («?») выключает только преподаватель: в занятии с подсказками 0.
 * Самостоятельная тренировка — на любой ступени, и без занятия справка доступна:
 * она поясняет экран, а не подсказывает решение.
 */
export function screenHelpEnabled(
  session: Pick<Session, "kind" | "settings_snapshot"> | undefined,
): boolean {
  if (!session || session.kind === "practice") return true;
  return (session.settings_snapshot.hints_level ?? 0) >= 1;
}
