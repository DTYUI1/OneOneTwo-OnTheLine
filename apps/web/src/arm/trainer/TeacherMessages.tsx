// Сообщение преподавателя из хода занятия (TC-12, contracts/live-lesson.md): строка в
// АРМ с кнопкой «Прочитано». Опрос раз в 5 с — новых типов WS нет.
import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { csrfToken } from "../../shared/api";
import { teacherMessageSignal } from "../signals";
import styles from "./Support.module.css";

export interface TeacherMessage {
  readonly id: string;
  readonly session_id: string;
  readonly user_id: string;
  readonly text: string;
  readonly sent_at: string;
  readonly read_at: string | null;
}

const KEY = ["teacher-messages"];

export function TeacherMessages() {
  const client = useQueryClient();
  const messages = useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<TeacherMessage[]> => {
      const response = await fetch("/api/messages");
      if (!response.ok) throw new Error("Нет связи с сервером.");
      return (await response.json()) as TeacherMessage[];
    },
    refetchInterval: 5000,
  });
  const read = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/messages/${id}/read`, {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken() },
      });
      if (!response.ok) throw new Error("Не удалось отметить сообщение.");
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: KEY }),
  });

  // Сигнал — один раз на каждое новое сообщение, не на каждый опрос.
  const heard = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!messages.data) return;
    const known = heard.current;
    heard.current = new Set(messages.data.map((item) => item.id));
    if (
      known &&
      messages.data.some((item) => item.read_at === null && !known.has(item.id))
    )
      teacherMessageSignal();
  }, [messages.data]);

  const unread = (messages.data ?? []).filter((item) => item.read_at === null);

  if (unread.length === 0) return null;
  return (
    <section aria-label="Сообщения преподавателя" aria-live="polite">
      {unread.map((item) => (
        <div
          key={item.id}
          className={`${styles.voice} ${styles.message}`}
          data-teacher-message=""
        >
          <div className={styles.src}>Сообщение преподавателя</div>
          <p>{item.text}</p>
          <div className={styles.btns}>
            <button
              type="button"
              className={styles.btn}
              disabled={read.isPending}
              onClick={() => read.mutate(item.id)}
            >
              Прочитано
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
