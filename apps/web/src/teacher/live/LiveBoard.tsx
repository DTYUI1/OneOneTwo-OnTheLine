import styles from "./LiveBoard.module.css";
import { attentionSeats, type BoardTile, clock } from "./board";
import { useLiveBoard } from "./useLiveBoard";
import { SessionClock } from "../console/SessionClock";

const PHASE_WORD: Record<BoardTile["phase"], string> = {
  offline: "Не в сети",
  free: "Свободен",
  // Формулировка про карточку, а не про человека: доска не обвиняет.
  reaction: "Карточка не открыта",
  handling: "В работе",
};

/**
 * В v3 реакцию закрывает «Принята» / «Не принята», а не открытие: открытая
 * карточка без статуса всё ещё в реакции, и «не открыта» было бы неправдой.
 */
function phaseWord(tile: BoardTile): string {
  // Выдана, но обучаемый её ещё не видит: отсчёт реакции не начат.
  if (tile.phase === "reaction" && tile.card?.delivered_at === null)
    return "Ждёт показа на АРМ";
  if (tile.phase === "reaction" && tile.version === 3)
    return "Статус не поставлен";
  return PHASE_WORD[tile.phase];
}

function seats(numbers: readonly number[]): string {
  return numbers.map((number) => `АРМ ${number}`).join(", ");
}

export function Tile({ tile }: { tile: BoardTile }) {
  // Приглушаем только пустые места: место с карточкой должно быть видно,
  // даже если обучаемого нет в сети.
  const quiet = tile.card === null;
  const tone = quiet
    ? styles.quiet
    : tile.alert === "overdue"
      ? styles.overdue
      : tile.alert === "soon"
        ? styles.soon
        : styles.busy;
  const timerTone =
    tile.alert === "overdue"
      ? styles.late
      : tile.alert === "soon"
        ? styles.warn
        : "";
  return (
    <article className={`${styles.tile} ${tone}`}>
      <div className={styles.seat}>
        <span className={styles.number}>АРМ {tile.workstationNumber}</span>
        <span className={styles.name}>{tile.fullName}</span>
      </div>
      <div className={styles.who}>
        {tile.ddsServiceName} · уровень {tile.level}
      </div>
      <div className={styles.phase}>{phaseWord(tile)}</div>
      <div className={`${styles.left} ${timerTone}`}>
        {tile.remainingS !== null && (
          <>
            {/* Подпись мелкая, число крупное: в плитку 230px строка целиком
                в 26px не влезает и переносом наезжает на текст ниже. */}
            <span className={styles.leftWord}>
              {tile.alert === "overdue" ? "просрочено на" : "осталось"}
            </span>
            <span className={styles.leftTime}>{clock(tile.remainingS)}</span>
          </>
        )}
      </div>
      {tile.brigadeWaitS !== null && (
        <div className={styles.calling}>
          Бригада ждёт ответа {clock(tile.brigadeWaitS)}
        </div>
      )}
      <div className={styles.what}>
        {tile.card && (
          <>
            {tile.card.source.number} · {tile.card.source.incident_class}
            {tile.alsoOpen > 0 && (
              <span className={styles.more}> · ещё {tile.alsoOpen}</span>
            )}
          </>
        )}
      </div>
    </article>
  );
}

export function LiveBoard({ sessionId }: { sessionId?: string | null }) {
  const board = useLiveBoard(sessionId);

  if (board.error) return <p role="alert">{board.error}</p>;
  if (board.loading) return <p>Загрузка занятия…</p>;
  if (!board.session)
    return (
      <p className={styles.empty}>
        {sessionId === undefined
          ? "Идущего занятия нет. Доска покажет рабочие места, когда занятие начнётся."
          : "Выберите занятие для просмотра рабочих мест."}
      </p>
    );

  const attention = attentionSeats(board.tiles);
  return (
    <section className={styles.board} aria-label="Доска выбранного занятия">
      <div className={styles.head}>
        <h2>{board.session.title}</h2>
        <SessionClock session={board.session} className={styles.clock} />
        {attention.overdue.length > 0 && (
          <span className={styles.overdueSeats}>
            Просрочено: {seats(attention.overdue)}
          </span>
        )}
        {attention.calling.length > 0 && (
          <span className={styles.overdueSeats}>
            Бригада ждёт ответа: {seats(attention.calling)}
          </span>
        )}
        {attention.soon.length > 0 && (
          <span className={styles.soonSeats}>
            Время на исходе: {seats(attention.soon)}
          </span>
        )}
        {attention.overdue.length + attention.soon.length === 0 && (
          <span className={styles.calm}>Все укладываются в норматив</span>
        )}
      </div>
      <div className={styles.grid}>
        {board.tiles.map((tile) => (
          <Tile key={tile.userId} tile={tile} />
        ))}
      </div>
    </section>
  );
}
