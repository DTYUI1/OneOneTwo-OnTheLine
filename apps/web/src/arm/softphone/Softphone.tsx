import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import styles from "./Softphone.module.css";
import { EXT_LENGTH, talkDurationMs } from "./machine";
import { useSoftphone } from "./useSoftphone";
import { createVoices, phraseText, type Voices } from "./voices";
import {
  limits,
  panelSize,
  placePanel,
  reserveHeight,
  watchLayout,
} from "./placement";
import { Hint } from "./Hint";
import { phoneHint } from "./phoneHint";
import { phraseFor, shouldAutoCollapse, stripSummary } from "./callView";
import { BrigadePicker } from "./brigade/BrigadePicker";
import { useBrigadeData } from "./brigade/data";
import { useBrigade, type Listening } from "./brigade/useBrigade";
import { awaitsDecision } from "./brigade/logic";
import { CallWindow } from "./CallWindow";
import { useCallWindow } from "./useCallWindow";
import { firstPlace } from "./callGeometry";
import {
  advanceLog,
  quickPhrases,
  youSaid,
  type CallSnapshot,
  type LogLine,
  type QuickPhrase,
  type Replay,
} from "./callLog";
import { setActiveCall } from "../callGuard";
import type { CardState } from "../cardModel";

export interface SoftphoneProps {
  readonly cardId: string;
  /** Запрет новых действий не уничтожает запись, ожидающую повторной загрузки. */
  readonly disabled?: boolean;
  /** Службы, назначенные карточке: их номера показываем первыми. */
  readonly serviceIds?: readonly string[];
  /**
   * ДДС участника в занятии этой карточки. Бригады — только её: сервер сверяет
   * выбор именно с ней, а не со службой из профиля пользователя.
   */
  readonly ownServiceId?: string | null;
  /**
   * Статус карточки: бригаду направляют только после «Принята» (памятка ДДС,
   * стр. 21). Не передан — ограничения нет (стенды без карточки).
   */
  readonly cardState?: CardState;
  /**
   * Подсказки «нулевого уровня» (FR-1.6): `settings_snapshot.hints_level` занятия.
   * Выключены — телефон такой же, как в АРМ на снимках.
   */
  readonly hints?: boolean;
  /** Открытие подсказки — в очередь событий карточки (`hint_open`). */
  readonly onHintOpen?: (hintId: string) => void;
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", ""];
/** Сколько после отбоя видно итог разговора, прежде чем панель свернётся. */
const COLLAPSE_AFTER_MS = 1500;
/** Речь в микрофоне была не раньше этого — диспетчер ещё говорит. */
const YOU_SPEAK_MS = 600;

function Handset() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M5.4 2.5c.5-.5 1.3-.5 1.8 0l2 2c.5.5.5 1.3 0 1.8l-1 1a9.6 9.6 0 0 0 4.5 4.5l1-1c.5-.5 1.3-.5 1.8 0l2 2c.5.5.5 1.3 0 1.8l-1 1c-.7.7-1.8.9-2.7.5A16.4 16.4 0 0 1 3.9 6.2c-.4-.9-.2-2 .5-2.7z"
      />
    </svg>
  );
}

function seconds(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function clockTime(iso: string | null): string {
  if (!iso) return "";
  const moment = new Date(iso);
  return Number.isNaN(moment.getTime())
    ? ""
    : moment.toLocaleTimeString("ru-RU");
}

export function Softphone({
  cardId,
  serviceIds = [],
  disabled = false,
  ownServiceId = null,
  cardState,
  hints = false,
  onHintOpen,
}: SoftphoneProps) {
  // Обучаемый распоряжается бригадами только своей ДДС в этом занятии.
  const [live, setLive] = useState(false);
  const brigadeData = useBrigadeData(cardId, ownServiceId, live);
  // Бригада слушает разговор, который ведёт телефон: хуки связаны через ref,
  // потому что телефону, в свою очередь, нужен выбор бригад.
  const listenRef = useRef<() => Listening>(() => ({
    talkStartedAt: null,
    lastVoiceAt: null,
    brigadeId: null,
  }));
  const brigade = useBrigade({
    cardId,
    data: brigadeData,
    sessionFinished: disabled,
    cardState: cardState ?? null,
    listen: () => listenRef.current(),
  });
  const phone = useSoftphone(cardId, serviceIds, disabled, {
    targets: brigadeData.targets,
    selectedBrigadeIds: brigade.committed,
    busy: brigade.busy,
    decided: !awaitsDecision(cardState ?? null),
    listed: brigade.board.map((row) => row.id),
    ready: brigadeData.training !== null,
    ownServiceId,
  });
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const stripRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const reportsRef = useRef<HTMLOListElement>(null);
  const dialRef = useRef<HTMLElement>(null);
  const [dialReserve, setDialReserve] = useState(0);
  const { model } = phone;
  const active = model.state !== "idle" && model.state !== "ended";
  const talking = model.state === "talking";
  const callee = phone.services.find(
    (service) => service.phone_ext === model.phoneExt,
  );
  const brigadeCallee =
    brigadeData.targets.find(
      (target) =>
        target.brigade_id !== null && target.phone_ext === model.phoneExt,
    ) ?? null;
  const talkingTo = talking ? brigadeCallee : null;
  listenRef.current = () => ({
    talkStartedAt: phone.model.talkStartedAt,
    lastVoiceAt: phone.lastVoiceAt(),
    brigadeId: talkingTo?.brigade_id ?? null,
  });
  // Бригада взяла трубку — её готовый доклад может звучать.
  const lineBrigadeId = talkingTo?.brigade_id ?? null;
  const recheckReport = brigade.recheck;
  useEffect(() => recheckReport(), [lineBrigadeId, recheckReport]);
  // Бригада звонит сама с готовым докладом (CardTraining.incoming, 27.09).
  const incoming = (brigadeData.training?.incoming ?? []).flatMap((call) => {
    const target = brigadeData.targets.find(
      (item) => item.id === call.call_target_id,
    );
    return target ? [{ ...call, target }] : [];
  });
  const calleeName = brigadeCallee?.name ?? callee?.name ?? "службой";
  const current = brigade.current;
  // Доклад бригады на линии — в крупную строку. Прозвучавший доклад уходит из
  // current в принятые, но до конца разговора остаётся в строке: иначе она
  // вернулась бы к «слушайте доклад», хотя доклад уже был.
  const lineReport =
    talkingTo && current && current.delivery.brigade_id === talkingTo.brigade_id
      ? current.delivery.message.text
      : null;
  const [heardReport, setHeardReport] = useState<string | null>(null);
  useEffect(() => {
    if (lineReport) setHeardReport(lineReport);
  }, [lineReport]);
  useEffect(() => {
    if (!active) setHeardReport(null);
  }, [active]);
  const phrase = phraseFor(
    {
      state: model.state,
      inbound: model.inbound,
      withBrigade: brigadeCallee !== null,
      spoken: phone.phrase
        ? phraseText(
            phone.phrase,
            brigadeCallee?.voice_profile ?? callee?.voice_profile ?? null,
          )
        : null,
    },
    lineReport ?? heardReport,
  );
  // Бригада вызывает, линия свободна: итог прошлого разговора не мешает «Ответить».
  const ringingIn = !active && !disabled && incoming.length > 0;
  const hint = phoneHint({
    finished: disabled,
    call: model.state,
    aborted: model.aborted,
    callee: brigadeCallee?.name ?? callee?.name ?? null,
    withBrigade: brigadeCallee !== null,
    refusal: model.refusal,
    refusalAdvice: phone.refusalNote,
    decided: !awaitsDecision(cardState ?? null),
    panelOpen: open,
    brigadesAvailable: brigade.available,
    brigadesSent: brigade.committed.length,
    reportsAccepted: brigade.accepted.length,
    report: !current
      ? "none"
      : current.delivery.message.audio === null
        ? "text"
        : "audio",
  });

  // В разговоре сведения выдаёт сервер по сроку плана — чтение повторяется.
  useEffect(() => setLive(talking), [talking]);

  // Разговор один на АРМ: переход к другому происшествию сначала спрашивает
  // и кладёт трубку (callGuard). Звонок снимается с учёта, когда линия свободна.
  const hangupNow = phone.hangupNow;
  useEffect(() => {
    if (!active) return;
    setActiveCall({ cardId, label: `с ${calleeName}`, hangup: hangupNow });
    return () => setActiveCall(null);
  }, [active, cardId, calleeName, hangupNow]);

  // Таймер разговора идёт только во время разговора — лишних перерисовок нет.
  useEffect(() => {
    if (!talking) return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [talking]);

  // Звонок открывает окно разговора (CallWindow), а не панель: панель набора и
  // бригад остаётся как была — открытой, если по ней звонили, и закрытой, если нет.
  const [callShown, setCallShown] = useState(false);
  const floating = useCallWindow(
    callShown,
    useCallback(() => {
      const strip = stripRef.current;
      const screen = { width: innerWidth, height: innerHeight };
      if (!strip)
        return firstPlace(
          { left: 0, right: screen.width, top: 0, bottom: 0 },
          { top: 0, bottom: screen.height },
          screen,
        );
      const box = strip.getBoundingClientRect();
      const area = limits(strip);
      // Строка служб с формой статуса — внизу карточки: окно её не закрывает.
      const footer = strip.closest("section")?.querySelector("footer");
      const floor = footer?.getBoundingClientRect().top ?? area.bottom;
      return firstPlace(
        box,
        {
          top: area.top,
          bottom:
            floor > box.bottom ? Math.min(area.bottom, floor) : area.bottom,
        },
        screen,
      );
    }, []),
  );
  const expandWindow = floating.expand;
  const callId = model.callId;
  useEffect(() => {
    if (!active || !callId) return;
    setCallShown(true);
    expandWindow();
  }, [active, callId, expandWindow]);

  // Разговор закончен — панель уступает место карточке: доклады остаются под
  // полосой, по ним пишется комментарий. Если нужно действие (запись не ушла,
  // номер не принят), панель остаётся открытой. Постоянные пояснения вроде
  // «нет микрофона» действия не требуют и панель не держат.
  const attention = Boolean(
    phone.dialNote ||
      phone.refusalNote ||
      phone.uploadNote ||
      phone.canRetryUpload,
  );
  // Направленная бригада ещё не доложила — панель тоже держим: следующий звонок
  // ей (shouldAutoCollapse). Доклад учитывается после ответа сервера, поэтому
  // свёртывание ждёт его, пока обучаемый сам не тронул панель.
  const wasActive = useRef(false);
  const collapsePending = useRef(false);
  const sent = brigade.committed.length;
  const reported = brigade.accepted.length;
  useEffect(() => {
    if (wasActive.current && model.state === "ended")
      collapsePending.current = true;
    if (active) collapsePending.current = false;
    wasActive.current = active;
    if (
      !collapsePending.current ||
      !shouldAutoCollapse({
        committed: sent,
        accepted: reported,
        aborted: model.aborted,
        attention,
      })
    )
      return;
    const timer = setTimeout(() => {
      collapsePending.current = false;
      setOpen(false);
    }, COLLAPSE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [active, model.state, model.aborted, attention, sent, reported]);

  // Запись не ушла уже после того, как панель свернулась, — показываем повтор:
  // в окне разговора, если оно открыто, иначе в панели.
  useEffect(() => {
    if (phone.canRetryUpload && !callShown) setOpen(true);
  }, [phone.canRetryUpload, callShown]);

  // Фокус — без прокрутки: иначе браузер подтягивает панель к себе и уносит
  // карточку с экрана, как будто открылась другая страница.
  useEffect(() => {
    if (open) panelRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Панель раскрывается туда, где есть место, и не выходит за пределы карточки:
  // длинный список прокручивается внутри себя, а не растит страницу.
  useLayoutEffect(() => {
    if (!open) return;
    const strip = stripRef.current;
    const panel = panelRef.current;
    if (!strip || !panel) return;
    let applied = "";
    const fit = () => {
      const size = panelSize(
        placePanel(strip.getBoundingClientRect(), limits(strip)),
      );
      setOpenUp(size.height !== null);
      const max = `${size.maxHeight}px`;
      const height = size.height === null ? "" : max;
      if (max + height === applied) return;
      applied = max + height;
      panel.style.maxHeight = max;
      panel.style.height = height;
    };
    fit();
    // Содержимое меняется на ходу: приходит доклад, начинается разговор, под
    // полосой появляется форма статуса. Место пересчитывается по факту, иначе
    // панель уезжает за край карточки под шапку АРМ.
    const sizes = new ResizeObserver(fit);
    sizes.observe(panel);
    const unwatch = watchLayout(strip, fit);
    return () => {
      sizes.disconnect();
      unwatch();
    };
  }, [open]);

  // Набор сменяется разговором и обратно: место под верхний блок держится по
  // самому высокому из них, чтобы бригады под ним не прыгали (reserveHeight).
  useLayoutEffect(() => {
    if (!open) {
      setDialReserve(0);
      return;
    }
    const section = dialRef.current;
    if (!section) return;
    const measure = () =>
      setDialReserve((value) =>
        reserveHeight(value, section.getBoundingClientRect().height),
      );
    measure();
    const sizes = new ResizeObserver(measure);
    sizes.observe(section);
    return () => sizes.disconnect();
  }, [open, active]);

  // Новый доклад виден сразу: прокручивается сам список, не страница.
  useEffect(() => {
    const list = reportsRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [brigade.accepted.length]);

  // Лента окна разговора дописывается по переходам звонка (callLog.advanceLog).
  const [lines, setLines] = useState<readonly LogLine[]>([]);
  const snapshotRef = useRef<CallSnapshot | null>(null);
  /** Звонок, в котором трубку положил диспетчер, — для строки отбоя. */
  const byYouRef = useRef<string | null>(null);
  const voiceProfile =
    brigadeCallee?.voice_profile ?? callee?.voice_profile ?? null;
  const peerName = brigadeCallee?.name ?? callee?.name ?? "Служба";
  // Доклад на линии: только от бригады, с которой идёт разговор.
  const reportOnLine =
    talkingTo && current && current.delivery.brigade_id === talkingTo.brigade_id
      ? current
      : null;
  const snapshot = (): CallSnapshot => ({
    callId: model.callId,
    state: model.state,
    inbound: model.inbound,
    aborted: model.aborted,
    refusal: model.refusal,
    phoneExt: model.phoneExt,
    peer: peerName,
    phrase: phone.phrase
      ? { key: phone.phrase, text: phraseText(phone.phrase, voiceProfile) }
      : null,
    voice: voiceProfile,
    report: reportOnLine
      ? {
          deliveryId: reportOnLine.delivery.delivery_id,
          text: reportOnLine.delivery.message.text,
          url: reportOnLine.delivery.message.audio?.url ?? null,
          durationMs: Math.max(
            1200,
            reportOnLine.delivery.message.audio?.duration_ms ?? 1200,
          ),
        }
      : null,
    byYou: byYouRef.current !== null && byYouRef.current === model.callId,
    duration: seconds(talkDurationMs(model, Date.now())),
    clock: new Date().toLocaleTimeString("ru-RU"),
  });
  const snapshotNow = useRef(snapshot);
  snapshotNow.current = snapshot;
  const reportId = reportOnLine?.delivery.delivery_id ?? null;
  useEffect(() => {
    const next = snapshotNow.current();
    // Прежний снимок берём сейчас: функция обновления выполняется позже.
    const prev = snapshotRef.current;
    snapshotRef.current = next;
    setLines((old) => advanceLog(old, prev, next));
  }, [model.callId, model.state, model.aborted, phone.phrase, reportId]);

  // Повтор реплики — отдельным плеером: живой разговор он не прерывает. Доклад,
  // ещё не засчитанный, повторяет сама бригада — так он будет засчитан.
  const replayRef = useRef<Voices | null>(null);
  useEffect(() => {
    const voices = createVoices();
    replayRef.current = voices;
    return () => {
      voices.cancel();
      replayRef.current = null;
    };
  }, []);
  function replay(item: Replay) {
    const voices = replayRef.current;
    voices?.setMuted(phone.voiceMuted);
    voices?.setVolume(phone.voiceVolume);
    if (item.kind === "phrase") {
      void voices?.play(item.phrase, item.voice);
      return;
    }
    if (
      current &&
      current.delivery.delivery_id === item.deliveryId &&
      current.delivery.message.audio !== null
    ) {
      brigade.replay();
      return;
    }
    void voices?.playAsset(item.url, item.durationMs);
  }

  const textReport =
    reportOnLine !== null && reportOnLine.delivery.message.audio === null;
  const quick = quickPhrases({
    state: model.state,
    reporting: model.phase === "reporting",
    inbound: model.inbound,
    withBrigade: brigadeCallee !== null,
    refusal: model.refusal !== null,
    textReport,
  });
  function say(item: QuickPhrase) {
    setLines((old) => youSaid(old, item.text));
    if (item.id === "ack") brigade.confirmRead();
    if (item.id === "done") {
      byYouRef.current = model.callId;
      phone.finish();
    }
  }
  function hangup() {
    byYouRef.current = model.callId;
    phone.finish();
  }

  const lastVoice = talking ? phone.lastVoiceAt() : null;
  const speaking =
    phone.speaking || (brigade.playing && talkingTo !== null)
      ? ("peer" as const)
      : lastVoice !== null && now - lastVoice < YOU_SPEAK_MS
        ? ("you" as const)
        : null;
  const windowNotes = [
    active && phrase.waiting ? phrase.text : null,
    talking && !brigadeCallee && !model.inbound && model.phase === "reporting"
      ? "Доложите голосом после «Слушаю вас»: после паузы служба подтвердит приём. Без микрофона — «У меня всё». Доклады о выезде передаёт направленная бригада по своему прямому номеру." +
        (cardState === "rejected"
          ? " Карточка сейчас не принята: чтобы направить бригаду, измените статус на «Принята»."
          : "")
      : null,
    talkingTo && brigade.listening
      ? "Бригада слушает вас и доложит, когда вы договорите."
      : null,
    talking && textReport
      ? "Доклад пришёл текстом. Прочитайте его и ответьте «Принял»."
      : null,
    talkingTo ? brigade.note : null,
    phone.phrase ? phone.voiceNote : null,
    phone.refusalNote,
    phone.micNote,
    phone.uploadNote,
  ].filter((text): text is string => Boolean(text));

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !active) {
      setOpen(false);
      return;
    }
    if (active || disabled) return;
    if (/^[0-9]$/.test(event.key)) {
      phone.digit(event.key);
      event.preventDefault();
      return;
    }
    if (event.key === "Backspace") {
      phone.backspace();
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && model.dialed.length === EXT_LENGTH) {
      phone.dial();
      event.preventDefault();
    }
  }

  const summary = stripSummary({
    state: model.state,
    aborted: model.aborted,
    ringingIn,
  });

  return (
    <div className={styles.strip} ref={stripRef}>
      <div className={styles.bar}>
        <button
          type="button"
          className={`${styles.handset} ${active ? styles.lifted : ""}`}
          aria-expanded={open}
          onClick={() => {
            collapsePending.current = false;
            setOpen((value) => !value);
          }}
        >
          <Handset />
          <span className={styles.state}>{summary.label}</span>
        </button>
        {summary.showExt && model.phoneExt && (
          <span>Номер {model.phoneExt}</span>
        )}
        {!active &&
          !disabled &&
          incoming.map((call) => (
            <button
              key={call.call_id}
              type="button"
              className={styles.answer}
              onClick={() => phone.pickup(call.call_id, call.target.phone_ext)}
            >
              Ответить: {call.target.name} вызывает
            </button>
          ))}
        {model.talkStartedAt !== null && (
          <span className={styles.timer}>
            {seconds(talkDurationMs(model, now))}
          </span>
        )}
        {hints && (
          // У правого края полосы «?» не сдвигается, когда меняются подпись
          // трубки, номер и таймер, — его легко найти снова.
          <span className={styles.hintSlot}>
            <Hint
              label="Подсказка: телефон"
              align="right"
              onOpen={() => onHintOpen?.("phone")}
            >
              <p>
                <strong>{hint.now}</strong>
              </p>
              <p>{hint.next}</p>
            </Hint>
          </span>
        )}
      </div>

      {/* Доклады бригад нужны обучаемому тогда, когда он пишет по ним
          комментарий, — то есть при свёрнутой панели: раскрытая закрывает собой
          карточку. Поэтому принятые доклады живут в полосе, а не в панели. */}
      {brigade.accepted.length > 0 && (
        <section className={styles.reports} aria-label="Доклады бригад">
          <p className={styles.reportsTitle}>Доклады бригад</p>
          <ol className={styles.reportList} ref={reportsRef}>
            {brigade.accepted.map((item) => (
              <li key={item.delivery.delivery_id} className={styles.report}>
                <span className={styles.reportTime}>
                  {clockTime(item.presented_at)}
                </span>
                <span>{item.delivery.message.text}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {open && (
        <div
          className={`${styles.panel} ${openUp ? styles.panelUp : ""}`}
          ref={panelRef}
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          {/* Панель закрывает часть карточки — убрать её можно в любой момент,
              и во время разговора: он продолжается, время идёт в полосе. */}
          <div className={styles.panelHead}>
            <button
              type="button"
              className={styles.collapse}
              onClick={() => setOpen(false)}
            >
              Свернуть телефон
            </button>
          </div>
          {/* Разговор идёт в окне разговора (CallWindow); набор на это время
              недоступен, но остаётся на месте — бригады под ним не прыгают. */}
          <section
            className={styles.choose}
            ref={dialRef}
            style={{ minHeight: dialReserve || undefined }}
          >
            <div>
              <h3>Кому звоним</h3>
              <ul className={styles.services}>
                {phone.services.map((service) => (
                  <li key={service.id}>
                    <button
                      type="button"
                      disabled={disabled || active}
                      onClick={() => phone.dial(service.phone_ext)}
                    >
                      <span className={styles.ext}>{service.phone_ext}</span>
                      <span>{service.name}</span>
                      {service.id === ownServiceId ? (
                        <span className={styles.own}>ваша служба</span>
                      ) : (
                        phone.cardServiceIds.includes(service.id) && (
                          <span className={styles.own}>в карточке</span>
                        )
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Или наберите</h3>
              <div className={styles.digits} aria-live="polite">
                {model.state === "idle" ? model.dialed : ""}
              </div>
              <div className={styles.keypad}>
                {KEYS.map((key, index) =>
                  key ? (
                    <button
                      key={key}
                      type="button"
                      disabled={disabled || active}
                      onClick={() => phone.digit(key)}
                    >
                      {key}
                    </button>
                  ) : index === KEYS.length - 1 ? (
                    <button
                      key="backspace"
                      type="button"
                      className={styles.erase}
                      aria-label="Стереть цифру"
                      title="Стереть цифру"
                      disabled={
                        disabled ||
                        model.state !== "idle" ||
                        model.dialed.length === 0
                      }
                      onClick={phone.backspace}
                    >
                      ⌫
                    </button>
                  ) : (
                    <span key={`gap-${index}`} />
                  ),
                )}
              </div>
              {/* После разговора поле набора пустое: прежний номер виден в
                    итоге разговора, новый набирается сразу, без «сброса». */}
              <button
                type="button"
                className={styles.call}
                onClick={() => phone.dial()}
                disabled={
                  disabled ||
                  model.state !== "idle" ||
                  model.dialed.length !== EXT_LENGTH
                }
              >
                Вызов
              </button>
            </div>
          </section>

          <BrigadePicker
            brigade={brigade}
            talkingTo={talkingTo}
            canDial={!disabled && !active}
            onDial={(ext) => phone.dial(ext)}
          />

          {/* Итог звонка и его пояснения — в окне разговора, пока оно открыто;
              здесь — то, что относится к набору, и то, что осталось без окна. */}
          {(phone.dialNote ||
            (!callShown &&
              (phone.refusalNote ||
                phone.micNote ||
                phone.uploadNote ||
                phone.canRetryUpload))) && (
            <div className={styles.notes}>
              {phone.dialNote && (
                <p className={styles.note}>{phone.dialNote}</p>
              )}
              {!callShown && (
                <>
                  {phone.refusalNote && (
                    <p className={styles.note}>{phone.refusalNote}</p>
                  )}
                  {phone.micNote && (
                    <p className={styles.note}>{phone.micNote}</p>
                  )}
                  {phone.uploadNote && (
                    <p className={styles.note}>{phone.uploadNote}</p>
                  )}
                  {phone.canRetryUpload && (
                    <p>
                      <button type="button" onClick={phone.retryUpload}>
                        Отправить запись ещё раз
                      </button>
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {callShown && model.callId && (
        <CallWindow
          floating={floating}
          peer={peerName}
          lines={lines}
          active={active}
          timer={
            model.talkStartedAt !== null
              ? seconds(talkDurationMs(model, now))
              : null
          }
          speaking={speaking}
          notes={windowNotes}
          quick={disabled ? [] : quick}
          onQuick={say}
          onHangup={hangup}
          hangupDisabled={disabled || model.phase === "closing"}
          onReplay={replay}
          muted={phone.voiceMuted}
          onMute={phone.setVoiceMuted}
          volume={phone.voiceVolume}
          onVolume={phone.setVoiceVolume}
          onRetryUpload={phone.canRetryUpload ? phone.retryUpload : undefined}
          onClose={() => setCallShown(false)}
        />
      )}
    </div>
  );
}
