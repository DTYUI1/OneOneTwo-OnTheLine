// Выбор в пульте задаёт занятие доски, в том числе при нескольких running.
import { LiveBoard } from "../live";
import type { Session } from "./model";
import styles from "./Console.module.css";

export function LiveTab({ session }: { session: Session }) {
  if (session.status === "draft")
    return (
      <p className={styles.placeholder}>
        Занятие ещё не начато. Доска оживёт после «Начать занятие»: на ней будет
        каждое рабочее место, открытые карточки и таймеры нормативов.
      </p>
    );
  if (session.status === "finished")
    return (
      <p className={styles.placeholder}>
        Занятие завершено. Итоги — на вкладке «Отчёт».
      </p>
    );
  return <LiveBoard sessionId={session.id} />;
}
