// Время занятия целиком — для преподавателя, и момент, когда его пора завершать.
// Обучаемому этот счёт не показывается: у него таймеры своих карточек (I-TIME).
// Чистые функции без React и сети — проверяются тестами.
import type { components } from "../../api-client/schema";

type Session = components["schemas"]["Session"];
type SessionLifecycle = components["schemas"]["SessionLifecycle"];

/**
 * Сколько ждать ответа преподавателя, прежде чем завершить занятие самим. 15 с было
 * мало: преподаватель в это время смотрит окно обучаемого или разбор и окно не видит.
 */
export const FINISH_PROMPT_S = 120;

/** Длительность занятия в секундах: от старта до завершения или «сейчас»; null — не начато. */
export function lessonDurationS(
  session: Pick<Session, "started_at" | "finished_at">,
  now: number,
): number | null {
  if (!session.started_at) return null;
  const end = session.finished_at ? Date.parse(session.finished_at) : now;
  return Math.max(0, Math.floor((end - Date.parse(session.started_at)) / 1000));
}

/** «0:07:05», «1:12:40»: занятие длится десятки минут, поэтому часы видны всегда. */
export function formatLessonDuration(totalS: number): string {
  const hours = Math.floor(totalS / 3600);
  const minutes = Math.floor((totalS % 3600) / 60);
  const seconds = totalS % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${hours}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Идущее занятие, за которым следить: самое позднее по старту. Сервер отдаёт
 * список в порядке id (случайный UUID), и при забытом старом занятии «первое
 * идущее» оказывалось вчерашним — со вчерашними таймерами на доске.
 */
export function latestRunning<T extends Pick<Session, "status" | "started_at">>(
  sessions: readonly T[],
): T | undefined {
  const startedMs = (session: T) => Date.parse(session.started_at ?? "") || 0;
  let latest: T | undefined;
  for (const session of sessions) {
    if (session.status !== "running") continue;
    if (latest === undefined || startedMs(session) > startedMs(latest))
      latest = session;
  }
  return latest;
}

/**
 * Все обучаемые закончили: занятие идёт, а незавершённых назначений не осталось.
 * Добавить задания после старта нельзя (раздача — только в черновике), поэтому
 * дальше в занятии ничего произойти не может — его предлагается завершить.
 * «Не принята» без перенаправления завершением не считается: обучаемый как раз
 * может перенаправлять карточку, и автозавершение прервало бы его на полуслове.
 */
export function everyoneDone(
  lifecycle: Pick<
    SessionLifecycle,
    "status" | "remaining_assignments" | "attempts"
  >,
): boolean {
  return (
    lifecycle.status === "running" &&
    lifecycle.remaining_assignments === 0 &&
    lifecycle.attempts.length > 0
  );
}
