// Место по щелчку на плитке (TC-12): пауза ученика, сообщение ему и «зеркало» — лента
// истории его карточки (тот же разбор, что после занятия). На плитке без щелчка — ничего
// нового, кроме «На паузе» вместо фазы: простота доски (рекомендации 16.10, п. 6).
import { useState } from "react";
import { Replay } from "../replay";
import type { BoardTile } from "./board";
import type { LessonControl } from "./lessonControl";
import styles from "./LiveBoard.module.css";

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SeatPanel({
  tile,
  control,
  onClose,
}: {
  tile: BoardTile;
  control: LessonControl;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const lessonPaused = Boolean(control.live?.paused_at);
  const paused = Boolean(control.live?.participants[tile.userId]);
  const messages = (control.live?.messages ?? []).filter(
    (item) => item.user_id === tile.userId,
  );

  return (
    <section
      className={styles.seatPanel}
      aria-label={`АРМ ${tile.workstationNumber}`}
    >
      <div className={styles.panelHead}>
        <h3>
          АРМ {tile.workstationNumber} · {tile.fullName}
        </h3>
        <button
          type="button"
          disabled={control.busy || lessonPaused}
          title={
            lessonPaused ? "Занятие уже на паузе — у всех учеников." : undefined
          }
          onClick={() =>
            paused ? control.resume(tile.userId) : control.pause(tile.userId)
          }
        >
          {paused ? "Продолжить для ученика" : "Пауза для ученика"}
        </button>
        <button type="button" onClick={onClose}>
          Закрыть
        </button>
      </div>
      {paused && (
        <p className={styles.panelNote}>
          Ученик на паузе: новые карточки ему не приходят, их сроки сдвинутся на
          время паузы.
        </p>
      )}

      <form
        className={styles.messageForm}
        onSubmit={(event) => {
          event.preventDefault();
          void control.send(tile.userId, text).then((ok) => {
            if (ok) setText("");
          });
        }}
      >
        <label htmlFor={`message-${tile.userId}`}>Написать ученику</label>
        <textarea
          id={`message-${tile.userId}`}
          rows={2}
          maxLength={500}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" disabled={control.busy || text.trim() === ""}>
          Отправить
        </button>
      </form>
      {messages.length > 0 && (
        <ul className={styles.messages}>
          {messages.map((item) => (
            <li key={item.id}>
              <span>{item.text}</span>{" "}
              <span className={styles.readMark}>
                {item.read_at
                  ? `прочитано в ${time(item.read_at)}`
                  : "не прочитано"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {tile.card ? (
        <Replay cardId={tile.card.id} />
      ) : (
        <p className={styles.panelNote}>Карточки сейчас нет.</p>
      )}
    </section>
  );
}
