// Подсказки орфографии под комментарием (28.09). Работают, только если преподаватель
// включил их в занятии этой карточки (settings_snapshot.spelling_hints): в контрольном
// занятии грамотность входит в оценку. Проверка — на сервере, по тому же словарю, что
// критерий грамотности; текст уходит через паузу в наборе.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, csrfToken } from "../shared/api";
import { currentIssues, type SpellingIssue } from "./spellingModel";

const PAUSE_MS = 600;

export function useSpellingHints(
  sessionId: string,
  cardId: string,
  text: string,
  active: boolean,
): SpellingIssue[] {
  const session = useQuery({
    queryKey: ["session", sessionId],
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/sessions/{id}", {
        params: { path: { id: sessionId } },
        signal,
      });
      if (!data) throw new Error(error?.message ?? "Занятие недоступно.");
      return data;
    },
  });
  const enabled =
    active && session.data?.settings_snapshot.spelling_hints === true;
  const [paused, setPaused] = useState(text);
  useEffect(() => {
    const timer = window.setTimeout(() => setPaused(text), PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [text]);
  const check = useQuery({
    queryKey: ["spelling", cardId, paused],
    enabled: enabled && paused.trim().length > 0,
    staleTime: Infinity,
    retry: false,
    queryFn: async ({ signal }) => {
      const { data } = await api.POST("/spelling/check", {
        params: { header: { "X-CSRF-Token": csrfToken() } },
        body: { text: paused, card_id: cardId },
        signal,
      });
      // Подсказки — помощь, а не часть работы: без ответа просто не показываем их.
      return data?.issues ?? [];
    },
  });
  return enabled ? currentIssues(text, check.data ?? []) : [];
}
