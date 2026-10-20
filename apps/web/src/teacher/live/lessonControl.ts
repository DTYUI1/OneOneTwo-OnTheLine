// Ход занятия (TC-12, contracts/live-lesson.md): пауза занятия и ученика, сообщения ученику.
// Операции вне openapi.json, как выключатель модуля 112, — поэтому fetch, а не api-client.
// Состояние опрашивается раз в 5 с: «прочитано» у ученика видно без новых типов WS.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { csrfToken } from "../../shared/api";
import type { TeacherMessage } from "../../arm/trainer/TeacherMessages";

export interface LessonLive {
  readonly paused_at: string | null;
  /** user_id ученика → начало его паузы. */
  readonly participants: Readonly<Record<string, string>>;
  readonly messages: readonly TeacherMessage[];
}

export interface LessonControl {
  readonly live: LessonLive | null;
  readonly error: string | null;
  readonly busy: boolean;
  pause(userId: string | null): void;
  resume(userId: string | null): void;
  send(userId: string, text: string): Promise<boolean>;
}

const key = (sessionId: string) => ["lesson-live", sessionId];

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken(),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(error?.message ?? "Нет связи с сервером.");
  }
}

export function useLessonControl(
  sessionId: string,
  running: boolean,
): LessonControl {
  const client = useQueryClient();
  const live = useQuery({
    queryKey: key(sessionId),
    enabled: running && sessionId !== "",
    queryFn: async (): Promise<LessonLive> => {
      const response = await fetch(`/api/sessions/${sessionId}/live`);
      if (!response.ok) throw new Error("Нет связи с сервером.");
      return (await response.json()) as LessonLive;
    },
    refetchInterval: 5000,
  });
  const refresh = () =>
    void client.invalidateQueries({ queryKey: key(sessionId) });
  const pause = useMutation({
    mutationFn: ({ userId, on }: { userId: string | null; on: boolean }) =>
      post(`/api/sessions/${sessionId}/${on ? "pause" : "resume"}`, {
        participant_id: userId,
      }),
    onSettled: refresh,
  });
  const send = useMutation({
    mutationFn: ({ userId, text }: { userId: string; text: string }) =>
      post(`/api/sessions/${sessionId}/messages`, { user_id: userId, text }),
    onSettled: refresh,
  });
  const failed = pause.error ?? send.error ?? live.error;
  return {
    live: live.data ?? null,
    error: failed ? failed.message : null,
    busy: pause.isPending || send.isPending,
    pause: (userId) => pause.mutate({ userId, on: true }),
    resume: (userId) => pause.mutate({ userId, on: false }),
    send: async (userId, text) => {
      try {
        await send.mutateAsync({ userId, text });
        return true;
      } catch {
        return false;
      }
    },
  };
}
