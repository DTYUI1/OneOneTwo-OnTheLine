// Подсказка у элемента (решение 17.10): в обучении («Смотрю», «Вместе», показ опытного)
// тренажёр говорит короткой подсказкой рядом с местом, где идёт действие, со стрелкой к
// нему, — пока шаг текущий. Шаг сменился — подсказка уходит. На тестах («Сам», ступени
// 2–4, каталог сценариев, занятия преподавателя) её нет совсем: чистый АРМ.
//
// Что в подсказке и где ей встать — coach.ts; голос карточки — trainerStore.ts. Подсказка
// не закрывает элемент, на который указывает, и окно телефона; переезжает при прокрутке и
// смене размера окна. Спрятать её нельзя (капитан, 19.10): скрытая подсказка оставляла показ
// на паузе без «Продолжить».
//
// В подсказке по пояс стоит наставник Николай Сергеевич (shared/mascot): указывает ручкой
// на место шага, а у проверки, норматива и разговора меняет жест (coachGesture). Обучаемый
// может убрать его портретом в шапке списка — подсказка останется прежней, без фигуры.
// Во «Вместе» он читает шаг вслух (shared/mascot/mentorVoice.ts), если у текста шага есть
// запись; «Без голоса» в шапке подсказки — только текст.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { Card } from "../../shared/api";
import { connectionLine } from "../../shared/ws/connection";
import {
  MascotFigure,
  MascotVoiceSwitch,
  useMascotShown,
} from "../../shared/mascot/Mascot";
import { poseToward, type MascotPose } from "../../shared/mascot/mascotModel";
import { lineForText, say } from "../../shared/mascot/mentorVoice";
import { useSession } from "../../shared/session";
import { formatDuration, isClosed, reactionTimer } from "../cardModel";
import { findPointer } from "../practice/pointerTarget";
import { urgencySignal } from "../signals";
import { useCardTiming } from "../useTiming";
import {
  coachAnchor,
  coachGesture,
  coachKind,
  coachParts,
  coachPose,
  mentorAim,
  mentorOnRight,
  placeCoach,
  type Box,
  type CoachAnchor,
  type CoachGesture,
  type CoachPlace,
} from "./coach";
import { pointAt } from "./ghost";
import { MEMO_CHECK } from "./stages";
import { useTrainer } from "./TrainerContext";
import {
  claimSignal,
  normText,
  remindDue,
  urgencyStage,
  urgencyText,
} from "./urgency";
import { getSound, setSound, soundGain, subscribeSound } from "./urgencySound";
import {
  trainerStore,
  useTrainerState,
  type CardVoice,
  type DemoState,
} from "./trainerStore";
import styles from "./TrainerCoach.module.css";

const NOTHING_TO_SHOW =
  "Сейчас ничего не нужно: бригада в пути или работает — она позвонит сама.";

export function TrainerCoach({
  cards,
  now,
  reactionS,
}: {
  /** Реестр: время «Принята» ждёт — по карточке из общего расчёта C-02. */
  readonly cards: readonly Card[];
  readonly now: number;
  readonly reactionS: number;
}) {
  const trainer = useTrainer();
  const { card, demo, note, anchor } = useTrainerState();
  // «Принята» ждёт дольше 70 % норматива — у наставника жест «обратите внимание».
  const [urgent, setUrgent] = useState(false);
  const mascot = useMascotShown();
  const shown = demo && card && demo.cardId === card.cardId ? demo : null;
  const kind = card
    ? coachKind({
        practice: card.practice,
        mode: trainer?.mode ?? null,
        closed: card.closed,
        demo: Boolean(shown && (!shown.over || !card.closed)),
      })
    : null;
  if (!card || !kind) return null;
  // Идущий показ: подсказка с «Беру управление» и «Пауза» видна, даже когда цели нет.
  const running = Boolean(shown && !shown.over);
  const parts = coachParts(kind);
  const source = cards.find((item) => item.id === card.cardId) ?? null;
  const waiting =
    parts.urgency &&
    source !== null &&
    !isClosed(source) &&
    !source.interrupted_at &&
    (source.state === "added" || source.state === "received");
  const where = coachAnchor(kind, {
    check: parts.check && card.check !== null,
    heard: parts.heard && card.heard !== null,
    clarity: parts.clarity && card.clarity !== null,
  });
  // «Вместе» без шага (бригада в пути) и без строк у статуса — сказать нечего.
  const empty =
    kind === "together" &&
    !card.tip &&
    !waiting &&
    !(parts.heard && card.heard) &&
    !(parts.clarity && card.clarity) &&
    !(parts.check && card.check);
  if (empty) return null;
  const checking = parts.check && card.check !== null;
  const gesture = coachGesture({
    check: checking,
    urgent: parts.urgency && waiting && urgent,
    correcting: kind === "together" && card.rejected,
    talking: kind === "together" && card.tip?.target === "hangup",
    paused: kind === "watch" && Boolean(shown?.paused),
  });

  return createPortal(
    <Mark
      where={where}
      cursor={anchor}
      card={card}
      gesture={mascot ? gesture : null}
      speaks={mascot && kind === "together"}
      keepVisible={running}
      title={
        kind === "watch"
          ? shown?.expert
            ? "Как сделал бы опытный"
            : "Смотрю"
          : "Вместе"
      }
    >
      {kind === "watch" && shown ? (
        <Watch demo={shown} note={note} />
      ) : (
        // Проверка взведена — говорит только она: шаг проводника подождёт.
        !(parts.check && card.check) && (
          <Together card={card} speak={kind === "together"} />
        )
      )}
      {parts.urgency && waiting && source && (
        <ReactionLine
          card={source}
          now={now}
          reactionS={reactionS}
          onUrgent={setUrgent}
        />
      )}
      {parts.heard && card.heard && !card.closed && (
        <Heard heard={card.heard} />
      )}
      {parts.clarity && card.clarity && !card.closed && (
        <Clarity hint={card.clarity} />
      )}
      {parts.check && card.check && <Check check={card.check} />}
      {kind === "watch" && shown && !shown.over && (
        <div className={styles.btns}>
          {!shown.expert && (
            <button
              type="button"
              className={styles.main}
              disabled={trainer?.takingOver}
              onClick={() => void trainer?.takeOver()}
            >
              Беру управление
            </button>
          )}
          <button
            type="button"
            className={styles.btn}
            disabled={
              shown.paused &&
              (trainer?.takingOver || trainer?.takeOverUncertain)
            }
            onClick={() => trainerStore.updateDemo({ paused: !shown.paused })}
          >
            {shown.paused ? "Продолжить" : "Пауза"}
          </button>
        </div>
      )}
      {kind !== "watch" && !(parts.check && card.check) && card.tip && (
        <ShowButton card={card} />
      )}
    </Mark>,
    document.body,
  );
}

const visible = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLElement && el.isConnected && el.getClientRects().length > 0;

const boxOf = (el: Element): Box => {
  const rect = el.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
};

/** Одна рамка вокруг нескольких: строка статуса вместе с заметками над ней. */
function union(boxes: readonly Box[]): Box {
  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.left + box.width));
  const bottom = Math.max(...boxes.map((box) => box.top + box.height));
  return { left, top, width: right - left, height: bottom - top };
}

/** Элемент, к которому встаёт подсказка, и что ей нельзя закрывать. */
function locate(
  where: CoachAnchor,
  cursor: Element | null,
  card: CardVoice,
): { readonly target: Element; readonly obstacles: Box[] } | null {
  const cardEl = trainerStore.handlers().cardElement?.() ?? null;
  const form = cardEl?.querySelector('[data-help="card-action"]') ?? null;
  const notes = cardEl?.querySelector("[data-line-notes]") ?? null;
  const phone = document.querySelector('[data-help="card-phone"]');
  const step =
    cardEl && card.tip ? (findPointer(cardEl, card.tip)?.el ?? null) : null;
  let target: Element | null = null;
  if (where === "line" && visible(form)) {
    // Проверка — у ✓, «Услышано» — у списка статусов, понятность — у комментария.
    target =
      form.querySelector(
        card.check
          ? '[data-help="line-confirm"]'
          : card.heard
            ? '[data-help="line-status"]'
            : '[data-help="line-comment"]',
      ) ?? form;
  } else if (where === "cursor" && visible(cursor)) target = cursor;
  if (!visible(target)) target = visible(step) ? step : null;
  if (!target && where !== "step" && visible(form)) target = form;
  if (!target) return null;
  // По важности: окно телефона подсказка закрывает в последнюю очередь (placeCoach).
  const obstacles: Box[] = [];
  if (visible(phone)) obstacles.push(boxOf(phone));
  if (visible(form))
    obstacles.push(
      union([boxOf(form), ...(visible(notes) ? [boxOf(notes)] : [])]),
    );
  return { target, obstacles };
}

function samePlace(a: CoachPlace | null, b: CoachPlace | null) {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.side === b.side &&
      Math.round(a.left) === Math.round(b.left) &&
      Math.round(a.top) === Math.round(b.top) &&
      Math.round(a.arrow) === Math.round(b.arrow))
  );
}

function Mark({
  where,
  cursor,
  card,
  gesture,
  speaks,
  keepVisible,
  title,
  children,
}: {
  readonly where: CoachAnchor;
  readonly cursor: Element | null;
  readonly card: CardVoice;
  /** Жест наставника; null — наставник выключен, подсказка без фигуры. */
  readonly gesture: CoachGesture | null;
  /** Наставник читает шаг вслух — в шапке «Без голоса». */
  readonly speaks: boolean;
  readonly keepVisible: boolean;
  readonly title: string;
  readonly children: ReactNode;
}) {
  const box = useRef<HTMLElement>(null);
  const [place, setPlace] = useState<CoachPlace | null>(null);
  // Ширина подсказки — у какого края встать наставнику (у хвостика).
  const [width, setWidth] = useState(0);
  // Куда наставник указывает рукой — по положению цели относительно его плеча.
  const [pointing, setPointing] = useState<MascotPose>("point-down");
  // Позиция — по живой разметке: окно телефона перетаскивают, строка статуса открывается,
  // курсор показа переходит. Пересчёт — при прокрутке, смене размера и раз в 200 мс.
  const measure = useRef(() => {});
  measure.current = () => {
    const el = box.current;
    if (!el) return;
    const found = locate(where, cursor, card);
    if (!found) {
      setPlace((prev) => (prev === null ? prev : null));
      return;
    }
    const next = placeCoach(
      boxOf(found.target),
      { width: el.offsetWidth, height: el.offsetHeight },
      {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
      found.obstacles,
    );
    setPlace((prev) => (samePlace(prev, next) ? prev : next));
    setWidth(el.offsetWidth);
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    const aim = mentorAim(
      next,
      size,
      boxOf(found.target),
      mentorOnRight(next, size.width),
    );
    setPointing(poseToward(aim.dx, aim.dy));
  };
  useLayoutEffect(() => measure.current());
  useEffect(() => {
    const run = () => measure.current();
    const timer = window.setInterval(run, 200);
    window.addEventListener("resize", run);
    window.addEventListener("scroll", run, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", run);
      window.removeEventListener("scroll", run, true);
    };
  }, []);
  const side = place?.side ?? "below";

  return (
    <section
      ref={box}
      className={styles.coach}
      aria-label="Подсказка тренажёра"
      data-coach=""
      data-help="trainer-coach"
      data-placed={place !== null || keepVisible}
      data-fallback={place === null && keepVisible}
      data-side={side}
      data-mentor={gesture !== null}
      style={{
        left: place?.left,
        top: place?.top,
        ["--arrow" as string]: `${place?.arrow ?? 16}px`,
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Esc в подсказке не закрывает карточку и не прячет её (решение 19.10; PR3-02):
        // кнопки показа остаются под рукой.
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {/* С наставником — он сам по себе, без окна, а подсказка — его «облако» речи с
          хвостиком к голове; на цель показывает его рука. Без наставника — окно со
          стрелкой к цели, как было. */}
      <div
        className={styles.row}
        data-mentor-right={
          gesture !== null && place !== null && mentorOnRight(place, width)
        }
      >
        {gesture !== null && (
          <MascotFigure
            pose={coachPose(gesture, pointing)}
            className={styles.mentor}
          />
        )}
        <div className={styles.cloud}>
          <div className={styles.head}>
            <span>{title}</span>
            {speaks && <MascotVoiceSwitch className={styles.voice} />}
          </div>
          <div className={styles.body} aria-live="polite">
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}

/** «Смотрю»: что сейчас делает курсор тренажёра. */
function Watch({
  demo,
  note,
}: {
  readonly demo: DemoState;
  readonly note: string | null;
}) {
  return (
    <>
      <p>{demo.text || "…"}</p>
      {note && <p className={styles.muted}>{note}</p>}
    </>
  );
}

/** «Вместе»: что сделать на этом шаге. */
function Together({
  card,
  speak,
}: {
  readonly card: CardVoice;
  /** Читать шаг вслух: только во «Вместе», у показа свой текст. */
  readonly speak: boolean;
}) {
  const cardEl = trainerStore.handlers().cardElement?.() ?? null;
  const text = card.tip
    ? ((cardEl && findPointer(cardEl, card.tip)?.text) ?? card.tip.text)
    : null;
  // Одна реплика на шаг: ключ — карточка, шаг и сама реплика (доклад о прибытии и о работах
  // — разные шаги с одной фразой «Доклад получен…»). Фразы без записи — молча.
  const line = speak && text ? lineForText(text) : null;
  useEffect(() => {
    if (line) say(line.id, `${card.cardId}:${card.step ?? ""}:${line.id}`);
  }, [line, card.cardId, card.step]);
  if (!text) return null;
  return <p>{text}</p>;
}

/** «Покажи» — внизу подсказки, под текстом шага и строками таймера. */
function ShowButton({ card }: { readonly card: CardVoice }) {
  const [nothing, setNothing] = useState(false);
  useEffect(() => {
    if (!nothing) return;
    const timer = window.setTimeout(() => setNothing(false), 4000);
    return () => window.clearTimeout(timer);
  }, [nothing]);
  return (
    <>
      <div className={styles.btns}>
        <button
          type="button"
          className={styles.btn}
          disabled={!card.canAct}
          title={
            card.canAct
              ? "Курсор покажет, куда нажать"
              : "Карточка закрыта или занятие завершено — показывать нечего"
          }
          onClick={() => {
            const el = trainerStore.handlers().cardElement?.() ?? null;
            const found = card.tip && el && findPointer(el, card.tip);
            if (!card.tip || !found) {
              setNothing(true);
              return;
            }
            pointAt(found.el);
            // «Покажи» засчитывается как помощь: разбор, «Вместе» пройдено.
            trainerStore.handlers().helped?.(`show:${card.tip.target}`);
          }}
        >
          Покажи
        </button>
      </div>
      {nothing && <p className={styles.muted}>{NOTHING_TO_SHOW}</p>}
    </>
  );
}

/**
 * Проверка перед «Не принята», «Отказ», «Работы завершены» — памятка ДДС, с. 21–22. Сама
 * проверка (второе ✓) — в строке статуса во всех режимах; здесь — её смысл, для обучения.
 */
function Check({ check }: { readonly check: NonNullable<CardVoice["check"]> }) {
  return (
    <div className={styles.check} data-trainer-check="">
      <p className={styles.src}>
        Перед «{check.label}» — памятка ДДС, с. {MEMO_CHECK[check.status].page}
      </p>
      <p>{MEMO_CHECK[check.status].text}</p>
      <p className={styles.muted}>
        {check.comment
          ? `В вашем комментарии: «${check.comment}»`
          : check.required
            ? "Комментария нет — без него статус не сохранить."
            : "Комментария нет."}
      </p>
      <div className={styles.btns}>
        <button
          type="button"
          className={styles.main}
          data-act="confirm"
          disabled={check.required && !check.comment}
          title={
            check.required && !check.comment
              ? "Сначала напишите причину в комментарии — без неё статус не сохранить"
              : undefined
          }
          onClick={() => trainerStore.handlers().confirmCheck?.()}
        >
          Сохранить «{check.label}»
        </button>
        <button
          type="button"
          className={styles.btn}
          onClick={() => trainerStore.handlers().backToComment?.()}
        >
          Вернуться к комментарию
        </button>
      </div>
    </div>
  );
}

/**
 * «Услышано по телефону: Работы завершены · Подставить» (TC-05): статус, который старший назвал
 * словами. Подставляет его обучаемый сам — нажатием; сохраняет — «Подтвердить» в строке статуса.
 */
function Heard({ heard }: { readonly heard: NonNullable<CardVoice["heard"]> }) {
  return (
    <p className={styles.line} role="group" aria-label="Услышано по телефону">
      Услышано по телефону: <b>{heard.label}</b>
      <button
        type="button"
        className={styles.link}
        onClick={() => trainerStore.handlers().applyHeard?.(heard.status)}
      >
        Подставить
      </button>
    </p>
  );
}

/**
 * «Возможно, вы имели в виду: «Принята» · Подставить» (TC-08): комментарий набран в английской
 * раскладке или сокращён; у «ок» — что написать вместо него. Ничего не блокирует.
 */
function Clarity({
  hint,
}: {
  readonly hint: NonNullable<CardVoice["clarity"]>;
}) {
  const { suggestion } = hint;
  return (
    <p
      className={styles.line}
      role="status"
      aria-label="Понятность комментария"
    >
      {hint.text}
      {suggestion !== null && (
        <button
          type="button"
          className={styles.link}
          onClick={() => trainerStore.handlers().applyClarity?.(suggestion)}
        >
          Подставить
        </button>
      )}
    </p>
  );
}

/**
 * «73120101 — «Принята» ждёт 00:03 из 00:30» — время реакции из общего расчёта C-02. Три
 * стадии (TC-06): до 70 % норматива — как есть; 70–100 % — жёлтое «00:24 · скоро норматив»;
 * дальше — красное «00:41 · сверх норматива». Сигналы — по разу на карточку (urgency.ts).
 */
function ReactionLine({
  card,
  now,
  reactionS,
  onUrgent,
}: {
  readonly card: Card;
  readonly now: number;
  readonly reactionS: number;
  /** Пора обратить внимание на норматив — для жеста наставника. */
  readonly onUrgent: (urgent: boolean) => void;
}) {
  const timing = useCardTiming(card, now);
  const normative = timing?.reaction.normative ?? reactionS;
  const legacy = reactionTimer(card, normative, now);
  const seconds = Math.floor(timing?.reaction.seconds ?? legacy.seconds);
  const over = timing?.reaction.over ?? legacy.overdue;
  const running = timing ? timing.reaction.running : !legacy.stopped;
  const stage = urgencyStage(seconds, normative, over);
  const cardId = card.id;
  const sound = useSyncExternalStore(subscribeSound, getSound);

  // Двойной бип «осталось 10 с» и низкий «просрочено» — по разу на карточку.
  useEffect(() => {
    if (!running) return;
    const signal = claimSignal(cardId, seconds, normative);
    if (signal) urgencySignal(signal, soundGain(getSound()));
  }, [cardId, seconds, normative, running]);

  // Наставник напоминает о нормативе словами и голосом (urgency.ts: remindDue) — раньше
  // жёлтой стадии и двойного бипа; с этого момента у него жест «обратите внимание».
  const mascot = useMascotShown();
  const remind = running && remindDue(seconds, normative);
  const urgent = stage !== "calm" || remind;
  useEffect(() => {
    onUrgent(urgent);
    return () => onUrgent(false);
  }, [urgent, onUrgent]);
  const norm = mascot && remind ? normText(normative) : null;
  useEffect(() => {
    const line = norm ? lineForText(norm) : null;
    if (line) say(line.id, `${cardId}:norm`);
  }, [norm, cardId]);

  const clock = formatDuration(seconds);
  return (
    <>
      {norm && <p>{norm}</p>}
      <p className={styles.line} data-urgency={stage}>
        «Принята» ждёт{" "}
        {stage === "calm" ? (
          <>
            <b>{clock}</b> из {formatDuration(normative)}
          </>
        ) : (
          <b className={stage === "over" ? styles.late : styles.soon}>
            {urgencyText(clock, stage)}
          </b>
        )}
        <label className={styles.mute}>
          <input
            type="checkbox"
            checked={sound.muted}
            onChange={(event) =>
              setSound({ ...sound, muted: event.target.checked })
            }
          />{" "}
          Без звука
        </label>
      </p>
    </>
  );
}

/**
 * «Работа не потеряна, переподключение через 4 с… · Повторить сейчас» (TC-08): связи с сервером
 * нет. Это состояние связи, а не подсказка тренажёра, — строка видна во всех режимах.
 */
export function ConnectionNotice({ now }: { readonly now: number }) {
  const { realtime } = useSession();
  const state = useSyncExternalStore(
    realtime.subscribeConnection,
    realtime.connection,
  );
  const line = connectionLine(state, now);
  if (line === null) return null;
  return (
    <p
      className={styles.connection}
      role="status"
      aria-label="Связь с сервером"
    >
      {line}
      <button type="button" onClick={realtime.retryNow}>
        Повторить сейчас
      </button>
    </p>
  );
}
