import { type ReactNode, useEffect, useRef, useState } from "react";
import styles from "./LiveBoard.module.css";
import { attentionSeats, type BoardTile, clock } from "./board";
import { InjectFeed, InjectMenu, useInjects } from "./Injects";
import { useLessonControl } from "./lessonControl";
import { SeatPanel } from "./SeatPanel";
import { ScreenSlot, ScreenZoom, useScreens } from "./Screens";
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

/** Пауза ученика (TC-12) — словом в строке фазы, а не новым элементом плитки. */
function phaseLine(tile: BoardTile, paused: boolean): string {
  if (!paused) return phaseWord(tile);
  return tile.card ? `${phaseWord(tile)} · на паузе` : "На паузе";
}

/** Счётчик изменений значения: 0 — ещё не менялось (при загрузке доска не вспыхивает). */
function useChanges(value: string): number {
  const previous = useRef(value);
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setChanges((count) => count + 1);
  }, [value]);
  return changes;
}

function seats(numbers: readonly number[]): string {
  return numbers.map((number) => `АРМ ${number}`).join(", ");
}

export function Tile({
  tile,
  inject,
  paused = false,
  selected = false,
  onSelect,
  screen,
}: {
  tile: BoardTile;
  /** Меню вводной на это место (DT-06); нет — доска только смотрит. */
  inject?: ReactNode;
  /** Ученик на паузе (TC-12). */
  paused?: boolean;
  selected?: boolean;
  /** Щелчок по месту открывает панель места; нет — плитка только показывает. */
  onSelect?: () => void;
  /** Экран ученика (HQ-017): кнопка «Смотреть экран» или живая картинка. */
  screen?: ReactNode;
}) {
  const phase = phaseLine(tile, paused);
  const changes = useChanges(phase);
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
    <article
      className={`${styles.tile} ${tone} ${selected ? styles.selected : ""}`}
    >
      {onSelect ? (
        <button
          type="button"
          className={styles.seatButton}
          aria-expanded={selected}
          onClick={onSelect}
        >
          <span className={styles.number}>АРМ {tile.workstationNumber}</span>
          <span className={styles.name}>{tile.fullName}</span>
        </button>
      ) : (
        <div className={styles.seat}>
          <span className={styles.number}>АРМ {tile.workstationNumber}</span>
          <span className={styles.name}>{tile.fullName}</span>
        </div>
      )}
      <div className={styles.who}>
        {tile.ddsServiceName} · уровень {tile.level}
      </div>
      <div
        key={changes}
        className={`${styles.phase} ${changes ? styles.flash : ""}`}
        data-phase=""
      >
        {phase}
      </div>
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
      {inject && <div className={styles.injectSlot}>{inject}</div>}
      {screen && <div className={styles.injectSlot}>{screen}</div>}
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
  // Вводные (DT-06) — только у идущего занятия; хук держим до ранних return.
  const injects = useInjects(
    board.session?.id ?? "",
    board.session?.status === "running",
  );
  const control = useLessonControl(
    board.session?.id ?? "",
    board.session?.status === "running",
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const screens = useScreens(
    board.session?.id ?? "",
    board.session?.status === "running",
  );
  const [zoomed, setZoomed] = useState<string | null>(null);

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
  const running = board.session.status === "running";
  const lessonPaused = Boolean(control.live?.paused_at);
  const chosenTile = board.tiles.find((tile) => tile.userId === chosen) ?? null;
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
        {running && (
          <InjectMenu injects={injects} targets="all" label="все места" />
        )}
        {running && (
          <button
            type="button"
            disabled={control.busy}
            onClick={() =>
              lessonPaused ? control.resume(null) : control.pause(null)
            }
          >
            {lessonPaused ? "Продолжить занятие" : "Пауза"}
          </button>
        )}
      </div>
      {lessonPaused && (
        <p className={styles.pausedNote}>
          Занятие на паузе: новые карточки не приходят, их сроки сдвинутся на
          время паузы.
        </p>
      )}
      {control.error && <p role="alert">{control.error}</p>}
      <div className={styles.grid}>
        {board.tiles.map((tile) => (
          <Tile
            key={tile.userId}
            tile={tile}
            paused={Boolean(control.live?.participants[tile.userId])}
            selected={tile.userId === chosen}
            onSelect={
              running
                ? () =>
                    setChosen((current) =>
                      current === tile.userId ? null : tile.userId,
                    )
                : undefined
            }
            inject={
              // У каждого места идущего занятия: применима ли вводная, решает сервер по
              // карточке места и называет причину («Нет открытой карточки»).
              running ? (
                <InjectMenu
                  injects={injects}
                  targets={[tile.userId]}
                  label={`АРМ ${tile.workstationNumber}`}
                />
              ) : undefined
            }
            screen={
              running ? (
                <ScreenSlot
                  screens={screens}
                  userId={tile.userId}
                  label={`АРМ ${tile.workstationNumber}`}
                  onZoom={setZoomed}
                />
              ) : undefined
            }
          />
        ))}
      </div>
      {running && chosenTile && (
        <SeatPanel
          tile={chosenTile}
          control={control}
          onClose={() => setChosen(null)}
        />
      )}
      {screens.failure && <p role="alert">{screens.failure}</p>}
      {running && zoomed && (
        <ScreenZoom
          screens={screens}
          userId={zoomed}
          label={`АРМ ${
            board.tiles.find((tile) => tile.userId === zoomed)
              ?.workstationNumber ?? ""
          }`}
          onClose={() => setZoomed(null)}
        />
      )}
      {running && <InjectFeed injects={injects} />}
    </section>
  );
}
