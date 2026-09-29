// Окно разговора диспетчера — перемещаемое, поверх карточки (position: fixed), как
// окно «Разговор с заявителем» модуля 112 (operator/Talk.tsx). Живёт внутри
// карточки, а не порталом: его кнопки остаются в области «Происшествие …». Лента
// обмена «Кто: текст», события линии серым, доклад бригады крупной строкой, быстрые
// фразы только там, где за ними есть реакция (callLog.quickPhrases). Тон деловой.

import { useEffect, useRef } from "react";
import styles from "./CallWindow.module.css";
import { CALL_EDGES } from "./callGeometry";
import type { LogLine, QuickPhrase, Replay } from "./callLog";
import type { CallWindowView } from "./useCallWindow";

export interface CallWindowProps {
  readonly floating: CallWindowView;
  /** Кто на линии: служба или бригада. */
  readonly peer: string;
  readonly lines: readonly LogLine[];
  /** Линия занята (вызов или разговор): окно не закрывается, трубку можно положить. */
  readonly active: boolean;
  /** Время разговора, «м:сс»; `null` — абонент ещё не ответил. */
  readonly timer: string | null;
  /** Кто говорит сейчас. */
  readonly speaking: "peer" | "you" | null;
  /** Пояснения под лентой: что происходит и что делать. */
  readonly notes: readonly string[];
  readonly quick: readonly QuickPhrase[];
  readonly onQuick: (phrase: QuickPhrase) => void;
  readonly onHangup: () => void;
  readonly hangupDisabled: boolean;
  readonly onReplay: (replay: Replay) => void;
  readonly muted: boolean;
  readonly onMute: (muted: boolean) => void;
  readonly volume: number;
  readonly onVolume: (volume: number) => void;
  /** Запись не ушла — повтор отправки. */
  readonly onRetryUpload?: () => void;
  readonly onClose: () => void;
}

function ReplayIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1 0.5 9 5 1 9.5z" fill="currentColor" />
    </svg>
  );
}

function canReplay(replay: Replay | undefined): replay is Replay {
  return replay !== undefined && (replay.kind === "phrase" || !!replay.url);
}

export function CallWindow(props: CallWindowProps) {
  const { floating, peer, lines, active, speaking } = props;
  const { collapsed } = floating;
  const log = useRef<HTMLDivElement>(null);

  // Новая реплика — на виду: прокручивается лента, не страница.
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [lines, props.notes]);

  return (
    <section
      ref={floating.windowRef}
      className={styles.window}
      style={floating.style}
      data-collapsed={collapsed}
      aria-label={`Разговор: ${peer}`}
      onKeyDown={(event) => {
        // Esc в окне не закрывает карточку со звонком на линии. У кнопки «−/+» нет
        // aria-expanded: по нему IncidentCard решает, что Esc принадлежит телефону.
        if (event.key === "Escape") event.stopPropagation();
      }}
    >
      <div className={styles.head} {...floating.headerProps}>
        <button
          type="button"
          className={styles.move}
          data-move-call
          aria-label="Переместить окно разговора"
          title="Переместить окно разговора: стрелки — на 20 пикселей"
          onKeyDown={floating.onMoveKey}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 1v14M1 8h14M5 4l3-3 3 3M5 12l3 3 3-3M4 5 1 8l3 3M12 5l3 3-3 3"
              fill="none"
              stroke="currentColor"
            />
          </svg>
        </button>
        <button
          type="button"
          className={styles.fold}
          aria-label={
            collapsed ? "Развернуть окно разговора" : "Свернуть окно разговора"
          }
          onClick={floating.toggleCollapsed}
        >
          {collapsed ? "+" : "−"}
        </button>
        <h2 className={styles.title}>Разговор: {peer}</h2>
        <span
          className={styles.voice}
          data-speaking={speaking !== null}
          title="Кто говорит"
        >
          <i />
          <i />
          <i />
          <span>
            {speaking === "peer"
              ? "говорит"
              : speaking === "you"
                ? "вы говорите"
                : ""}
          </span>
        </span>
        {props.timer !== null && (
          <span className={styles.timer}>{props.timer}</span>
        )}
        <span className={styles.tools}>
          <button
            type="button"
            aria-pressed={!props.muted}
            title={
              props.muted
                ? "Включить звук разговора"
                : "Выключить звук разговора"
            }
            onClick={() => props.onMute(!props.muted)}
          >
            {props.muted ? "звук выкл." : "звук вкл."}
          </button>
          <button
            type="button"
            aria-label="Вернуть окно разговора в центр"
            onClick={floating.centerWindow}
          >
            В центр
          </button>
          {!active && (
            <button
              type="button"
              aria-label="Закрыть окно разговора"
              title="Закрыть окно разговора"
              onClick={props.onClose}
            >
              ×
            </button>
          )}
        </span>
      </div>

      <div ref={log} className={styles.log}>
        <ol aria-live="polite">
          {lines.map((line) => (
            <li
              key={line.id}
              className={
                line.who === "note"
                  ? styles.note
                  : line.report
                    ? styles.report
                    : line.who === "you"
                      ? styles.you
                      : undefined
              }
            >
              {line.who !== "note" && (
                <span className={styles.who}>
                  {line.who === "you" ? "Вы" : peer}:
                </span>
              )}{" "}
              {line.report ? (
                <span className={styles.reportText}>{line.text}</span>
              ) : (
                line.text
              )}
              {canReplay(line.replay) && (
                <button
                  type="button"
                  className={styles.replay}
                  aria-label="Прослушать ещё раз"
                  title="Прослушать ещё раз"
                  onClick={() => props.onReplay(line.replay!)}
                >
                  <ReplayIcon />
                </button>
              )}
            </li>
          ))}
        </ol>
        {props.notes.map((text) => (
          <p key={text} className={styles.hint}>
            {text}
          </p>
        ))}
      </div>

      {(active || props.onRetryUpload) && (
        <div className={styles.actions} role="group" aria-label="Реплики">
          {props.quick.map((phrase) => (
            <button
              key={phrase.id}
              type="button"
              className={styles.quick}
              onClick={() => props.onQuick(phrase)}
            >
              {phrase.label}
            </button>
          ))}
          {props.onRetryUpload && (
            <button
              type="button"
              className={styles.quick}
              onClick={props.onRetryUpload}
            >
              Отправить запись ещё раз
            </button>
          )}
          {active && (
            <button
              type="button"
              className={styles.hangup}
              onClick={props.onHangup}
              disabled={props.hangupDisabled}
            >
              Положить трубку
            </button>
          )}
        </div>
      )}

      <div className={styles.bottom}>
        <label className={styles.volume}>
          Громкость
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(props.volume * 100)}
            disabled={props.muted}
            onChange={(event) =>
              props.onVolume(Number(event.target.value) / 100)
            }
          />
        </label>
        <button
          type="button"
          className={styles.resize}
          aria-label="Изменить размер окна разговора"
          title="Потяните за угол или нажимайте стрелки: размер меняется на 20 пикселей"
          {...floating.resizeProps}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 12 12 3M7 12l5-5M11 12l1-1" stroke="currentColor" />
          </svg>
        </button>
      </div>
      {CALL_EDGES.map(({ name, edge }) => (
        <span
          key={name}
          className={styles.edge}
          data-edge={name}
          aria-hidden="true"
          title="Потяните, чтобы изменить размер окна разговора"
          {...floating.edgeProps(edge)}
        />
      ))}
    </section>
  );
}
