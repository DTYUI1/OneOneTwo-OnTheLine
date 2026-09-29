// Предупреждение о параллельной работе (27.09): карточки приходят, пока обучаемый
// работает с другой, и 30 с реакции идут с их появления. Обучаемый узнаёт об этом до
// первой карточки, а не по красному таймеру. Лимит — как у планировщика выдачи:
// min(parallel_cards занятия, уровень обучаемого) (worker/scheduler.py).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../shared/api";
import { useSession } from "../shared/session";
import { Dialog } from "./Dialog";
import styles from "./ParallelNotice.module.css";

const ackKey = (sessionId: string) => `arm:parallel-ack:${sessionId}`;

function acknowledged(sessionId: string): boolean {
  try {
    return localStorage.getItem(ackKey(sessionId)) === "1";
  } catch {
    return false;
  }
}

/** Идущее занятие с параллельной выдачей и его лимит; null — карточки по одной. */
export function useParallelLesson(): { id: string; capacity: number } | null {
  const { user } = useSession();
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const { data } = await api.GET("/sessions");
      return data ?? [];
    },
  });
  for (const session of sessions.data ?? []) {
    if (session.status !== "running") continue;
    const own = session.participants.find((item) => item.user_id === user.id);
    if (!own) continue;
    const capacity = Math.min(
      session.settings_snapshot.parallel_cards,
      own.level,
    );
    if (capacity > 1) return { id: session.id, capacity };
  }
  return null;
}

const RULES = [
  "Новые карточки приходят, пока вы работаете с другой, — они появляются во вкладках над экраном со звуковым сигналом.",
  "30 секунд на «Принята / Не принята» идут с момента появления карточки. Не откладывайте новую: примите решение и вернитесь к прежней.",
  "Пока бригада едет или работает, занимайтесь другими карточками. Бригада позвонит сама — вкладка замигает «Бригада вызывает».",
];

/** Окно при первом входе в такое занятие; «Понятно» запоминается по занятию. */
export function ParallelNotice() {
  const lesson = useParallelLesson();
  const [closed, setClosed] = useState<string | null>(null);
  if (!lesson || closed === lesson.id || acknowledged(lesson.id)) return null;
  const close = () => {
    try {
      localStorage.setItem(ackKey(lesson.id), "1");
    } catch {
      // Без хранилища окно вернётся после перезагрузки — это не мешает работе.
    }
    setClosed(lesson.id);
  };
  return (
    <div className={styles.backdrop}>
      <Dialog
        label="Параллельная работа"
        className={styles.dialog}
        onClose={close}
      >
        <h2>Карточки будут приходить параллельно</h2>
        <p>
          В этом занятии у вас может быть до {lesson.capacity} карточек
          одновременно — как на реальной смене. Медлить нельзя:
        </p>
        <ul>
          {RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={close}>
            Понятно
          </button>
        </div>
      </Dialog>
    </div>
  );
}

/** Строка над реестром: правило держится перед глазами всё занятие. */
export function ParallelBanner() {
  const lesson = useParallelLesson();
  if (!lesson) return null;
  return (
    <p className={styles.banner} role="note">
      Параллельная работа: до {lesson.capacity} карточек одновременно. 30 с
      реакции идут с появления карточки — не откладывайте новую. Бригады звонят
      сами.
    </p>
  );
}
