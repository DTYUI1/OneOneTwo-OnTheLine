// Контекст обучаемого в занятии: служба и рабочее место берутся из участия
// (`Session.participants[]`), а не из профиля — преподаватель может посадить
// человека за другую ДДС (ответ капитана 22.09, docs/DWOTS_REPLY_2026-09-22.md).
import { useQuery } from "@tanstack/react-query";
import { api } from "../shared/api";
import type { components } from "../api-client/schema";

export type Participant = components["schemas"]["Participant"];
type Session = components["schemas"]["Session"];

/** Участие обучаемого в занятии; null, если его в составе нет. */
export function findParticipant(
  session: Pick<Session, "participants"> | undefined,
  traineeId: string,
): Participant | null {
  return (
    session?.participants.find((item) => item.user_id === traineeId) ?? null
  );
}

export interface ParticipantContext {
  participant: Participant | null;
  sessionStatus: Session["status"] | null;
  canAct: boolean;
  isPending: boolean;
  /** Занятие не отдалось или обучаемого нет в составе — данные показывать нельзя. */
  isUnavailable: boolean;
  /** Личная тренировка обучаемого (startPractice): в карточке работает проводник. */
  practice: boolean;
}

export function useParticipant(
  sessionId: string | null,
  traineeId: string | null,
): ParticipantContext {
  const session = useQuery({
    queryKey: ["session", sessionId],
    enabled: Boolean(sessionId),
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/sessions/{id}", {
        params: { path: { id: sessionId! } },
        signal,
      });
      if (!data) throw new Error(error?.message ?? "Занятие недоступно.");
      return data;
    },
  });
  const participant = traineeId
    ? findParticipant(session.data, traineeId)
    : null;
  return {
    participant,
    sessionStatus: session.data?.status ?? null,
    canAct:
      !session.isError &&
      Boolean(participant) &&
      session.data?.status === "running",
    isPending: Boolean(sessionId) && session.isPending,
    isUnavailable:
      !sessionId || session.isError || (!session.isPending && !participant),
    practice: session.data?.kind === "practice",
  };
}
