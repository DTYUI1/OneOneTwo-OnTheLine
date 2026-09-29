// Разговор с заявителем — перемещаемое учебное окно поверх карточки.
// Этап 2 (docs/operator_112_review/PLAN.md): голос и фон в трубке, тон без цифры,
// «Успокоить» (просьба с причиной — IAED), «Слышу, записываю», советы, пауза оператора и
// ухудшение ситуации по сценарию. Этап 3: вопросы по шагам опроса (вкладки шагов, 3–4
// варианта шага вместо викторины), «Сложно» — свой вопрос словами, повтор адреса по
// карточке, журнал звонка для разбора. Правила заявителя — на сервере
// (contracts/operator/dialog.md), время — здесь.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HelpButton } from "../shared/help/HelpProvider";
import type { CallScenario, OperatorData } from "./data";
import {
  CALM_OPTIONS,
  CONFIRM_KEY,
  ENDED,
  HOLD_PHRASE,
  NO_ANSWER,
  PAUSE_S,
  START_PROGRESS,
  STEP_TITLES,
  TONES,
  act,
  calmPhrase,
  escalationDue,
  firstLines,
  startState,
  stepOptions,
  type Action,
  type CallerState,
  type Line,
  type Progress,
} from "./dialog";
import {
  EMPTY_JOURNAL,
  endEvent,
  openingEvent,
  passSteps,
  replyEvent,
  type CallJournal,
  type JournalEvent,
} from "./journal";
import type { Address } from "./model";
import styles from "./OperatorPage.module.css";
import { createCallerAudio } from "./voice";
import { TalkMenu } from "./TalkMenu";
import { TALK_EDGES } from "./talkWindow";
import type { useTalkWindow } from "./useTalkWindow";

const WHO: Record<Line["who"], string> = {
  caller: "Заявитель",
  operator: "Вы",
  note: "",
};
const LINE_CLASS: Record<Line["who"], string | undefined> = {
  caller: styles.talkCaller,
  operator: styles.talkOperator,
  note: styles.talkNote,
};
const ASKED_NOTE_ID = "operator-question-asked";

/** Одна подсказка в разговоре — самая срочная (замечание капитана 29.09 о «Успокоить»). */
function hintFor(state: CallerState, started: boolean): string | null {
  if (state.panic >= 3)
    return "Заявитель в истерике и не слышит вопросов. «Успокоить» → просьба с причиной; повторяйте её подряд, пока голос не станет спокойнее, — вопросы между повторами не помогают.";
  if (
    state.panic === 2 &&
    state.calm_reason > 0 &&
    !state.facts.includes("address")
  )
    return "Паника ещё высокая: повторите ту же просьбу с причиной — заявитель успокоится и назовёт адрес.";
  if (state.escalated && !state.escalation_handled)
    return "Ситуация ухудшилась — дайте совет из меню «Советы».";
  if (!started) return "";
  return null;
}

function ReplayIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1 0.5 9 5 1 9.5z" fill="currentColor" />
    </svg>
  );
}

export function Talk({
  floating,
  scenario,
  data,
  phone,
  accepted,
  ended,
  address,
  onStateChange,
  onJournalChange,
}: {
  floating: ReturnType<typeof useTalkWindow>;
  scenario: CallScenario;
  data: OperatorData;
  /** Входящий номер (АОН) — для подсказки в начале звонка. */
  phone: string;
  /** Оператор принял вызов: звучит первая реплика, идут пауза и ухудшение. */
  accepted: boolean;
  /** Чем закончился разговор: no_contact, dropped или saved. */
  ended: string | null;
  /** Адрес карточки: его оператор повторяет вслух, по нему отвечает заявитель. */
  address: Address;
  /** Состояние заявителя и шаги опроса — родителю: оценка, проводник. */
  onStateChange?: (state: CallerState, progress: Progress) => void;
  /** Журнал звонка — родителю, уходит в попытку при «сохранить». */
  onJournalChange?: (journal: CallJournal) => void;
}) {
  const { collapsed, toggleCollapsed: onCollapse } = floating;
  const audio = useMemo(() => createCallerAudio(), []);
  const [lines, setLines] = useState<Line[]>([]);
  const [state, setState] = useState<CallerState>(() => startState(scenario));
  const [progress, setProgress] = useState<Progress>(START_PROGRESS);
  // Вкладка шага, открытая щелчком; null — текущий шаг (вкладка идёт за ним сама).
  const [viewStep, setViewStep] = useState<number | null>(null);
  const [heardExtra, setHeardExtra] = useState<ReadonlySet<string>>(new Set());
  const [hard, setHard] = useState(false);
  const [ownQuestion, setOwnQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [menu, setMenu] = useState<"calm" | "advice" | null>(null);
  const [muted, setMuted] = useState(false);
  const [started, setStarted] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  // Таймеры читают свежие значения из ссылок, а не из замыкания интервала.
  const stateRef = useRef(state);
  const busyRef = useRef(false);
  const lastAction = useRef(Date.now());
  const acceptedAt = useRef<number | null>(null);
  const openedRef = useRef(false);
  const addressRef = useRef(address);
  addressRef.current = address;
  const journalRef = useRef<CallJournal>(EMPTY_JOURNAL);
  // Колбэки родителя — через ссылку: новая функция на каждой отрисовке не должна
  // перезапускать эффекты (конец разговора записался бы в журнал дважды).
  const parent = useRef({ onStateChange, onJournalChange });
  parent.current = { onStateChange, onJournalChange };
  const closed = ended !== null;
  const closedRef = useRef(closed);
  closedRef.current = closed;

  /** Секунды от «Принять вызов» — время события в журнале. */
  const now = useCallback(
    () =>
      acceptedAt.current === null
        ? 0
        : Math.floor((Date.now() - acceptedAt.current) / 1000),
    [],
  );
  const record = useCallback(
    (event: JournalEvent | null, done?: readonly number[]) => {
      const current = journalRef.current;
      journalRef.current = {
        events: event ? [...current.events, event] : current.events,
        steps: done
          ? passSteps(current.steps, done, event?.t ?? now())
          : current.steps,
      };
      parent.current.onJournalChange?.(journalRef.current);
    },
    [now],
  );

  useEffect(() => {
    if (ended) {
      setLines((current) => [
        ...current,
        { who: "note", text: ENDED[ended] ?? "" },
      ]);
      // Сохранение само дописывает конец разговора в журнал (OperatorPage).
      if (ended !== "saved") record(endEvent(now(), ENDED[ended] ?? ""));
      audio.stop();
    }
  }, [ended, audio, record, now]);
  useEffect(
    () => parent.current.onStateChange?.(state, progress),
    [state, progress],
  );
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [lines]);
  useEffect(() => {
    const element = log.current;
    if (!element) return;
    // Лента сжалась (выбран тип — открылась опросная карта): последние реплики — на виду.
    const observer = new ResizeObserver(() =>
      element.scrollTo({ top: element.scrollHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => audio.stop(), [audio]);

  const say = useCallback(
    async (line: Line) => {
      setLines((current) => [...current, line]);
      setSpeaking(true);
      await audio.say(line.voice, line.text);
      setSpeaking(false);
    },
    [audio],
  );

  const send = useCallback(
    async (action: Action, spoken?: string) => {
      if (busyRef.current || closedRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setMenu(null);
      if (spoken) {
        setStarted(true);
        setLines((current) => [...current, { who: "operator", text: spoken }]);
      }
      const before = stateRef.current;
      const at = now();
      try {
        const result = await act(
          scenario.id,
          before,
          action,
          action.kind === "question" ? addressRef.current : undefined,
        );
        stateRef.current = result.state;
        setState(result.state);
        setProgress(result.progress);
        record(
          result.reply.outcome === "noop"
            ? null
            : replyEvent(at, action, spoken, before, result),
          result.progress.done,
        );
        // Открытый щелчком шаг пройден — вкладка возвращается к текущему шагу.
        setViewStep((view) =>
          view !== null && result.progress.done.includes(view) ? null : view,
        );
        // Лишний вопрос, который заявитель услышал, — серый, как заданный вопрос карты.
        if (
          action.kind === "question" &&
          "distractor" in action.question &&
          result.reply.outcome !== "unheard"
        ) {
          const key = action.question.distractor;
          setHeardExtra((current) => new Set(current).add(key));
        }
        if (result.reply.text && !closedRef.current)
          await say({
            who: "caller",
            text: result.reply.text,
            voice: result.reply.voice ?? undefined,
          });
      } catch {
        setLines((current) => [...current, { who: "note", text: NO_ANSWER }]);
      } finally {
        busyRef.current = false;
        setBusy(false);
        lastAction.current = Date.now();
      }
    },
    [scenario.id, say, now, record],
  );

  // Вызов принят: первая реплика и фон в трубке. Ссылка — чтобы не повторить в StrictMode.
  useEffect(() => {
    if (!accepted || openedRef.current) return;
    openedRef.current = true;
    acceptedAt.current = Date.now();
    audio.background(scenario.background);
    busyRef.current = true;
    setBusy(true);
    void (async () => {
      for (const line of firstLines(scenario)) {
        record(openingEvent(line.text, scenario.start_panic));
        await say(line);
      }
      busyRef.current = false;
      setBusy(false);
      lastAction.current = Date.now();
    })();
  }, [accepted, audio, say, scenario, record]);

  // Пауза оператора и ухудшение ситуации: раз в секунду, пока идёт разговор.
  useEffect(() => {
    if (!accepted || closed) return;
    const timer = setInterval(() => {
      if (busyRef.current || acceptedAt.current === null) return;
      const elapsed = Math.floor((Date.now() - acceptedAt.current) / 1000);
      if (escalationDue(scenario, stateRef.current, elapsed))
        void send({ kind: "escalate" });
      else if (Date.now() - lastAction.current >= PAUSE_S * 1000)
        void send({ kind: "silence" });
    }, 1000);
    return () => clearInterval(timer);
  }, [accepted, closed, scenario, send]);

  const disabled = !accepted || closed || busy;
  const hint = accepted ? hintFor(state, started) : null;
  const tone = TONES[state.panic] ?? TONES[0];
  const view = viewStep ?? progress.step;
  const options = stepOptions(data, scenario, view, address);

  const askOwn = () => {
    const text = ownQuestion.trim();
    if (!text || disabled) return;
    setOwnQuestion("");
    void send({ kind: "question", question: { text } }, text);
  };

  return (
    <section
      ref={floating.windowRef}
      className={styles.talk}
      style={floating.style}
      data-collapsed={collapsed}
      aria-label="Разговор с заявителем"
      data-help="operator-talk"
    >
      <div className={styles.talkHead} {...floating.headerProps}>
        <button
          type="button"
          className={styles.moveTalk}
          data-move-talk
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
          className={styles.collapseTalk}
          data-guide="expand"
          aria-label={collapsed ? "Развернуть разговор" : "Свернуть разговор"}
          aria-expanded={!collapsed}
          onClick={onCollapse}
        >
          {collapsed ? "+" : "−"}
        </button>
        <h2>Разговор с заявителем</h2>
        <span
          className={styles.tone}
          data-level={state.panic}
          data-speaking={speaking}
          title="Тон голоса заявителя"
        >
          <i />
          <i />
          <i />
          <i />
          <span>{tone}</span>
        </span>
        <span className={styles.talkTools}>
          <span className={styles.menuWrap}>
            <button
              type="button"
              aria-expanded={menu === "calm"}
              disabled={disabled}
              data-attention={state.panic >= 3 && accepted && !closed}
              data-guide="calm"
              onClick={() => setMenu(menu === "calm" ? null : "calm")}
            >
              Успокоить ▾
            </button>
            {menu === "calm" && (
              <TalkMenu label="Успокоить" position={floating.style}>
                {CALM_OPTIONS.map((option) => (
                  <li key={option.kind}>
                    <button
                      type="button"
                      onClick={() =>
                        void send(
                          { kind: "calm", calm: option.kind },
                          calmPhrase(option.kind, state),
                        )
                      }
                    >
                      «{calmPhrase(option.kind, state)}»
                      <small>{option.hint}</small>
                    </button>
                  </li>
                ))}
              </TalkMenu>
            )}
          </span>
          <button
            type="button"
            disabled={disabled}
            data-guide="hold"
            onClick={() => void send({ kind: "hold" }, HOLD_PHRASE)}
          >
            Слышу, записываю
          </button>
          {scenario.advice.length > 0 && (
            <span className={styles.menuWrap}>
              <button
                type="button"
                aria-expanded={menu === "advice"}
                disabled={disabled}
                data-attention={state.escalated && !state.escalation_handled}
                data-guide="advice"
                onClick={() => setMenu(menu === "advice" ? null : "advice")}
              >
                Советы ▾
              </button>
              {menu === "advice" && (
                <TalkMenu label="Советы" position={floating.style}>
                  {scenario.advice.map((item) => (
                    <li key={item.key}>
                      <button
                        type="button"
                        onClick={() =>
                          void send(
                            { kind: "advice", key: item.key },
                            item.text,
                          )
                        }
                      >
                        «{item.text}»
                      </button>
                    </li>
                  ))}
                </TalkMenu>
              )}
            </span>
          )}
          <button
            type="button"
            aria-pressed={!muted}
            title={
              muted ? "Включить звук разговора" : "Выключить звук разговора"
            }
            onClick={() => {
              audio.setMuted(!muted);
              setMuted(!muted);
            }}
          >
            {muted ? "звук выкл." : "звук вкл."}
          </button>
          <HelpButton />
          <button
            type="button"
            aria-label="Вернуть окно в центр"
            onClick={floating.centerWindow}
          >
            В центр
          </button>
        </span>
      </div>
      <div ref={log} className={styles.talkLog}>
        <ol aria-live="polite">
          {lines.map((line, index) => (
            <li key={index} className={LINE_CLASS[line.who]}>
              {line.who !== "note" && <span>{WHO[line.who]}:</span>} {line.text}
              {line.voice && (
                <button
                  type="button"
                  className={styles.replay}
                  aria-label="Прослушать ещё раз"
                  title="Прослушать ещё раз"
                  onClick={() => audio.replay(line.voice!)}
                >
                  <ReplayIcon />
                </button>
              )}
            </li>
          ))}
        </ol>
        {/* До первого вопроса — с чего начать: разбор 29.09, п. 3. */}
        {accepted && !closed && hint === "" && (
          <p className={styles.talkStart}>
            Звонок принят{phone && `, входящий номер ${phone}`}. Начните с
            адреса: без него помощь не отправить.
          </p>
        )}
        {!closed && hint && <p className={styles.talkStart}>{hint}</p>}
      </div>
      {/* Шаги опроса APCO/NENA: вкладка — вопросы шага, галочка — шаг пройден (этап 3). */}
      <div
        className={styles.steps}
        data-help="operator-steps"
        data-guide="steps"
      >
        <div className={styles.stepList} role="group" aria-label="Шаги опроса">
          {STEP_TITLES.map((title, index) => {
            const step = index + 1;
            const done = progress.done.includes(step);
            return (
              <button
                key={step}
                type="button"
                className={styles.step}
                aria-pressed={view === step}
                aria-current={progress.step === step ? "step" : undefined}
                data-done={done}
                onClick={() =>
                  setViewStep(step === progress.step ? null : step)
                }
              >
                {done && <span aria-hidden="true">✓ </span>}
                {step}. {title}
                {done && <span className={styles.srOnly}> — пройден</span>}
              </button>
            );
          })}
        </div>
        <label className={styles.hardSwitch}>
          <input
            type="checkbox"
            checked={hard}
            onChange={(event) => setHard(event.target.checked)}
          />
          Сложно: свой вопрос
        </label>
      </div>
      {hard ? (
        <form
          className={styles.hardForm}
          data-guide="options"
          onSubmit={(event) => {
            event.preventDefault();
            askOwn();
          }}
        >
          <input
            aria-label="Свой вопрос"
            placeholder="Спросите своими словами, например: «Какой этаж?»"
            value={ownQuestion}
            disabled={!accepted || closed}
            onChange={(event) => setOwnQuestion(event.target.value)}
          />
          <button type="submit" disabled={disabled || !ownQuestion.trim()}>
            Спросить
          </button>
        </form>
      ) : (
        <div
          className={styles.talkHints}
          role="group"
          aria-label="Вопросы заявителю"
          data-guide="options"
        >
          {/* Заданный вопрос отличается от выбранного тега (синего): серый, с галочкой.
              Повтор адреса не сереет: после исправления карточки его повторяют снова. */}
          {options.map((option) => {
            const done =
              option.key !== CONFIRM_KEY &&
              (state.asked.includes(option.key) || heardExtra.has(option.key));
            return (
              <button
                key={option.key}
                type="button"
                className={done ? styles.asked : styles.question}
                aria-describedby={done ? ASKED_NOTE_ID : undefined}
                disabled={disabled}
                onClick={() =>
                  void send(
                    { kind: "question", question: option.question },
                    option.label,
                  )
                }
              >
                {done && <span aria-hidden="true">✓ </span>}
                {option.label}
              </button>
            );
          })}
          <span id={ASKED_NOTE_ID} hidden>
            Вопрос уже задан
          </span>
        </div>
      )}
      <div className={styles.resizeBar}>
        <span className={styles.resizeHint}>
          Размер окна разговора — потяните за любой край или угол
        </span>
        <button
          type="button"
          className={styles.resizeTalk}
          aria-label="Изменить размер окна разговора"
          title="Потяните за угол или нажимайте стрелки: размер меняется на 20 пикселей"
          {...floating.resizeProps}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 12 12 3M7 12l5-5M11 12l1-1" stroke="currentColor" />
          </svg>
        </button>
      </div>
      {TALK_EDGES.map(({ name, edge }) => (
        <span
          key={name}
          className={styles.talkEdge}
          data-edge={name}
          aria-hidden="true"
          title="Потяните, чтобы изменить размер окна разговора"
          {...floating.edgeProps(edge)}
        />
      ))}
    </section>
  );
}
