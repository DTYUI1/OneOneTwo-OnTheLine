// Телефон ДДС (GP-09, рекомендации организаторов 16.10, п. 8): значок IP-телефона на панели
// ДДС открывает плавающее окно — макет docs/dds_training_review/phone/index.html. Рамка —
// окно разговора модуля «Оператор 112» (геометрия — shared/useFloatingWindow): размер не
// зависит от состояния звонка, тянется за любой край и угол, «−» сворачивает. Открывается
// всегда в правом нижнем углу над значком (HQ-021); в шапке — свой номер и огонёк «в сети».
//
// Окно ставит ArmPage, а разговор открытой карточки выводит в его шапку и тело Softphone
// порталами (PhoneSlots): звонок принадлежит карточке, место на экране — АРМ. Без открытой
// карточки окно показывает список контактов без звонка.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type SetStateAction,
} from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Card } from "../../shared/api";
import { formatPhone } from "../../shared/phone";
import { useSession } from "../../shared/session";
import { useFloatingWindow } from "../../shared/useFloatingWindow";
import { WINDOW_EDGES } from "../../shared/floatingWindow";

import {
  brigadesQuery,
  callTargetsQuery,
  trainingQuery,
} from "../softphone/brigade/data";
import { virtualPhone, type PhoneContact } from "../softphone/contacts";
import { formatDuration, type Service } from "../cardModel";
import { useNow } from "../useNow";
import { useLearned } from "./useLearned";
import { initialHold, type HoldState } from "./hold";
import { missedCalls } from "./missed";
import { useIncomingSignal } from "./useIncomingSignal";
import {
  CONTROL_NAME,
  missed as controlMissed,
  ringing as controlRinging,
  talking as controlTalking,
  type ControlCall,
} from "./control";
import {
  brigadeCard,
  brigadeWho,
  CONTROL_WHO,
  lineOrder,
  orderTabs,
  phoneTabs,
  type ActiveLine,
  type PhoneTab,
  type RingingLine,
  type TabAction,
} from "./lines";
import styles from "./Phone.module.css";

export { styles as phoneStyles };

/** Место и размер окна телефона — помнятся между звонками и карточками. */
const PHONE_WINDOW_KEY = "dds-phone-window-2";

/**
 * Окно телефона — узкое (правка 19.10): набор и справочник внутри него теперь вкладки, а не
 * две колонки, и широкое окно закрывало карточку. Ключ размера сменён, чтобы сохранённая
 * с прошлой раскладки ширина не осталась у тех, кто уже открывал телефон.
 */
const PHONE_WINDOW_SIZE = {
  initial: { width: 600, height: 440 },
  min: { width: 320, height: 320 },
};

/**
 * Окно прижато к правому нижнему углу над значком (.dialFloating: 16px от края, 40px) и выше
 * строки статуса карточки (правка 19.10): полоса служб 62px, отступ строки 30px и сама строка
 * около 36px — окно телефона не должно закрывать «Статус · Наряд · Комментарий · ✓ · ✕».
 */
const PHONE_DOCK = { right: 16, bottom: 140 };

/** Пояснение размера: строкой внизу, пока не выучено (GP-24), потом — при наведении. */
const RESIZE_HINT = "Размер окна — потяните за любой край или угол";

/** Шапка и тело окна, куда Softphone открытой карточки выводит разговор. */
export interface PhoneSlots {
  readonly head: HTMLElement | null;
  readonly body: HTMLElement | null;
}

/** Идущий разговор — для таймера на значке при свёрнутом или закрытом окне. */
export interface PhoneCall {
  readonly talkStartedAt: number | null;
  /** Разговор можно поставить на удержание (TC-02, вкладки 17.10). */
  readonly holdable?: boolean;
  /** Чей звонок — вкладка идущего разговора на плашке линий (вкладки 17.10). */
  readonly line?: {
    readonly callId: string;
    readonly cardId: string;
    readonly cardNumber: string;
    readonly who: string;
    /** Бригада или служба: у бригады финальной смены вкладка без «по карточке N». */
    readonly kind?: "brigade" | "service";
  } | null;
}

/** Входящий вызов бригады по карточке в работе. */
export interface Ring {
  readonly card: Card;
  readonly callId: string;
  readonly name: string;
  /** Прямой номер бригады (201…): строка входящего «Старший бригады · 201» (TC-01). */
  readonly ext: string | null;
  readonly alarm: boolean;
  readonly startedAt: number;
}

/** Звонок отдела контроля по карточке (TC-07): звонит, идёт или кончился. */
export interface ControlLine {
  readonly card: Card;
  readonly control: ControlCall;
}

/** Пропущенный вызов бригады, доклад которого ещё не услышан (TC-02, `missed.ts`). */
export interface MissedRing {
  readonly card: Card;
  readonly callId: string;
  readonly name: string;
  readonly ext: string | null;
  readonly endedAt: number;
  /** Второй пропуск того же доклада: бригада больше не звонит сама. */
  readonly lost: boolean;
}

export interface PhoneApi {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly slots: PhoneSlots;
  readonly setSlots: Dispatch<SetStateAction<PhoneSlots>>;
  readonly call: PhoneCall | null;
  readonly setCall: (call: PhoneCall | null) => void;
  readonly collapsed: boolean;
  readonly setCollapsed: (collapsed: boolean) => void;
  /** Открыть и развернуть окно (значок, ответ на вызов). */
  readonly show: () => void;
  /** Растёт с каждым show(): окно разворачивается, если было свёрнуто. */
  readonly shown: number;
  /** Входящие вызовы бригад по карточкам в работе — для значка. */
  readonly rings: readonly Ring[];
  /** Пропущенные вызовы бригад по карточкам в работе (TC-02). */
  readonly missed: readonly MissedRing[];
  /** Линии на удержании и «не дождался» (TC-02, вкладки 17.10, `hold.ts`). */
  readonly hold: HoldState;
  /** Звонит отдел контроля (TC-07) — вызовы по карточкам в работе. */
  readonly controls: readonly ControlLine[];
  /** Идёт разговор с отделом контроля: тело карточки в окне скрыто. */
  readonly controlActive: boolean;
  /** Какой звонок отдела контроля идёт — для вкладки идущего разговора. */
  readonly controlCall: {
    readonly cardId: string;
    readonly callId: string;
  } | null;
}

/**
 * `undefined` — окна телефона нет вовсе (стенды софтфона): Softphone рисует связь на месте.
 */
export const PhoneContext = createContext<PhoneApi | undefined>(undefined);

export function usePhone(): PhoneApi | undefined {
  return useContext(PhoneContext);
}

export function usePhoneState(
  rings: readonly Ring[],
  missed: readonly MissedRing[] = [],
  hold: HoldState = initialHold,
  controls: readonly ControlLine[] = [],
  controlCall: {
    readonly cardId: string;
    readonly callId: string;
  } | null = null,
): PhoneApi {
  // Телефон стоит на столе: звук принадлежит АРМ, а не окну или вкладке карточки.
  useIncomingSignal([
    ...rings,
    ...controls
      .filter((line) => controlRinging(line.control))
      .map((line) => ({
        callId: line.control.call_id,
        alarm: false,
      })),
  ]);
  const controlActive = controlCall !== null;
  const [open, setOpen] = useState(false);
  const [slots, setSlots] = useState<PhoneSlots>({ head: null, body: null });
  const [call, setCall] = useState<PhoneCall | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [shown, setShown] = useState(0);
  const show = useCallback(() => {
    setOpen(true);
    setShown((old) => old + 1);
  }, []);
  return useMemo(
    () => ({
      open,
      setOpen,
      slots,
      setSlots,
      call,
      setCall,
      collapsed,
      setCollapsed,
      show,
      shown,
      rings,
      missed,
      hold,
      controls,
      controlActive,
      controlCall,
    }),
    [
      open,
      slots,
      call,
      collapsed,
      show,
      shown,
      rings,
      missed,
      hold,
      controls,
      controlActive,
      controlCall,
    ],
  );
}

/**
 * Входящие вызовы бригад по всем карточкам в работе — старые первыми; и пропущенные (TC-02),
 * доклад которых ещё не услышан; и звонки отдела контроля (TC-07).
 */
export function usePhoneLines(
  cards: readonly Card[],
  serviceId: string | null,
): {
  readonly rings: readonly Ring[];
  readonly missed: readonly MissedRing[];
  /** Все звонки отдела контроля по карточкам в работе — звонящие и прошедшие. */
  readonly controls: readonly ControlLine[];
} {
  const targets = useQuery(callTargetsQuery(serviceId));
  // Тот же кэш, что у вкладок и софтфона: WS training.updated обновляет все три. Отдел
  // контроля звонит и по неоткрытой карточке (TC-07): сведения нужны по всем карточкам.
  const trainings = useQueries({
    queries: cards.map((card) => ({
      ...trainingQuery(card.id),
      retry: false,
      // NOTIFY не хранит события. Пропущенное уведомление не должно скрывать весь вызов
      // (25 с), даже когда окно закрыто и разговор не запущен.
      refetchInterval: 5000,
    })),
  });
  const { realtime } = useSession();
  const client = useQueryClient();
  const ids = cards.map((card) => card.id).join(",");
  useEffect(() => {
    const own = new Set(ids.split(","));
    return realtime.subscribe((event) => {
      if (event.type === "snapshot") {
        for (const id of own)
          if (id)
            void client.invalidateQueries({
              queryKey: trainingQuery(id).queryKey,
            });
      } else if (
        (event.type === "training.updated" || event.type === "call.state") &&
        own.has(event.payload.card_id)
      )
        void client.invalidateQueries({
          queryKey: trainingQuery(event.payload.card_id).queryKey,
        });
    });
  }, [realtime, client, ids]);
  const target = (id: string) => targets.data?.find((item) => item.id === id);
  const rings = cards
    .flatMap((card, index) =>
      (trainings[index]?.data?.incoming ?? []).map((call) => ({
        card,
        callId: call.call_id,
        name: target(call.call_target_id)?.name ?? "Бригада",
        ext: target(call.call_target_id)?.phone_ext ?? null,
        alarm: call.priority === "alarm",
        startedAt: Date.parse(call.started_at),
      })),
    )
    .sort((a, b) => a.startedAt - b.startedAt);
  const missed = cards
    .flatMap((card, index) => {
      const training = trainings[index]?.data;
      return training
        ? missedCalls(training).map((call) => ({
            card,
            callId: call.callId,
            name: target(call.targetId)?.name ?? "Бригада",
            ext: target(call.targetId)?.phone_ext ?? null,
            endedAt: call.endedAt,
            lost: call.lost,
          }))
        : [];
    })
    .sort((a, b) => a.endedAt - b.endedAt);
  const controls = cards
    .flatMap((card, index) => {
      const control = trainings[index]?.data?.control ?? null;
      return control ? [{ card, control }] : [];
    })
    .sort(
      (a, b) =>
        Date.parse(a.control.started_at) - Date.parse(b.control.started_at),
    );
  return { rings, missed, controls };
}

/** «чч:мм» — когда был пропущенный вызов. */
function clockOf(ms: number): string {
  return new Date(ms).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Диспетчер печатает: в поле ввода фокус не забираем. */
function typing(element: Element | null): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

export function minutes(ms: number): string {
  return formatDuration(ms / 1000, { compact: true });
}

export function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1z" />
    </svg>
  );
}

/**
 * Значок IP-телефона (рекомендации 16.10, п. 8: зелёный кружок с трубкой). Вызов — пульсирует
 * со счётчиком, тревога — красный, идёт разговор при свёрнутом или закрытом окне — таймер.
 */
export function PhoneDial({
  floating = false,
}: {
  /** Без карточки нижней полосы нет — значок в правом нижнем углу панели. */
  readonly floating?: boolean;
}) {
  const phone = usePhone();
  const now = useNow();
  if (!phone) return null;
  const rings = [
    ...phone.rings,
    ...phone.controls.filter((line) => controlRinging(line.control)),
  ];
  const alarm = phone.rings.some((ring) => ring.alarm);
  const missed =
    phone.missed.length +
    phone.controls.filter((line) => controlMissed(line.control)).length;
  const count = rings.length || missed;
  const talking = phone.call?.talkStartedAt ?? null;
  const hidden = !phone.open || phone.collapsed;
  return (
    <button
      type="button"
      className={`${styles.dial} ${floating ? styles.dialFloating : ""}`}
      data-help="phone-icon"
      data-ring={rings.length > 0}
      data-alarm={alarm}
      data-missed={missed > 0}
      aria-label={
        rings.length > 0
          ? `Телефон: входящих ${rings.length}`
          : missed > 0
            ? `Телефон: пропущенных ${missed}`
            : "Телефон"
      }
      title="Телефон"
      aria-expanded={phone.open}
      onClick={() => {
        if (rings.length > 0 || hidden) phone.show();
        else phone.setOpen(false);
      }}
    >
      <PhoneIcon />
      {count > 0 && <span className={styles.badge}>{count}</span>}
      {talking !== null && hidden && (
        <span className={styles.timer}>{minutes(now - talking)}</span>
      )}
    </button>
  );
}

/** Окно телефона: рамка, входящие и тело — разговор карточки или контакты без звонка. */
export function PhoneWindow({
  title,
  onAnswer,
  onHold = () => {},
  onResume = () => {},
  onCallback = () => {},
  onAnswerControl = () => {},
  control = null,
  own = null,
  brigadeOnly,
  idle,
  away = false,
}: {
  /** «Телефон · Служба 101» — пока разговора нет. */
  readonly title: string;
  /** Ответить на вызов бригады: идущий разговор — на удержание (вкладки 17.10). */
  readonly onAnswer: (cardId: string, callId: string) => void;
  /** «Удержать» идущий разговор (вкладки 17.10). */
  readonly onHold?: () => void;
  /** Снять линию с удержания: идущий разговор — на удержание (TC-02, вкладки 17.10). */
  readonly onResume?: (callId: string) => void;
  /** Перезвонить старшему по пропущенному вызову (TC-02). */
  readonly onCallback?: (cardId: string, ext: string) => void;
  /** Ответить отделу контроля (TC-07): идущий разговор — на удержание. */
  readonly onAnswerControl?: (cardId: string, callId: string) => void;
  /** Разговор с отделом контроля — вместо тела карточки, пока он идёт. */
  readonly control?: ReactNode;
  /** Свой номер рабочего места (HQ-053) — по нему звонят диспетчеру. */
  readonly own?: string | null;
  /**
   * Карточки финальной смены (`settings.final_shift`, HQ-033): вызов бригады подписан только
   * бригадой — без «по карточке N».
   */
  readonly brigadeOnly?: ReadonlySet<string>;
  /** Список контактов без открытой карточки. */
  readonly idle: ReactNode;
  /**
   * Карточка не открыта: окно скрыто, но не закрыто — с карточкой оно вернётся на то же
   * место (стенд 18.10: телефон только в карточке, место не теряется).
   */
  readonly away?: boolean;
}) {
  const phone = usePhone();
  const learned = useLearned();
  const learn = learned.done;
  // Свёрнутое окно телефона — шапка той же ширины, как в макете (разговор и таймер видны).
  const floating = useFloatingWindow(PHONE_WINDOW_KEY, {
    collapsedKeepsWidth: true,
    dock: PHONE_DOCK,
    limits: PHONE_WINDOW_SIZE,
    onResized: () => learn("resize"),
  });

  const now = useNow();
  const collapsed = floating.collapsed;
  const setCollapsed = phone?.setCollapsed;
  useEffect(() => setCollapsed?.(collapsed), [collapsed, setCollapsed]);
  // Значок и ответ на вызов разворачивают свёрнутое окно.
  const shown = phone?.shown ?? 0;
  const toggleCollapsed = floating.toggleCollapsed;
  const collapsedNow = useRef(collapsed);
  collapsedNow.current = collapsed;
  useEffect(() => {
    if (shown > 0 && collapsedNow.current) toggleCollapsed();
    // toggleCollapsed — новая функция на каждой отрисовке; реагируем только на show().
  }, [shown]);
  const setSlots = phone?.setSlots;
  const headRef = useCallback(
    (head: HTMLElement | null) =>
      setSlots?.((old) => (old.head === head ? old : { ...old, head })),
    [setSlots],
  );
  const bodyRef = useCallback(
    (body: HTMLElement | null) =>
      setSlots?.((old) => (old.body === body ? old : { ...old, body })),
    [setSlots],
  );
  // Входящий вызов (TC-01): фокус сразу на его вкладке, Enter отвечает. Набор в поле и идущий
  // разговор не перебиваем: там Enter значит другое.
  const answerRef = useRef<HTMLButtonElement>(null);
  const ringId =
    phone?.rings[0]?.callId ??
    phone?.controls.find((line) => controlRinging(line.control))?.control
      .call_id ??
    null;
  const open = phone?.open ?? false;
  // Каждое открытие — на постоянном месте в углу, даже если окно сдвигали (HQ-021).
  const redock = floating.redock;
  useEffect(() => {
    if (open) redock();
  }, [open, redock]);
  const busy =
    (phone?.call ?? null) !== null || (phone?.controlActive ?? false);
  // Порядок вкладок линий — по появлению: вкладка не прыгает при ответе и удержании.
  const orderRef = useRef<readonly string[]>([]);
  useEffect(() => {
    const button = answerRef.current;
    if (!ringId || !open || collapsed || busy || !button) return;
    if (typing(document.activeElement)) return;
    button.focus({ preventScroll: true });
  }, [ringId, open, collapsed, busy]);
  const controlRings = (phone?.controls ?? []).filter((line) =>
    controlRinging(line.control),
  );
  if (!phone) return null;
  const { rings, missed } = phone;
  const { held, dropped } = phone.hold;
  // Линии на плашке звонков (вкладки 17.10): идущий разговор — софтфона карточки или с
  // отделом контроля, удержанные, звонящие (бригады и отдел контроля), «не дождался».
  const controlNow = phone.controlCall
    ? phone.controls.find(
        (line) => line.control.call_id === phone.controlCall?.callId,
      )
    : undefined;
  const active: ActiveLine | null = phone.controlCall
    ? {
        ...phone.controlCall,
        cardNumber: controlNow?.card.source.number ?? null,
        who: CONTROL_WHO,
        talkStartedAt: controlNow?.control.answered_at
          ? Date.parse(controlNow.control.answered_at)
          : null,
      }
    : phone.call?.line
      ? { ...phone.call.line, talkStartedAt: phone.call.talkStartedAt }
      : null;
  // Удержать можно разговор, а не гудки и не прощание: отдел контроля — пока не ответили.
  const holdable = phone.controlCall
    ? controlTalking(controlNow?.control) && !controlNow?.control.reply
    : phone.call?.holdable === true;
  const ringing: RingingLine[] = [
    ...rings.map((ring) => ({
      callId: ring.callId,
      cardId: ring.card.id,
      cardNumber: ring.card.source.number,
      who: brigadeWho(ring.ext),
      kind: "brigade" as const,
      alarm: ring.alarm,
      startedAt: ring.startedAt,
    })),
    ...controlRings.map(({ card, control: call }) => ({
      callId: call.call_id,
      cardId: card.id,
      cardNumber: card.source.number,
      who: CONTROL_WHO,
      kind: "control" as const,
      alarm: false,
      startedAt: Date.parse(call.started_at),
    })),
  ];
  const lines = phoneTabs({
    active,
    held,
    dropped,
    rings: ringing,
    now,
    brigadeOnly,
  });
  orderRef.current = lineOrder(
    orderRef.current,
    lines.map((tab) => tab.id),
  );
  const tabs = orderTabs(lines, orderRef.current);
  // Фокус для Enter — на первом звонящем, пока разговора нет.
  const focusId = tabs.find((tab) => tab.line === "ringing")?.id ?? null;
  const act = (action: TabAction) => {
    if (action.type === "answer") onAnswer(action.cardId, action.callId);
    if (action.type === "answerControl")
      onAnswerControl(action.cardId, action.callId);
    if (action.type === "resume") onResume(action.callId);
  };
  return (
    <section
      ref={floating.windowRef}
      className={styles.talk}
      style={floating.style}
      hidden={!phone.open || away}
      data-collapsed={collapsed}
      aria-label="Телефон ДДС"
      data-help="card-phone"
      // Во время показа «Смотрю» свои щелчки здесь не проходят (TrainerContext.tsx).
      data-trainer-block=""
      onKeyDown={(event) => {
        // Esc в разговоре не закрывает карточку со звонком на линии.
        if (event.key === "Escape") event.stopPropagation();
      }}
    >
      <div
        className={styles.talkHead}
        data-help="phone-frame"
        {...floating.headerProps}
      >
        <button
          type="button"
          className={styles.headBtn}
          data-move-talk
          aria-label="Переместить окно телефона"
          title="Переместить окно телефона: стрелки — на 20 пикселей"
          onKeyDown={floating.onMoveKey}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 1v14M1 8h14M5 4l3-3 3 3M5 12l3 3 3-3M4 5 1 8l3 3M12 5l3 3-3 3"
              fill="none"
              stroke="currentColor"
            />
          </svg>
        </button>
        <button
          type="button"
          className={styles.headBtn}
          aria-label={collapsed ? "Развернуть телефон" : "Свернуть телефон"}
          aria-expanded={!collapsed}
          onClick={floating.toggleCollapsed}
        >
          {collapsed ? "+" : "−"}
        </button>
        <span className={styles.headSlot} ref={headRef} />
        <h2 className={styles.defaultTitle}>{title}</h2>
        <span className={styles.spacer} />
        {own && (
          <span
            className={styles.own}
            title="Ваш номер: по нему звонят вам. Зелёный огонёк — телефон в сети."
          >
            <i className={styles.online} aria-label="В сети" role="img" />
            {own}
          </span>
        )}
        <span className={`${styles.talkTools} ${styles.frameTools}`}>
          <button type="button" onClick={() => phone.setOpen(false)}>
            Закрыть
          </button>
        </span>
      </div>
      {tabs.length > 0 && (
        <div className={styles.lines}>
          <div
            className={styles.lineTabs}
            role="tablist"
            aria-label="Линии телефона"
            data-help="phone-incoming"
            onKeyDown={moveTabFocus}
          >
            {tabs.map((tab) => (
              <LineTab
                key={tab.id}
                tab={tab}
                buttonRef={tab.id === focusId ? answerRef : undefined}
                onAct={act}
              />
            ))}
          </div>
          <button
            type="button"
            className={styles.holdBtn}
            data-help="phone-held"
            disabled={!holdable}
            title={
              holdable
                ? "Собеседник ждёт на линии; продолжить — его вкладкой"
                : active
                  ? "Сейчас удержать нельзя: идёт набор или собеседник прощается"
                  : "Нет разговора"
            }
            onClick={onHold}
          >
            Удержать
          </button>
        </div>
      )}
      {missed.map((call) => (
        <div
          key={call.callId}
          className={styles.lineRow}
          data-line={call.lost ? "lost" : "missed"}
          data-help="phone-missed"
          role="group"
          aria-label="Пропущенный вызов"
        >
          <span
            title={
              call.lost
                ? "Бригада звонила дважды и больше не звонит сама: её доклад можно получить, только позвонив ей."
                : "Бригада звонила 25 секунд и перезвонит. Позвоните ей сами — она доложит то, что не успела."
            }
          >
            <b>Старший бригады{call.ext ? ` · ${call.ext}` : ""}</b> ·{" "}
            {call.lost ? "доклад потерян" : "пропущенный вызов"} в{" "}
            {clockOf(call.endedAt)}
            {(() => {
              const label = brigadeCard(
                call.card.id,
                call.card.source.number,
                brigadeOnly,
              );
              return label ? ` · ${label}` : "";
            })()}
          </span>
          {/* Перезвон — звонок карточки; идущий разговор встаёт на удержание (вкладки 17.10). */}
          {call.ext && (
            <button
              type="button"
              onClick={() => onCallback(call.card.id, call.ext ?? "")}
            >
              Перезвонить
            </button>
          )}
        </div>
      ))}
      {phone.controls
        .filter((line) => controlMissed(line.control))
        .map(({ card, control: call }) => (
          <div
            key={call.call_id}
            className={styles.lineRow}
            data-line="missed"
            data-help="phone-missed"
            role="group"
            aria-label="Пропущенный вызов"
          >
            <span>
              <b>{CONTROL_WHO}</b> · пропущенный вызов в{" "}
              {clockOf(Date.parse(call.ended_at ?? ""))} · по карточке{" "}
              {card.source.number}
            </span>
          </div>
        ))}
      {control}
      <div className={styles.body} ref={bodyRef} hidden={phone.controlActive} />
      <div className={styles.idle} hidden={phone.controlActive}>
        {idle}
      </div>
      {/* Полоса размера держит место, только пока пояснение не выучено (GP-24); кнопка
          размера — всегда в правом нижнем углу, поверх содержимого. */}
      {learned.shown("resize") && (
        <div className={styles.resizeBar}>
          <span className={styles.resizeHint}>{RESIZE_HINT}</span>
        </div>
      )}
      <button
        type="button"
        className={styles.grip}
        aria-label="Изменить размер окна телефона"
        title={`${RESIZE_HINT}; стрелки меняют размер на 20 пикселей`}
        {...floating.resizeProps}
      >
        <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M3 12 12 3M7 12l5-5M11 12l1-1" stroke="currentColor" />
        </svg>
      </button>
      {WINDOW_EDGES.map(({ name, edge }) => (
        <span
          key={name}
          className={styles.edge}
          data-edge={name}
          aria-hidden="true"
          title={RESIZE_HINT}
          {...floating.edgeProps(edge)}
        />
      ))}
    </section>
  );
}

/**
 * Стрелки влево и вправо переводят фокус между вкладками линий; ответ и снятие с удержания —
 * только Enter или пробел (вкладки с ручным выбором): фокус не должен отвечать на звонок.
 */
function moveTabFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const tabs = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
  ];
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  event.preventDefault();
  const step = event.key === "ArrowRight" ? 1 : -1;
  tabs[(at + step + tabs.length) % tabs.length]?.focus();
}

/** Подсказка вкладки: что сделает щелчок. */
function tabTitle(tab: PhoneTab): string {
  const what = [tab.who, tab.state, tab.card].filter(Boolean).join(" · ");
  if (tab.line === "ringing")
    return `Ответить: ${what}. Идущий разговор встанет на удержание.`;
  if (tab.line === "held")
    return `Снять с удержания: ${what}. Идущий разговор встанет на удержание.`;
  if (tab.line === "dropped")
    return `${what}: ждал на удержании больше 3 минут.`;
  return `Идёт разговор: ${what}`;
}

/**
 * Вкладка линии (вкладки 17.10): кто, что с линией, по какой карточке. Звонящая мигает цветом
 * вызова, как значок телефона; щелчок отвечает или снимает с удержания.
 */
function LineTab({
  tab,
  buttonRef,
  onAct,
}: {
  readonly tab: PhoneTab;
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly onAct: (action: TabAction) => void;
}) {
  const { action } = tab;
  return (
    <button
      ref={buttonRef}
      type="button"
      role="tab"
      className={styles.lineTab}
      aria-selected={tab.line === "active"}
      aria-disabled={action === null}
      data-line={tab.line}
      data-alarm={tab.alarm}
      title={
        tab.who === CONTROL_WHO
          ? `${CONTROL_NAME}. ${tabTitle(tab)}`
          : tabTitle(tab)
      }
      onClick={() => action && onAct(action)}
    >
      <b>{tab.who}</b>
      <small>
        {tab.state}
        {tab.card && <span className={styles.lineCard}> · {tab.card}</span>}
      </small>
    </button>
  );
}

/** Контакты без открытой карточки: кому можно звонить; звонок — из карточки. */
export function IdleContacts({
  serviceId,
  services,
  contacts,
}: {
  readonly serviceId: string | null;
  readonly services: readonly Service[];
  readonly contacts: readonly PhoneContact[];
}) {
  const brigades = useQuery(brigadesQuery(serviceId));
  const learned = useLearned();
  return (
    <>
      <div className={styles.talkLog}>
        <ContactList
          brigades={(brigades.data ?? []).map((item) => ({
            id: item.id,
            name: item.name,
            ext: null,
            stateText: null,
            state: null,
          }))}
          persons={contacts}
          services={services.filter((service) => service.id !== serviceId)}
          ownExt={
            services.find((service) => service.id === serviceId)?.phone_ext ??
            null
          }
          onDial={null}
        />
      </div>
      {/* Пояснение — пока звонки не освоены (GP-24); без него ряда нет, растёт список. */}
      {learned.shown("dial") && (
        <div className={styles.talkHints}>
          <span className={styles.status}>
            Позвонить можно из открытой карточки.
          </span>
        </div>
      )}
    </>
  );
}

export interface BrigadeContact {
  readonly id: string;
  readonly name: string;
  readonly ext: string | null;
  readonly stateText: string | null;
  /** `free` — свободна, `here` — направлена сюда, `busy` — занята на другом. */
  readonly state: "free" | "here" | "busy" | null;
}

/** Список контактов группами — `logView` макета для вида «контакты». */
export function ContactList({
  brigades,
  persons,
  services,
  ownExt,
  cardPhone = null,
  onDial,
}: {
  readonly brigades: readonly BrigadeContact[];
  /** Абоненты ДДС от преподавателя: руководство, аварийная бригада, заявитель. */
  readonly persons: readonly PhoneContact[];
  readonly services: readonly Service[];
  /** Короткий номер своей службы — для полных условных номеров бригад и руководства. */
  readonly ownExt: string | null;
  /** Номер заявителя из карточки — его строка показывает его, а не условный. */
  readonly cardPhone?: string | null;
  /** `null` — звонить нельзя (нет карточки, идёт разговор, занятие окончено). */
  readonly onDial: ((ext: string) => void) | null;
}) {
  const staff = persons.filter((item) => item.role !== "caller");
  const callers = persons.filter((item) => item.role === "caller");
  // Полный номер вместо короткого (HQ-053), как городские у служб.
  const full = (ext: string | null) =>
    !ext ? "" : ownExt ? formatPhone(virtualPhone(ownExt, ext)) : ext;
  const row = (
    key: string,
    name: string,
    sub: string,
    ext: string | null,
    state?: { text: string | null; state: BrigadeContact["state"] } | null,
  ) => (
    <li key={key}>
      <button
        type="button"
        className={styles.contact}
        data-state={state?.state ?? undefined}
        disabled={!onDial || !ext}
        title={
          !ext
            ? "Номера нет в справочнике"
            : !onDial
              ? "Сейчас позвонить нельзя: занятие не идёт или идёт другой разговор"
              : undefined
        }
        data-ext={ext ?? undefined}
        aria-label={`Позвонить: ${name}`}
        onClick={() => ext && onDial?.(ext)}
      >
        <span className={styles.go}>
          <PhoneIcon />
        </span>
        <b>{name}</b>
        <small>{sub}</small>
        {state?.text && (
          <span className={styles.st} data-free={state.state === "free"}>
            {state.text}
          </span>
        )}
      </button>
    </li>
  );
  return (
    <ol
      className={styles.contacts}
      aria-label="Контакты"
      data-help="phone-contacts"
    >
      {brigades.length > 0 && (
        <li className={styles.grp} data-forces="">
          Силы службы
        </li>
      )}
      {brigades.map((item) =>
        row(item.id, item.name, full(item.ext), item.ext, {
          text: item.stateText,
          state: item.state,
        }),
      )}
      {staff.length > 0 && (
        <li className={styles.grp}>Руководство и аварийная бригада</li>
      )}
      {staff.map((item) =>
        row(
          `${item.role}-${item.number}`,
          item.name,
          full(item.number),
          item.number,
        ),
      )}
      {services.length > 0 && <li className={styles.grp}>Службы</li>}
      {services.map((item) =>
        // Короткий номер — в названии («Мосгаз 104»), городской — мелко серым.
        row(
          item.id,
          item.name.includes(item.phone_ext)
            ? item.name
            : `${item.name} ${item.phone_ext}`,
          item.phone ? formatPhone(item.phone) : "",
          item.phone_ext,
        ),
      )}
      {callers.length > 0 && (
        <li className={styles.grp}>По карточке — добавил преподаватель</li>
      )}
      {callers.map((item) =>
        row(
          `caller-${item.number}`,
          item.name,
          `${cardPhone ? formatPhone(cardPhone) : full(item.number)} · номер из карточки`,
          item.number,
        ),
      )}
    </ol>
  );
}
