import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api";
import { useSession } from "../../shared/session";
import { guideSession, screenHelpEnabled } from "./sessionGuide";

/** В карточке действует её снимок; вне карточки — текущее занятие обучаемого. */
export function useHelpEnabled(sessionId?: string) {
  const { user } = useSession();
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const { data, error } = await api.GET("/sessions");
      if (!data) throw new Error(error?.message ?? "Занятия недоступны.");
      return data;
    },
  });
  const cards = useQuery({
    queryKey: ["cards"],
    enabled: !sessionId,
    queryFn: async () => {
      const { data, error } = await api.GET("/cards");
      if (!data) throw new Error(error?.message ?? "Карточки недоступны.");
      return data;
    },
  });
  const session = guideSession(
    sessions.data ?? [],
    cards.data ?? [],
    user.id,
    sessionId,
  );
  return screenHelpEnabled(session);
}
