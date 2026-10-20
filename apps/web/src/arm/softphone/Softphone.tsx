// Телефон ДДС открытой карточки (GP-09, макет docs/dds_training_review/phone/index.html):
// контакты, разговор, шаги по частям и ряд ответа — в окне телефона (phone/PhoneWindow).
// Механика звонков — useSoftphone, бригады — useBrigade, доклад голосом — useVoiceReport,
// ответ бригаде голосом — useVoiceReply; здесь только вид.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api";
import { deliverServiceNews } from "./serviceNewsDelivery";
import { talkDurationMs } from "./machine";
import { useSoftphone } from "./useSoftphone";
import {
  createVoices,
  phraseText,
  type Voices,
  type VoiceOutcome,
} from "./voices";
import { Hint } from "./Hint";
import { phoneHint } from "./phoneHint";
import { phraseFor } from "./callView";
import { trainingKey, useBrigadeData } from "./brigade/data";
import { useBrigade, type Listening } from "./brigade/useBrigade";
import { useVoiceReply } from "./brigade/useVoiceReply";
import { useBriefing } from "./brigade/useBriefing";
import { briefingSteps, needsBriefing } from "./brigade/briefing";
import { brigadeAnswer, notUnderstood, phraseKind } from "./brigade/voiceReply";
import {
  asksConfirmation,
  confirmRequestPhrase,
  confirmsReport,
  introPhrase,
  holdsNews,
  resumedSaid,
  resumedSay,
  type ResumedSaid,
} from "./brigade/incoming";
import {
  awaitsDecision,
  lastPlainReport,
  awaitedService,
  serverDials,
  silenceLabel,
  stateLabel,
  UNKNOWN_NUMBER,
} from "./brigade/logic";
import {
  advanceLog,
  HELD_PREFIX,
  restoredLog,
  peerSaid,
  quickPhrases,
  heardChips,
  knownRecordings,
  youSaid,
  youSaidHeard,
  type CallSnapshot,
  type Chip,
  type LogLine,
  type QuickPhrase,
  type Replay,
} from "./callLog";
import {
  choiceOf,
  clarifyFor,
  heardSoFar,
  pickedGap,
  pickedParts,
  requiredParts,
  reportFacts,
  reportSteps,
  type AddressGap,
  type ReportPart,
  type ReportPick,
  type ReportStep,
} from "./report";
import type { PartOption } from "./parts";
import { OFFICIAL, bankAudiosForText } from "./bank";
import {
  askLine,
  personaBook,
  seededPhrase,
  spellLine,
  spellStep,
  twinStreet,
  wantsRepeat,
} from "./official";
import { useSession } from "../../shared/session";
import { serverNow } from "../../shared/ws/client";
import { localServiceDials } from "./brigade/dials";
import { useVoiceReport } from "./useVoiceReport";
import {
  armRecheckMs,
  bankSpeechKey,
  cancelsRecording,
  isPushToTalk,
  peerAlmostDone,
  peerLeftMs,
  pressOutcome,
  releaseOutcome,
} from "./pushToTalk";
import {
  canStartRecording,
  CHECK_NOTE,
  micStatus,
  NOT_HEARD,
} from "./voiceReport";
import { setActiveCall } from "../callGuard";
import { awaitsLine, onPickup, takeLine, takePickup } from "../pickup";
import type { SavedTalk } from "./heldTalk";
import { brigadeWho } from "../phone/lines";
import { STATE_LABELS, type CardState } from "../cardModel";
import { useNow } from "../useNow";
import { contactsFor, dialNumber } from "./contacts";
import {
  ContactList,
  phoneStyles as ps,
  usePhone,
  type BrigadeContact,
} from "../phone/PhoneWindow";
import { useLearned } from "../phone/useLearned";
import { DialPad } from "../phone/DialPad";
import { SoundButton } from "../phone/SoundButton";
import { CallFooter } from "../phone/CallFooter";
import { METER_SEGMENTS, litSegments, peakZone, segmentZone } from "./meter";
import { CALLER_BACKGROUND, callerBook } from "./caller/book";
import { useCallerBackground } from "./caller/background";
import {
  hungUp,
  NO_REPLY_MS,
  reply as callerReply,
  silence as callerSilence,
  type CallerTurn,
} from "./caller/conversation";
import { hear } from "./caller/hearing";
import { callerMemory, callerSaid, rememberCaller } from "./caller/memory";
import {
  callerChoices as questionChoices,
  callerGuidance,
} from "./caller/questions";

/** Настройки занятия карточки: «только голос» (DT-05) и абоненты телефона ДДС (GP-09). */
function useSessionSettings(sessionId: string | null) {
  const session = useQuery({
    queryKey: ["session", sessionId],
    enabled: sessionId !== null,
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/sessions/{id}", {
        params: { path: { id: sessionId ?? "" } },
        signal,
      });
      if (!data) throw new Error(error?.message ?? "Занятие недоступно.");
      return data;
    },
  });
  return session.data?.settings_snapshot ?? null;
}

/** Звонок, в котором ведётся доклад службе; бригаде и во входящем не докладывают. */
function reportCallId(
  model: { callId: string | null; inbound: boolean; refusal: unknown },
  brigadeCallee: unknown,
  liveCaller = false,
): string | null {
  return model.inbound || model.refusal || brigadeCallee || liveCaller
    ? null
    : model.callId;
}

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
   * Выключены — связь такая же, как в макете B.
   */
  readonly hints?: boolean;
  /** Открытие подсказки — в очередь событий карточки (`hint_open`). */
  readonly onHintOpen?: (hintId: string) => void;
  /**
   * Выводить связь в окно телефона. Нет — окно занято разговором другой карточки в окне
   * телефона (HQ-033, `phone/CardLine.tsx`); софтфон смонтирован и вернётся без перезапуска.
   */
  readonly inPhone?: boolean;
  /**
   * Выводить в окно телефона только разговор, без контактов и табло сил: софтфон карточки,
   * которая не открыта (HQ-033) — контакты и табло сил показывает открытая карточка.
   */
  readonly callOnly?: boolean;
  /**
   * Окно телефона занято этим софтфоном: разговор идёт или только что окончен, или трубку
   * вот-вот снимут (просьба ответить ждёт сведений карточки).
   */
  readonly onCallShown?: (shown: boolean) => void;
}

/** Тишина в разговоре с бригадой, после которой она заканчивает связь сама. */
const BRIGADE_QUIET_MS = 6000;
/**
 * Диспетчер подтвердил доклад («Принял») — разговор исчерпан, старший прощается почти сразу
 * (проверка 17.10: шесть секунд тишины после «Принял» звучали как зависание).
 */
const CONFIRMED_QUIET_MS = 1200;
/** Заявитель договорил прощание или «Ничего не слышно» — короткая пауза и отбой (HQ-019). */
const CALLER_LEAVE_MS = 800;

function seconds(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function clockTime(iso: string | null): string {
  if (!iso) return "";
  const moment = new Date(iso);
  return Number.isNaN(moment.getTime())
    ? ""
    : moment.toLocaleTimeString("ru-RU");
}

function canReplay(replay: Replay | undefined): replay is Replay {
  return replay !== undefined && (replay.kind === "phrase" || !!replay.url);
}

/** Пояснение к клавише «пробел» в разговоре (TC-04); прячется после LEARNED_AFTER применений. */
const SPACE_NOTE = "Говорите, удерживая пробел; отпустите — ответ закончен.";

export function Softphone({
  cardId,
  serviceIds = [],
  disabled = false,
  ownServiceId = null,
  cardState,
  hints = false,
  onHintOpen,
  inPhone = true,
  callOnly = false,
  onCallShown,
}: SoftphoneProps) {
  // Обучаемый распоряжается бригадами только своей ДДС в этом занятии.
  const [live, setLive] = useState(false);
  const brigadeData = useBrigadeData(cardId, ownServiceId, live);
  // Бригада слушает разговор, который ведёт телефон: хуки связаны через ref,
  // потому что телефону, в свою очередь, нужен выбор бригад.
  const listenRef = useRef<() => Listening>(() => ({
    talkStartedAt: null,
    brigadeId: null,
  }));
  // Звучит реплика ленты записью банка (очередь ниже): доклад бригады её дослушивает.
  const [bankSpeaking, setBankSpeaking] = useState(false);
  const brigade = useBrigade({
    quiet: bankSpeaking,
    cardId,
    data: brigadeData,
    sessionFinished: disabled,
    cardState: cardState ?? null,
    listen: () => listenRef.current(),
  });
  // Номер доклада бригады (ключ звучащей реплики, HQ-052): между записями доклад всегда
  // смолкает — новый номер по началу звука.
  const brigadeRun = useRef({ playing: false, n: 0 });
  if (brigade.playing && !brigadeRun.current.playing) brigadeRun.current.n += 1;
  brigadeRun.current.playing = brigade.playing;
  // Пояснения окна, которые легко запомнить, — до N верных действий (GP-24, phone/learned).
  const learned = useLearned();
  const learn = learned.done;
  // Табло сил — кому звонить (GP-05): после «Принята» свободная бригада берёт трубку и
  // выезжает по вводной; до решения и занятая — отказывают, как сервер.
  const decided = !awaitsDecision(cardState ?? null);
  const callable = decided
    ? brigade.board.filter((row) => row.state !== "busy").map((row) => row.id)
    : brigade.dispatched;
  // Доклад службе — после её «Слушаю вас»: голосом, запасной путь — варианты ответа.
  // Карточка — из кэша того же запроса, что у реестра АРМ (ArmPage): сведения доклада
  // те, что видит диспетчер. Свой запрос не шлём — лишнее обновление реестра посреди
  // звонка сдвигает вёрстку.
  const cards = useQuery({
    queryKey: ["cards"],
    queryFn: async () => {
      const { data, error } = await api.GET("/cards");
      if (!data) throw new Error(error?.message ?? "Нет связи с сервером.");
      return data;
    },
    enabled: false,
  });
  const card = cards.data?.find((item) => item.id === cardId) ?? null;
  const settings = useSessionSettings(card?.session_id ?? null);
  const voiceOnly = settings?.voice_only === true;
  // Абоненты ДДС от преподавателя (рекомендации 16.10, п. 8); номер вне списка недоступен.
  const contacts = contactsFor(settings, ownServiceId);
  // Живой заявитель (HQ-019, docs/dds_caller.md): номер роли «Заявитель» и книга характера —
  // у абонента занятия (преподаватель) или по умолчанию сценария (CardTraining.caller).
  const callerPlan = brigadeData.training?.caller ?? null;
  const callerContact = contacts.find((item) => item.role === "caller") ?? null;
  const callerCharacter = callerContact?.character ?? callerPlan?.character;
  const callerNumber = callerContact?.number ?? null;
  const callerPlot = callerPlan?.plot ?? null;
  const liveCaller = useMemo(() => {
    if (!callerNumber || !callerPlot) return null;
    const book = callerBook(callerCharacter ?? "calm", callerPlot);
    return book ? { number: callerNumber, book } : null;
  }, [callerNumber, callerPlot, callerCharacter]);
  const phone = useSoftphone(cardId, serviceIds, disabled, {
    targets: brigadeData.targets,
    selectedBrigadeIds: callable,
    busy: brigade.busy,
    decided,
    listed: brigade.board.map((row) => row.id),
    ready: brigadeData.training !== null,
    ownServiceId,
    contacts,
    caller: liveCaller,
  });
  // Часы табло (без связи м:сс) и ожидания входящего вызова.
  const clock = useNow();
  const { realtime } = useSession();
  const [now, setNow] = useState(() => Date.now());
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
  // «Как приняли?» без ответа (TC-01, ниже): бригада ждёт «Принял» в этом звонке — и после
  // удержания, снятая с него, переспрашивает, а не говорит поверх вопроса (`resumedSay`).
  const [confirmedReports, setConfirmedReports] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [asked, setAsked] = useState<{
    readonly cardId: string;
    readonly callId: string;
    readonly deliveryId: string;
    readonly asks: number;
  } | null>(null);
  // Квитанция принадлежит докладу, а не поколению разговора или объекту повтора.
  const askedKey = asked
    ? JSON.stringify([asked.cardId, asked.callId, asked.deliveryId])
    : null;
  const reportConfirmed = askedKey !== null && confirmedReports.has(askedKey);
  const waitingConfirm =
    talking &&
    asked !== null &&
    asked.cardId === cardId &&
    asked.callId === model.callId &&
    !reportConfirmed
      ? asked
      : null;
  // Снятая с удержания бригада (TC-02): «на связи»; ждала ответа на вопрос с вариантами —
  // повторяет его записью из сценария (HQ-058, срок ответа прежний — серверный); ждала
  // «Принял» — переспрашивает. Фраза фиксируется в миг снятия (`resumedSaid`): ответ кнопкой,
  // «Принял» или новый вопрос её в шапке и ленте не меняют.
  const resumedRef = useRef<ResumedSaid | null>(null);
  resumedRef.current = resumedSaid(
    resumedRef.current,
    `${model.callId ?? ""}@${model.talkStartedAt ?? ""}`,
    model.resumed && talking && brigadeCallee !== null
      ? resumedSay(
          ownServiceId,
          waitingConfirm !== null,
          brigade.question(model.callId, talkingTo?.brigade_id),
          Date.now(),
        )
      : null,
  );
  const resumedLine = resumedRef.current;
  // Повторила вопрос — новую реплику придерживает до ответа или срока (HQ-058).
  const holdingNews = () =>
    talking &&
    model.resumed &&
    holdsNews(
      resumedRef.current,
      brigade.question(model.callId, talkingTo?.brigade_id),
      Date.now(),
    );
  // Должностное лицо на линии (TC-03): дежурный службы 101–104 — персонаж своей книги банка,
  // остальные абоненты — общий дежурный.
  // Заявитель на линии (HQ-019): говорит своей книгой, не голосом дежурного.
  const callerOnLine =
    liveCaller !== null && model.phoneExt === liveCaller.number
      ? liveCaller
      : null;
  const officialBook =
    brigadeCallee || callerOnLine
      ? null
      : (personaBook(model.phoneExt) ?? OFFICIAL);
  listenRef.current = () => ({
    talkStartedAt: phone.model.talkStartedAt,
    brigadeId: talkingTo?.brigade_id ?? null,
    hold: holdingNews(),
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
  const calleeLabel = brigadeCallee
    ? `с бригадой ${brigadeCallee.phone_ext}`
    : `с ${callee?.name ?? "службой"}`;
  const current = brigade.current;
  // Доклад бригады на линии. Прозвучавший доклад уходит из current в принятые, но до
  // конца разговора остаётся в строке ожидания: иначе она вернулась бы к «слушайте
  // доклад», хотя доклад уже был.
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
  // Что бригада повторит на «доложите обстановку»: последний доклад, а не свой вопрос и не
  // ответ на действие диспетчера, в том числе из прошлого разговора (`lastPlainReport`).
  // Доклад о выезде (`departure`, и повтор адреса «Как поняли? … выезжаем!» в нём) в пути —
  // не доклад о ходе работ (проверка связности 17.10): до следующего — «едем, по прибытии
  // доложу».
  const plainReport =
    lineReport !== null &&
    current !== null &&
    !current.delivery.reply_options?.length &&
    current.delivery.answer !== true &&
    current.delivery.departure !== true
      ? lineReport
      : null;
  const repeatReport =
    plainReport ??
    (talkingTo?.brigade_id
      ? lastPlainReport(brigade.accepted, talkingTo.brigade_id)
      : null);
  // Служба, которую бригада просила (HQ-055): «отправил», «уже едет» без названия службы —
  // о ней, бригада отвечает «Понял, ждём скорую», если сервер засчитал бы весть сейчас
  // (после звонка в службу и до её приезда). О службе, которую не просили, — только после
  // набора её номера (GP-28): звонки из выдачи и свои, ещё не дошедшие до неё. Часы —
  // серверные (поля выдачи — его время), в момент фразы.
  const awaitedNow = () =>
    talkingTo?.brigade_id
      ? awaitedService(
          brigade.accepted,
          talkingTo.brigade_id,
          serverNow(realtime.clockOffsetMs),
          [
            ...serverDials(brigadeData.training?.service_calls),
            ...localServiceDials(cardId),
          ],
        )
      : null;
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
        : // Сняли с удержания (TC-02): старший снова на связи.
          (resumedLine?.text ?? null),
    },
    lineReport ?? heardReport,
  );
  const hint = phoneHint({
    finished: disabled,
    call: model.state,
    aborted: model.aborted,
    callee: brigadeCallee?.name ?? callee?.name ?? null,
    withBrigade: brigadeCallee !== null,
    refusal: model.refusal,
    refusalAdvice: phone.refusalNote,
    decided: !awaitsDecision(cardState ?? null),
    // Связь в колонке всегда на виду — раскрывать нечего.
    panelOpen: true,
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

  // Ответ из колонки связи на вызов этой карточки (DT-20): трубку снимает софтфон.
  // Так же — снятие с удержания и перезвон по пропущенному вызову (TC-02): когда сведения
  // о бригадах загружены (иначе бригада на линии не узнается) и линия свободна.
  const pickupNow = phone.pickup;
  const resumeNow = phone.resume;
  const dialRef = useRef<(ext: string) => void>(() => {});
  const incomingRef = useRef(incoming);
  incomingRef.current = incoming;
  const lineReady =
    !disabled &&
    !active &&
    brigadeData.training !== null &&
    brigadeData.targets.length > 0;
  // Разговор, снятый с удержания (вкладки 17.10): лента и части доклада до удержания.
  const restoreRef = useRef<{ callId: string; saved: SavedTalk } | null>(null);
  const restoredVoiceRef = useRef<{
    callId: string;
    earlier: readonly string[];
  } | null>(null);
  useEffect(() => {
    const take = () => {
      const find = (id: string) =>
        incomingRef.current.find((item) => item.call_id === id);
      const callId = takePickup(cardId, (id) => find(id) !== undefined);
      const call = callId ? find(callId) : undefined;
      if (call) pickupNow(call.call_id, call.target.phone_ext);
      const line = takeLine(cardId, () => lineReady);
      if (line?.kind === "resume") {
        const start = () => {
          const saved = line.saved ?? null;
          if (
            !resumeNow(
              line.callId,
              line.phoneExt,
              saved?.report ?? null,
              saved?.inbound,
            )
          )
            return false;
          restoreRef.current = saved ? { callId: line.callId, saved } : null;
          restoredVoiceRef.current = saved
            ? { callId: line.callId, earlier: saved.earlier ?? [] }
            : null;
          if (saved) {
            setSaid({
              callId: line.callId,
              parts: saved.said,
              gap: saved.gap ?? null,
            });
            heardRef.current = { callId: line.callId, parts: saved.said };
          }
          return true;
        };
        if (line.accept) line.accept(start);
        else start();
      }
      if (line?.kind === "dial") dialRef.current(line.phoneExt);
    };
    take();
    return onPickup(take);
  }, [cardId, pickupNow, resumeNow, incoming.length, lineReady]);

  // Разговор один на АРМ: переход к другому происшествию сначала спрашивает
  // и кладёт трубку (callGuard). Звонок снимается с учёта, когда линия свободна.
  const hangupNow = phone.hangupNow;
  // На удержание (TC-02, вкладки 17.10) — любой идущий разговор: с бригадой, со службой,
  // с абонентом ДДС. Лента и доклад службе сохраняются (`talkRef`) и вернутся при снятии.
  // Гудки и прощание собеседника удерживать незачем.
  const holdNow = phone.holdNow;
  const holdable = talking && model.phase === "reporting" && !disabled;
  const cardNumber = card?.source.number ?? "";
  const lineCallId = model.callId;
  const lineExt = model.phoneExt;
  // Подпись вкладки линии: старший бригады с номером или название службы.
  const lineWho = brigadeCallee
    ? brigadeWho(brigadeCallee.phone_ext)
    : (callee?.name ?? `Номер ${model.phoneExt ?? ""}`.trim());
  const talkRef = useRef<() => SavedTalk>(() => ({
    lines: [],
    report: null,
    said: [],
  }));
  useEffect(() => {
    if (!active) return;
    setActiveCall({
      cardId,
      label: calleeLabel,
      hangup: hangupNow,
      ...(holdable && lineCallId && lineExt
        ? {
            hold: () => {
              const saved = talkRef.current();
              return holdNow()
                ? {
                    cardId,
                    cardNumber,
                    callId: lineCallId,
                    phoneExt: lineExt,
                    kind: brigadeCallee ? "brigade" : "service",
                    who: lineWho,
                    saved,
                  }
                : null;
            },
          }
        : {}),
    });
    return () => setActiveCall(null);
  }, [
    active,
    cardId,
    calleeLabel,
    hangupNow,
    holdable,
    holdNow,
    cardNumber,
    lineCallId,
    lineExt,
    lineWho,
    brigadeCallee,
  ]);

  // Таймер разговора идёт только во время разговора — лишних перерисовок нет.
  useEffect(() => {
    if (!talking) return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [talking]);

  // Разговор стоит в колонке, пока линия занята, и после отбоя — с итогом, пока
  // его не закроют («Закрыть») или не начнётся новый звонок.
  const [callShown, setCallShown] = useState(false);
  const callId = model.callId;
  useEffect(() => {
    if (active && callId) setCallShown(true);
  }, [active, callId]);

  // Лента разговора дописывается по переходам звонка (callLog.advanceLog).
  const [lines, setLines] = useState<readonly LogLine[]>([]);
  const snapshotRef = useRef<CallSnapshot | null>(null);
  /** Звонок, в котором трубку положил диспетчер, — для строки отбоя. */
  const byYouRef = useRef<string | null>(null);
  const voiceProfile =
    brigadeCallee?.voice_profile ?? callee?.voice_profile ?? null;
  const peerName = brigadeCallee?.name ?? callee?.name ?? "Служба";
  // Доклад на линии: только от бригады, с которой идёт разговор.
  const reportOnLine =
    talkingTo &&
    current &&
    current.delivery.brigade_id === talkingTo.brigade_id &&
    !holdingNews()
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
      ? phone.spoken?.callId === model.callId &&
        phone.spoken.phrase === phone.phrase
        ? { key: phone.phrase, text: phone.spoken.text, silent: true }
        : { key: phone.phrase, text: phraseText(phone.phrase, voiceProfile) }
      : null,
    voice: voiceProfile,
    // Входящий вызов бригады: старший сначала называет себя (TC-01).
    intro:
      model.inbound && brigadeCallee !== null
        ? introPhrase(ownServiceId)
        : null,
    // Снят с удержания (TC-02): старший снова на связи; служба отвечает репликой «Да, слушаю».
    resumed: model.resumed ? (resumedLine?.text ?? "") : null,
    held: model.held,
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
    // Снят с удержания (вкладки 17.10): лента продолжает сказанное до удержания.
    const restore =
      next.callId !== prev?.callId && restoreRef.current?.callId === next.callId
        ? restoreRef.current.saved
        : null;
    if (restore) restoreRef.current = null;
    setLines((old) =>
      restore
        ? restoredLog(restore.lines, advanceLog(old, prev, next))
        : advanceLog(old, prev, next),
    );
  }, [model.callId, model.state, model.aborted, phone.phrase, reportId]);

  // Новая реплика — на виду: прокручивается лента, не колонка.
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [lines]);

  // Повтор реплики — отдельным плеером: живой разговор он не прерывает. Доклад,
  // ещё не засчитанный, повторяет сама бригада — так он будет засчитан.
  const replayRef = useRef<Voices | null>(null);
  const bankVoicesRef = useRef<Voices | null>(null);
  // Ключ звучащей реплики ленты: следующая — новая реплика, хоть лента и не смолкает (HQ-052).
  const [bankKey, setBankKey] = useState(() => bankSpeechKey(0, null));
  const bankLineRef = useRef(0);
  // Строки ленты, продолжающие реплику: «Как приняли?» — ключ доклада, после которого оно
  // прозвучало (запись, начатая в конце доклада, на нём не гаснет).
  const lineKeysRef = useRef(new Map<string, string>());
  // Сколько записей реплики ленты ещё впереди после звучащей: конец ленты известен, только
  // когда звучит последняя (HQ-052).
  const bankRestRef = useRef(0);
  useEffect(() => {
    const replay = createVoices();
    const bank = createVoices();
    replayRef.current = replay;
    bankVoicesRef.current = bank;
    return () => {
      replayRef.current = null;
      bankVoicesRef.current = null;
      replay.cancel();
      bank.cancel();
    };
  }, []);
  // Реплики, которые попали в ленту только текстом (переспрос службы, ответ бригады, «Как
  // приняли?», вопросы дежурного подряд, «Повторяю» и доклад, GP-28), звучат записями банка по
  // очереди — из книги того, кто говорит. Доклады и реплики со своим звуком (`replay`,
  // `phrase-…`) озвучивает их собственный путь. Пока запись звучит, собеседник «говорит»:
  // микрофон закрыт и бригада не прощается.
  const voicedRef = useRef<{ callId: string | null; ids: Set<string> }>({
    callId: null,
    ids: new Set(),
  });
  const queueRef = useRef<
    { readonly urls: string[]; readonly key: string | null }[]
  >([]);
  const bankRunRef = useRef(0);
  useEffect(() => {
    bankRunRef.current += 1;
    queueRef.current = [];
    bankRestRef.current = 0;
    setBankSpeaking(false);
    setRepeating(false);
    return () => {
      // Отбой, удержание и смена линии отменяют весь остаток, а не одну запись.
      bankRunRef.current += 1;
      queueRef.current = [];
      bankVoicesRef.current?.cancel();
      replayRef.current?.cancel();
    };
  }, [model.callId, talking, disabled]);
  // Один абонент — один голос (проверка 17.10): реплика звучит только из книги того, кто
  // говорит; чужой голос вместо него не подставляется.
  const speakerBooks = callerOnLine
    ? [callerOnLine.book.id]
    : officialBook
      ? [officialBook]
      : [ownServiceId ?? "101"];
  const speakerBooksRef = useRef(speakerBooks);
  speakerBooksRef.current = speakerBooks;
  const soundRef = useRef({ muted: false, volume: 1 });
  soundRef.current = { muted: phone.voiceMuted, volume: phone.voiceVolume };
  useEffect(() => {
    const voiced = voicedRef.current;
    if (voiced.callId !== model.callId) {
      // Новый разговор: прежние строки ленты уже прозвучали или были до открытия окна.
      voicedRef.current = {
        callId: model.callId,
        ids: new Set(lines.map((line) => line.id)),
      };
      queueRef.current = [];
      lineKeysRef.current.clear();
      return;
    }
    if (!talking || disabled) return;
    // Доклады бригады в ленте — со своей записью: «Повторяю» и доклад звучат подряд.
    const known = knownRecordings(lines, resumedRef.current);
    for (const line of lines) {
      if (voiced.ids.has(line.id)) continue;
      voiced.ids.add(line.id);
      if (
        line.who !== "peer" ||
        line.report ||
        line.replay ||
        line.id.startsWith("phrase-") ||
        // Сказанное до удержания уже прозвучало.
        line.id.startsWith(HELD_PREFIX)
      )
        continue;
      const urls = bankAudiosForText(speakerBooksRef.current, line.text, known);
      if (urls) {
        queueRef.current.push({
          urls: [...urls],
          key: lineKeysRef.current.get(line.id) ?? null,
        });
      }
    }
    if (!queueRef.current.length || bankSpeaking) return;
    const voices = bankVoicesRef.current;
    if (!voices) return;
    const callId = model.callId;
    const run = bankRunRef.current;
    const currentRun = () =>
      run === bankRunRef.current && voicedRef.current.callId === callId;
    setBankSpeaking(true);
    void (async () => {
      while (queueRef.current.length && currentRun()) {
        const item = queueRef.current.shift();
        const urls = item?.urls ?? [];
        bankLineRef.current += 1;
        setBankKey(bankSpeechKey(bankLineRef.current, item?.key ?? null));
        for (const [index, url] of urls.entries()) {
          bankRestRef.current = urls.length - 1 - index;
          voices.setMuted(soundRef.current.muted);
          voices.setVolume(soundRef.current.volume);
          const result = await voices.playAsset(url, 0);
          // cancel() завершает Promise: после await нельзя продолжать старую очередь.
          if (!currentRun()) return;
          if (result.outcome === "cancelled") {
            queueRef.current = [];
            bankRestRef.current = 0;
            setBankSpeaking(false);
            return;
          }
        }
      }
      if (currentRun()) {
        bankRestRef.current = 0;
        setBankSpeaking(false);
      }
    })();
  }, [lines, model.callId, bankSpeaking, talking, disabled]);
  /** Повтор реплики; кончается, когда она отзвучала. */
  async function replay(item: Replay): Promise<VoiceOutcome | null> {
    const voices = replayRef.current;
    voices?.setMuted(phone.voiceMuted);
    voices?.setVolume(phone.voiceVolume);
    if (item.kind === "phrase") {
      return (await voices?.play(item.phrase, item.voice))?.outcome ?? null;
    }
    if (
      current &&
      current.delivery.delivery_id === item.deliveryId &&
      current.delivery.message.audio !== null
    ) {
      brigade.replay();
      // Это отдельная попытка предъявления, не завершённый повтор ленты.
      return null;
    }
    return (
      (await voices?.playAsset(item.url, item.durationMs))?.outcome ?? null
    );
  }
  const textReport =
    reportOnLine !== null && reportOnLine.delivery.message.audio === null;
  // Прозвучавший доклад бригады на линии: его можно попросить повторить.
  const lastReport = [...lines]
    .reverse()
    .find((line) => line.replay?.kind === "report")?.replay;
  function hangup() {
    byYouRef.current = model.callId;
    phone.finish();
  }

  const reportCall = reportCallId(model, brigadeCallee, callerOnLine !== null);
  // Дежурный начал «Слушаю» — микрофон доклада уже готов: нажатие во время реплики ждёт
  // её конца, а в последнюю секунду запись начинается сразу (HQ-052). Остальное окно
  // (варианты, подсказки) — после реплики (`reporting`).
  const reportOpen =
    talking &&
    model.phase === "reporting" &&
    reportCall !== null &&
    phone.phrase === "listen";
  const reporting = reportOpen && !phone.speaking;
  const sentNames = brigade.board
    .filter((row) => brigade.committed.includes(row.id))
    .map((row) => row.name);
  // «Кто вы» в вариантах доклада — ФИО обучаемого и его служба (памятка ДДС, с. 32).
  const { user } = useSession();
  const ownService = phone.services.find(
    (service) => service.id === ownServiceId,
  );
  // Что прозвучало в докладе этого звонка — для «Что прозвучало: n из N» после отбоя.
  // `gap` — чего не хватило в адресе и поводе на последний доклад: по нему служба
  // переспрашивает, и по нему же доклад по частям начинается с того, о чём спросили.
  const [said, setSaid] = useState<{
    callId: string | null;
    parts: readonly ReportPart[];
    gap: AddressGap | null;
  }>({ callId: null, parts: [], gap: null });
  function heard(parts: readonly ReportPart[], gap: AddressGap | null) {
    const callNow = model.callId;
    setSaid((old) => ({
      callId: callNow,
      parts: [
        ...new Set([...(old.callId === callNow ? old.parts : []), ...parts]),
      ],
      gap,
    }));
  }
  const saidGap = said.callId === model.callId ? said.gap : null;
  // Доклад тот же, как бы он ни был сказан: неполный — служба уточняет то, чего не
  // хватило, и разговор идёт дальше; полный — служба подтверждает приём.
  function addReport(
    text: string,
    question: string | null,
    heardParts?: readonly ReportPart[],
  ) {
    setLines((old) => {
      const said = heardParts
        ? youSaidHeard(old, text, heardParts, required)
        : youSaid(old, text);
      return question === null ? said : peerSaid(said, question);
    });
  }
  // Последняя реплика собеседника: «Повторите» отдаёт её же (TC-03).
  const lastPeer =
    [...lines].reverse().find((line) => line.who === "peer")?.text ?? null;
  // Вопросы дежурного в звонке (TC-03): формулировки перебираются, одна и та же подряд не
  // звучит. Персонаж службы спрашивает своими фразами, общий дежурный — прежними.
  const asksRef = useRef<{ callId: string | null; count: number }>({
    callId: null,
    count: 0,
  });
  // Карточку называют только в звонке в 112 (памятка ДДС, с. 32): у других её не спрашивают.
  const required = requiredParts(model.phoneExt);
  function askFor(
    parts: Iterable<ReportPart>,
    gap: AddressGap | null,
  ): string | null {
    if (!officialBook) return clarifyFor(parts, gap, required);
    const before =
      asksRef.current.callId === model.callId ? asksRef.current.count : 0;
    const question = askLine(
      officialBook,
      parts,
      before,
      lastPeer,
      gap,
      required,
    );
    if (question !== null)
      asksRef.current = { callId: model.callId, count: before + 1 };
    return question;
  }
  // Похожая улица (TC-03): на полный доклад дежурный один раз просит повторить улицу по
  // буквам; разговор закрывает ответ на эту просьбу. Нет фразы в книге — не просит.
  const spellAskedRef = useRef<string | null>(null);
  const [spellFor, setSpellFor] = useState<string | null>(null);
  const spellPending =
    talking && spellFor !== null && spellFor === model.callId;
  const cardStreet = card?.source.address.street ?? "";
  const twin = twinStreet(cardStreet);
  function spellQuestion(serverTwin: string | null = null): string | null {
    const callNow = model.callId;
    if (!officialBook || !callNow || spellAskedRef.current === callNow)
      return null;
    const line = (serverTwin ?? twin) ? spellLine(officialBook) : null;
    if (!line) return null;
    spellAskedRef.current = callNow;
    setSpellFor(callNow);
    return line;
  }
  function spelledBack(text: string, chips?: readonly Chip[]) {
    setLines((old) => youSaid(old, text, chips));
    setSpellFor(null);
    phone.accept();
  }
  // Части доклада, прозвучавшие голосом в текущем звонке.
  const heardRef = useRef<{
    callId: string | null;
    parts: readonly ReportPart[];
  }>({ callId: null, parts: [] });
  // Что сохранить, если разговор поставят на удержание (вкладки 17.10).
  talkRef.current = () => ({
    inbound: model.inbound,
    lines,
    report: phone.reportLog(),
    earlier: voice.earlier(),
    said: said.callId === model.callId ? said.parts : [],
    gap: saidGap,
  });
  const voice = useVoiceReport({
    callId: reportCall,
    conversationVersion: phone.conversationVersion,
    saved: restoredVoiceRef.current,
    listening: reportOpen,
    voiceOnly,
    onHeard: (text, _choice, parts, loudness, spellStreet, addressGap) => {
      // «Повторите» — дежурный повторяет свою последнюю реплику; это не доклад (TC-03).
      if (wantsRepeat(text)) {
        setLines((old) =>
          lastPeer
            ? peerSaid(youSaid(old, text), lastPeer)
            : youSaid(old, text),
        );
        return;
      }
      // Ответ на «повторите улицу по буквам» — дежурный принимает доклад.
      if (spellPending) {
        spelledBack(text);
        return;
      }
      // Доклад складывается за звонок: на «Представьтесь» отвечают одной частью, и
      // названное раньше не теряется — сервер ищет части во всех фразах звонка, а
      // услышанное раньше остаётся ✓. В ленту и в отбой — части доклада на эту фразу.
      const before = heardRef.current;
      const sum = heardSoFar(
        before.callId === model.callId ? before.parts : [],
        parts,
      );
      heardRef.current = { callId: model.callId, parts: sum };
      const choice = choiceOf(sum, required);
      const question = askFor(sum, addressGap);
      const spelling = question === null ? spellQuestion(spellStreet) : null;
      addReport(text, question ?? spelling, sum);
      heard(sum, addressGap);
      phone.report(choice, "voice", sum, loudness, spelling === null);
    },
    onUnclear: () => {
      // «Не расслышал» — тем же голосом, что и весь разговор (персонаж 101–104 или общий).
      setLines((old) =>
        peerSaid(
          old,
          officialBook && model.callId
            ? seededPhrase(officialBook, "not_understood", model.callId).text
            : NOT_HEARD,
        ),
      );
      phone.voiceFailed();
    },
  });
  // Доклад по частям (GP-06): шаги частей, ещё не прозвучавших в этом звонке, и части,
  // выбранные в текущем круге. Последний шаг — доклад: служба переспросит неверное или
  // недостающее, и круг идёт заново по этим частям. Адрес прозвучал, а повода не хватило
  // (`saidGap` — `reason`) — круг без шага «Адрес»: служба спросила «что случилось».
  const [picks, setPicks] = useState<{
    callId: string | null;
    items: readonly ReportPick[];
  }>({ callId: null, items: [] });
  const roundPicks = picks.callId === model.callId ? picks.items : [];
  const partSteps =
    reporting && voice.choices && card && model.callId && !disabled
      ? reportSteps(
          reportFacts({ ...card, state: cardState ?? card.state }, sentNames, {
            trainee: user.full_name,
            service: ownService?.name,
          }),
          model.callId,
          said.callId === model.callId ? said.parts : [],
          required,
          saidGap,
        )
      : [];
  const reportStep = partSteps[roundPicks.length] ?? null;
  function sayPart(step: ReportStep, option: PartOption) {
    const items = [...roundPicks, { key: step.key, correct: option.correct }];
    const last = items.length >= partSteps.length;
    setLines((old) =>
      youSaid(old, option.text, [{ label: step.label, ok: option.correct }]),
    );
    setPicks({ callId: model.callId, items: last ? [] : items });
    if (!last) return;
    // Круг доклада по частям без ошибок — пояснение шага выучивается.
    if (items.every((item) => item.correct)) learn("report");
    const parts = pickedParts(items);
    const before = heardRef.current;
    const sum = heardSoFar(
      before.callId === model.callId ? before.parts : [],
      parts,
    );
    heardRef.current = { callId: model.callId, parts: sum };
    const gap = pickedGap(items, saidGap === "reason");
    const question = askFor(sum, gap);
    const spelling = question === null ? spellQuestion() : null;
    const asked = question ?? spelling;
    if (asked !== null) setLines((old) => peerSaid(old, asked));
    heard(sum, gap);
    phone.report(choiceOf(sum, required), "option", sum, undefined, !spelling);
  }
  // Улица по буквам без микрофона (TC-03): улица карточки и похожая.
  const spellChoice =
    spellPending && voice.choices && twin && model.callId && !disabled
      ? spellStep(cardStreet, twin, model.callId)
      : null;
  // Голосом сейчас не доложить — кнопки записи нет («только голос» без микрофона
  // объясняет voice.note).
  const voiceControl = reportOpen && !disabled && card && !voice.problem;

  // Вводная бригаде (GP-05): без неё бригада не выезжает. Голосом или по частям.
  const briefingNeeded =
    talkingTo !== null &&
    !disabled &&
    needsBriefing({
      brigadeId: talkingTo.brigade_id,
      decided,
      refusal: model.refusal !== null,
      dispatched: brigade.dispatched,
    });
  const briefing = useBriefing({
    callId: talkingTo ? model.callId : null,
    brigadeId: talkingTo?.brigade_id ?? null,
    service: ownServiceId,
    needed: briefingNeeded,
    steps: card ? briefingSteps(card.source, model.callId ?? "") : [],
    onSaid: (text) => setLines((old) => youSaid(old, text)),
    onAnswer: (text) => {
      if (text) setLines((old) => peerSaid(old, text));
    },
    onIncomplete: brigade.say,
    onDispatch: (...args) => {
      // Бригада выехала по вводной — пояснение вводной выучивается.
      learn("briefing");
      brigade.brief(...args);
    },
  });

  // Входящий доклад (TC-01): прозвучал — старший спрашивает «Как приняли?» и ждёт «Принял».
  // Озвученный доклад — после конца звука (предъявлен), текстовый — сразу.
  const askedFor = useRef(new Set<string>());
  const onLine = useRef<{
    readonly callId: string;
    readonly deliveryId: string;
    readonly audio: boolean;
  } | null>(null);
  const reportAudio = reportOnLine?.delivery.message.audio != null;
  // «Как приняли?» — только после доклада: вопрос бригады (варианты ответа) и её ответ на
  // реакцию диспетчера («Понял, спасибо, дальше сами») подтверждения не ждут (проверка 17.10).
  const reportAsks =
    reportOnLine !== null &&
    asksConfirmation({
      inbound: model.inbound,
      question: (reportOnLine.delivery.reply_options?.length ?? 0) > 0,
      answer: reportOnLine.delivery.answer === true,
    });
  const currentId = current?.delivery.delivery_id ?? null;
  useEffect(() => {
    if (!talking || !model.inbound || !model.callId) return;
    if (reportId && reportAsks)
      onLine.current = {
        callId: model.callId,
        deliveryId: reportId,
        audio: reportAudio,
      };
    const line = onLine.current;
    if (!line || line.callId !== model.callId) return;
    if (askedFor.current.has(line.deliveryId)) return;
    if (line.audio && (brigade.playing || currentId === line.deliveryId))
      return;
    askedFor.current.add(line.deliveryId);
    const callNow = model.callId;
    // Озвученный доклад звучал последним докладом бригады: «Как приняли?» — его продолжение.
    const reportKey = line.audio ? `brigade:${brigadeRun.current.n}` : null;
    setLines((old) => {
      const next = peerSaid(old, confirmRequestPhrase(ownServiceId));
      if (reportKey)
        lineKeysRef.current.set(next[next.length - 1].id, reportKey);
      return next;
    });
    setAsked((old) => ({
      cardId,
      callId: callNow,
      deliveryId: line.deliveryId,
      asks: (old?.callId === callNow ? old.asks : 0) + 1,
    }));
  }, [
    talking,
    model.inbound,
    model.callId,
    reportId,
    reportAsks,
    reportAudio,
    brigade.playing,
    currentId,
    ownServiceId,
    cardId,
  ]);
  /** «Принял» на «Как приняли?» — в журнал карточки (`report_confirmed`). */
  function confirmReport(text: string) {
    if (!waitingConfirm) return;
    const waiting = waitingConfirm;
    brigade.confirm(waiting.callId, waiting.deliveryId, text, () => {
      // Удержание и повтор не отменяют принятие; чужой звонок или доклад не затрагиваются.
      const key = JSON.stringify([
        waiting.cardId,
        waiting.callId,
        waiting.deliveryId,
      ]);
      setConfirmedReports((current) => new Set(current).add(key));
    });
  }
  // Разговор, в котором диспетчер последним подтвердил доклад: прощание без долгой паузы.
  const confirmedOn =
    asked?.cardId === cardId && reportConfirmed ? asked.callId : null;
  // Повтор доклада по просьбе: пока звучит, бригада не переспрашивает; потом — снова вопрос.
  const [repeating, setRepeating] = useState(false);

  // Ответ бригаде (DT-16): голосом, запасной путь — варианты ответа реплики, как у доклада.
  // Вопрос, срок которого истёк на удержании, бригада не повторила — его кнопок нет (HQ-058).
  const open =
    talkingTo && !disabled
      ? brigade.question(model.callId, talkingTo?.brigade_id)
      : null;
  const question =
    open && open.deliveryId !== resumedLine?.dropped ? open : null;
  // Бригаде можно сказать и без её вопроса (DT-19): «выезжайте», «доложите обстановку».
  const replyVoice = useVoiceReply({
    callId: talkingTo && !disabled ? model.callId : null,
    question,
    free: true,
    voiceOnly,
    onHeard: (text, optionKey, loudness, failures) => {
      if (!model.callId || !question) return;
      setLines((old) => youSaid(old, text));
      brigade.reply(model.callId, question.deliveryId, optionKey, {
        mode: "voice",
        text,
        loudness,
        voiceFailures: failures,
      });
    },
    onUnclear: () =>
      setLines((old) => peerSaid(old, notUnderstood(ownServiceId))),
    onSaid: (text, _loudness, worldAnswers) => {
      // «Принял» голосом на «Как приняли?» — подтверждение приёма, бригаде отвечать нечего.
      if (waitingConfirm && confirmsReport(text)) {
        setLines((old) => youSaid(old, text));
        if (textReport) brigade.confirmRead();
        confirmReport(text);
        // «Принял, пожарные выехали»: бригада узнаёт, что служба едет, и отвечает (GP-28).
        const awaited = awaitedNow();
        if (phraseKind(text, awaited) === "service_called" && model.callId) {
          brigade.say(model.callId, text);
          setLines((old) =>
            peerSaid(old, brigadeAnswer(text, null, ownServiceId, awaited)),
          );
        }
        return;
      }
      if (briefingNeeded) {
        setLines((old) => youSaid(old, text));
        briefing.say(text);
        return;
      }
      // Сказанное бригаде — в журнал карточки, разбор покажет «передано бригаде: …» (GP-11).
      if (model.callId) brigade.say(model.callId, text);
      // Поправку повтора адреса (HQ-024) бригада подтверждает репликой ветки мира — одна
      // реплика на фразу, о поправке, даже если во фразе ещё «доложите».
      if (worldAnswers) {
        setLines((old) => youSaid(old, text));
        return;
      }
      const awaited = awaitedNow();
      setLines((old) =>
        peerSaid(
          youSaid(old, text),
          brigadeAnswer(text, repeatReport, ownServiceId, awaited),
        ),
      );
    },
  });
  const replyVoiceControl =
    talkingTo !== null && !disabled && !replyVoice.problem;

  // Разговор с живым заявителем (HQ-019, docs/dds_caller.md): диспетчер спрашивает голосом
  // или вариантом, заявитель отвечает репликами книги своего характера (caller/), каждая —
  // отметка caller_said в журнал карточки. Помнит сказанное за весь разговор с карточкой.
  const callerTalking =
    talking &&
    callerOnLine !== null &&
    model.phase === "reporting" &&
    !disabled;
  /** Звонок, в котором заявитель договорит и положит трубку (прощание или тишина). */
  const callerHangupRef = useRef<string | null>(null);
  /** Звонок, который кончился прощанием: на перезвон — обычное «Алло», а не «опять вы?». */
  const callerFarewellRef = useRef<string | null>(null);
  const callerAddress = {
    house: card?.source.address.house ?? "",
    flat: card?.source.address.apartment ?? "",
  };
  function callerSays(turn: CallerTurn) {
    const callNow = model.callId;
    if (!callNow) return;
    rememberCaller(cardId, turn.memory);
    for (const line of turn.lines) {
      setLines((old) => peerSaid(old, line.text));
      void realtime.enqueue(cardId, callerSaid(callNow, line.id));
    }
    if (turn.hangup) callerHangupRef.current = callNow;
  }
  function askCaller(text: string) {
    if (!callerOnLine || !model.callId) return;
    setLines((old) => youSaid(old, text));
    const turn = callerReply(
      callerOnLine.book,
      callerMemory(cardId),
      hear(text, callerOnLine.book.story, card?.source.address.street ?? ""),
      callerAddress,
    );
    // Заявитель кладёт трубку после реплики диспетчера только на прощание.
    if (turn.hangup) callerFarewellRef.current = model.callId;
    callerSays(turn);
  }
  const callerVoice = useVoiceReply({
    callId: callerTalking ? model.callId : null,
    question: null,
    free: true,
    voiceOnly,
    onHeard: () => undefined,
    // Фраза не распознана — заявитель не расслышал.
    onUnclear: () => {
      if (callerOnLine)
        callerSays(
          callerReply(
            callerOnLine.book,
            callerMemory(cardId),
            hear("", callerOnLine.book.story),
            callerAddress,
          ),
        );
    },
    onSaid: (text) => askCaller(text),
  });
  const callerVoiceControl = callerTalking && !callerVoice.problem;
  // Ответ голосом: доклад службе, разговор с бригадой или с заявителем. Части — запасной путь.
  const mic = voiceControl
    ? voice
    : replyVoiceControl
      ? replyVoice
      : callerVoiceControl
        ? callerVoice
        : null;
  // Говорит собеседник — служба, бригада или звук доклада: микрофон закрыт (полудуплекс, TC-04).
  const speaking = phone.speaking || brigade.playing || bankSpeaking;
  // Какие реплики звучат: у каждой свой ключ — так видно, что началась новая, даже без паузы
  // (HQ-052).
  const peerNow = [
    phone.speaking ? `phone:${phone.speechId}` : null,
    brigade.playing ? `brigade:${brigadeRun.current.n}` : null,
    bankSpeaking ? bankKey : null,
  ].filter((id): id is string => id !== null);
  const peerKey = peerNow.join(" ");
  /** Сколько ещё говорить собеседнику, мс; `null` — конец неизвестен (HQ-052). */
  function speechLeft(): number | null {
    const parts: (number | null)[] = [];
    if (phone.speaking) parts.push(phone.speechLeftMs());
    if (brigade.playing) parts.push(brigade.playLeftMs());
    if (bankSpeaking)
      parts.push(
        queueRef.current.length || bankRestRef.current
          ? null
          : (bankVoicesRef.current?.remainingMs() ?? null),
      );
    return peerLeftMs(parts);
  }

  // Весть — свободная фраза, а не выдуманный вариант сценария: brigade_reply без
  // reply_options сервер отвергнет. Один ответ сообщает обо всех открытых просьбах
  // этой бригады (то же правило сервера, что для «уже вызвал» голосом).
  const queryClient = useQueryClient();
  const sentServiceNews = useRef(new Set<string>());
  const pendingServiceNews = useRef(new Set<string>());
  const newsDisposers = useRef(new Set<() => void>());
  const newsMounted = useRef(true);
  const [, refreshNews] = useState(0);
  useEffect(() => {
    newsMounted.current = true;
    const disposers = newsDisposers.current;
    return () => {
      newsMounted.current = false;
      for (const dispose of disposers) dispose();
      disposers.clear();
    };
  }, []);
  function serviceNewsNow(includePending = false): {
    key: string;
    deliveries: readonly string[];
  } | null {
    if (
      voiceOnly ||
      disabled ||
      !talking ||
      !talkingTo?.brigade_id ||
      briefingNeeded
    )
      return null;
    const brigadeId = talkingTo.brigade_id;
    const at = serverNow(realtime.clockOffsetMs);
    // Локальный набор ещё может быть отвергнут сервером. Ручная весть доступна
    // только по service_called_at из выдачи; голосовой путь не меняем.
    // Кэш обновляется раньше React commit: старая видимая кнопка не должна
    // отправить весть по уже изменённой выдаче.
    const latest = queryClient.getQueryData<
      NonNullable<typeof brigadeData.training>
    >(trainingKey(cardId));
    const keys = (latest?.messages ?? [])
      .filter(
        (item) =>
          item.state === "presented" &&
          item.delivery.brigade_id === brigadeId &&
          (item.delivery.service_news !== undefined
            ? !!item.delivery.service_news &&
              !item.delivery.service_news.told_at &&
              at >= Date.parse(item.delivery.service_news.called_at) &&
              (!item.delivery.service_news.by ||
                at <= Date.parse(item.delivery.service_news.by))
            : awaitedService([item], brigadeId, at).open),
      )
      .map((item) =>
        JSON.stringify([cardId, brigadeId, item.delivery.delivery_id]),
      )
      .filter(
        (key) =>
          !sentServiceNews.current.has(key) &&
          (includePending || !pendingServiceNews.current.has(key)),
      );
    return keys.length
      ? {
          key: JSON.stringify([model.callId, brigadeId, keys]),
          deliveries: keys,
        }
      : null;
  }
  const serviceNews = serviceNewsNow()?.key ?? null;
  const newsConversation = phone.conversationVersion();
  const newsCurrent = useRef<() => boolean>(() => false);
  newsCurrent.current = () =>
    newsMounted.current &&
    !disabled &&
    talking &&
    !!talkingTo?.brigade_id &&
    !briefingNeeded;

  const quick = quickPhrases({
    state: model.state,
    withBrigade: brigadeCallee !== null,
    refusal: model.refusal !== null,
    textReport,
    heardReport:
      lastReport?.kind === "report" &&
      !!lastReport.url &&
      !brigade.playing &&
      !repeating,
    confirm: waitingConfirm !== null && !repeating,
    question: replyVoice.choices ? question : null,
    briefing: replyVoice.choices ? briefing.step : null,
    serviceNews: replyVoice.choices ? serviceNews : null,
    peerLine: reporting && officialBook ? lastPeer : null,
  });
  function say(item: QuickPhrase) {
    if (item.id === "service-news") {
      // Срок и поколение проверяются в момент нажатия: часы, hold/resume и выдача
      // могли измениться после показа кнопки. Путь синхронный, STT здесь нет.
      const news = serviceNewsNow();
      if (
        !model.callId ||
        phone.conversationVersion() !== newsConversation ||
        !news ||
        item.serviceNews !== news.key
      )
        return;
      for (const key of news.deliveries) pendingServiceNews.current.add(key);
      refreshNews((value) => value + 1);
      const awaited = awaitedNow();
      const current = () =>
        newsCurrent.current() &&
        phone.conversationVersion() === newsConversation;
      const release = () => {
        for (const key of news.deliveries)
          pendingServiceNews.current.delete(key);
        if (newsMounted.current) refreshNews((value) => value + 1);
      };
      const dispose = deliverServiceNews(
        realtime,
        cardId,
        {
          client_event_id: crypto.randomUUID(),
          client_ts: new Date().toISOString(),
          type: "brigade_said",
          payload: { call_id: model.callId, text: item.text },
        },
        {
          identity: JSON.stringify([...news.deliveries].sort()),
          // Без долговечного envelope это первая попытка по уже проверенной проекции.
          // После remount helper игнорирует кэш и перечитывает журнал сервера.
          cachedConfirmed: () => false,
          current: () => current() && serviceNewsNow(true)?.key === news.key,
          rejected: () => {
            release();
            brigadeData.refresh();
          },
          confirmed: async () => {
            const latest = await brigadeData.reload();
            if (!latest) throw new Error("Сведения о вести недоступны.");
            return news.deliveries.every((key) => {
              const deliveryId = (JSON.parse(key) as string[])[2];
              const window = latest.messages.find(
                (message) => message.delivery.delivery_id === deliveryId,
              )?.delivery.service_news;
              return (
                !!window?.told_at &&
                Date.parse(window.told_at) >= Date.parse(window.called_at) &&
                (!window.by ||
                  Date.parse(window.told_at) <= Date.parse(window.by))
              );
            });
          },
          accepted: () => {
            for (const key of news.deliveries) sentServiceNews.current.add(key);
            release();
            if (!current()) return;
            setLines((old) =>
              peerSaid(
                youSaid(old, item.text),
                awaited?.open
                  ? brigadeAnswer(
                      item.text,
                      repeatReport,
                      ownServiceId,
                      awaited,
                    )
                  : "Понял, ждём.",
              ),
            );
            brigadeData.refresh();
          },
        },
      );
      newsDisposers.current.add(dispose);
      return;
    }
    // Часть вводной: строку «Вы сказали» пишет useBriefing.
    if (item.id === "brief") {
      briefing.choose(item.text);
      return;
    }
    setLines((old) => youSaid(old, item.text));
    if (item.id === "again" && lastPeer) {
      const again = lastPeer;
      setLines((old) => peerSaid(old, again));
    }
    if (item.id === "ack") {
      // Текстовый доклад засчитывается этим «Принял»; озвученный уже засчитан концом звука.
      if (textReport) brigade.confirmRead();
      confirmReport(item.text);
    }
    if (item.id === "repeat" && lastReport) {
      const again = waitingConfirm;
      const run = bankRunRef.current;
      if (again) setRepeating(true);
      void replay(lastReport).then((outcome) => {
        if (!again || run !== bankRunRef.current) return;
        setRepeating(false);
        if (outcome !== "played") return;
        // Повторил доклад — снова спрашивает, как приняли.
        setLines((old) => peerSaid(old, confirmRequestPhrase(ownServiceId)));
        setAsked((old) =>
          old?.callId === again.callId ? { ...old, asks: old.asks + 1 } : old,
        );
      });
    }
    if (item.reply && model.callId)
      brigade.reply(model.callId, item.reply.deliveryId, item.reply.optionKey, {
        mode: "option",
        voiceFailures: replyVoice.failures,
      });
  }

  // Сказать бригаде нечего — она сама заканчивает разговор, как в прототипах A и B:
  // следующий доклад придёт отдельным вызовом, а не в линию, на которой сидит
  // диспетчер (пользователь 12.10: «всегда с отрядом на одной линии сидишь»).
  const brigadeQuiet =
    talking &&
    talkingTo !== null &&
    !disabled &&
    reportOnLine === null &&
    !brigade.playing &&
    !bankSpeaking &&
    !brigade.listening &&
    question === null &&
    // Бригада ждёт вводной и сама не кладёт трубку.
    !briefingNeeded &&
    // Спросила «Как приняли?» — ждёт ответа (TC-01).
    waitingConfirm === null &&
    !repeating &&
    replyVoice.status === "idle";
  // finish — новая функция на каждой отрисовке, а часы разговора отрисовывают
  // каждые 250 мс: через ref таймер тишины не сбрасывается.
  const lastLine = lines[lines.length - 1];
  const quietMs =
    confirmedOn !== null &&
    confirmedOn === model.callId &&
    lastLine?.who === "you"
      ? CONFIRMED_QUIET_MS
      : BRIGADE_QUIET_MS;
  const finishRef = useRef(phone.finish);
  finishRef.current = phone.finish;
  const quietConversation = phone.conversationVersion();
  useEffect(() => {
    if (!brigadeQuiet) return;
    const timer = setTimeout(() => {
      if (phone.conversationVersion() !== quietConversation) return;
      // Бригада кладёт трубку молча: «Понял, работаем. Конец связи» после доклада — лишняя
      // фраза (проверка 17.10).
      finishRef.current();
    }, quietMs);
    return () => clearTimeout(timer);
  }, [
    brigadeQuiet,
    lines.length,
    quietMs,
    model.callId,
    quietConversation,
    phone.conversationVersion,
  ]);

  // «Диспетчер, слышите меня?» после «Как приняли?» не звучит (проверка 17.10: «сыпет фразы,
  // какие не надо»): молчание диспетчера и так видно в разборе.

  const notes = [
    // До ответа ожидание показывает ряд ответа («Соединение…», «Ждём ответа…»).
    talking && phrase.waiting ? phrase.text : null,
    reporting && cardState === "rejected"
      ? "Карточка сейчас не принята: чтобы направить бригаду, измените статус на «Принята»."
      : null,
    reporting ? voice.note : null,
    // Распознанное неуверенно показано в поле правки (TC-04); подсказку выучивают.
    mic === voice && voice.draft !== null && learned.shown("check")
      ? CHECK_NOTE
      : null,
    // Пробел вместо кнопки «Говорить» (TC-04): пояснение прячется, когда им уже пользуются.
    mic !== null &&
    micStatus(mic.status, speaking) === null &&
    !(mic === voice && voice.draft !== null) &&
    learned.shown("space")
      ? SPACE_NOTE
      : null,
    // Текущий шаг виден и в полосе шагов: пояснение — пока не выучено.
    reportStep && learned.shown("report")
      ? `Доклад по частям, шаг «${reportStep.label}».`
      : null,
    question || briefingNeeded ? replyVoice.note : null,
    // Заявитель: громкость и нераспознанная фраза; без микрофона варианты уже на экране.
    callerTalking && !callerVoice.problem ? callerVoice.note : null,
    briefingNeeded && learned.shown("briefing")
      ? briefing.step && replyVoice.choices
        ? `Вводная по частям, шаг «${briefing.step.label}».`
        : "Дайте бригаде вводную: адрес и что случилось."
      : null,
    // Без карточки в кэше доклад не собрать: говорим об этом, а не молчим.
    reporting && !card
      ? "Сведения карточки не загружены, доклада по частям нет. Положите трубку и обновите страницу."
      : null,
    talkingTo && brigade.listening
      ? "Бригада на связи и сейчас доложит."
      : null,
    talking && textReport
      ? "Доклад пришёл текстом. Прочитайте его и ответьте «Принял»."
      : null,
    talkingTo ? brigade.note : null,
    phone.phrase ? phone.voiceNote : null,
    phone.refusalNote,
  ].filter((text): text is string => Boolean(text));

  // Итог звонка службе: что из порядка памятки прозвучало (макет B, «Что прозвучало»).
  const result =
    !active && said.callId === model.callId && said.parts.length > 0
      ? said.parts.filter((part) => required.includes(part))
      : null;

  const canDial = !disabled && !active;
  // Почему набрать нельзя — для подсказки на неактивных кнопках (TC-08).
  const dialBlocked = disabled
    ? "Занятие не идёт — позвонить нельзя"
    : active
      ? "Сначала закончите текущий разговор"
      : undefined;
  const contactRows: BrigadeContact[] = brigade.board.map((row) => {
    const silence =
      row.state === "here"
        ? silenceLabel(
            row.lastContactAt,
            serverNow(realtime.clockOffsetMs, clock),
          )
        : null;
    return {
      id: row.id,
      name: row.name,
      ext: row.ext,
      stateText: stateLabel(row) + (silence ? ` · ${silence}` : ""),
      state: row.state,
    };
  });
  // Службы справочника — без своей ДДС и её абонентов (они идут своей группой).
  const directory = phone.services.filter(
    (service) => service.id !== ownServiceId,
  );
  const ownExt =
    phone.services.find((service) => service.id === ownServiceId)?.phone_ext ??
    null;
  const cardPhones = card
    ? [
        card.source.phone_aon,
        card.source.phone_provided,
        card.source.phone_scene,
      ]
    : [];
  const [typed, setTyped] = useState("");
  const [typedNote, setTypedNote] = useState<string | null>(null);
  function dialTyped() {
    const number = dialNumber(
      typed,
      contacts,
      cardPhones.filter((item): item is string => Boolean(item)),
      phone.services,
      ownExt,
    );
    if (number === null) {
      setTypedNote(UNKNOWN_NUMBER);
      return;
    }
    setTypedNote(null);
    setTyped("");
    dialOut(number);
  }
  // Звонок из контактов или номером — пояснение «Выберите, кому позвонить» выучивается.
  function dialOut(ext: string) {
    learn("dial");
    phone.dial(ext);
  }
  dialRef.current = dialOut;

  const partsOffered =
    !voiceOnly &&
    (mic === voice
      ? !voice.choices
      : mic === callerVoice
        ? !callerVoice.choices
        : mic === replyVoice &&
          (question !== null || briefingNeeded || serviceNews !== null) &&
          !replyVoice.choices);
  const openParts = () => {
    setPartsCall(model.callId);
    mic?.openChoices();
  };
  // Выбранный способ держится до конца разговора: «По частям» раскрывает части и дальше.
  const [partsCall, setPartsCall] = useState<string | null>(null);
  const keepParts = partsCall !== null && partsCall === model.callId;
  const openVoice = voice.openChoices;
  const openReply = replyVoice.openChoices;
  const openCaller = callerVoice.openChoices;
  useEffect(() => {
    if (!keepParts) return;
    if (callerTalking && !callerVoice.choices) openCaller();
    if (reporting && !voice.choices) openVoice();
    if (
      (question !== null || briefingNeeded || serviceNews !== null) &&
      !replyVoice.choices
    )
      openReply();
  }, [
    keepParts,
    reporting,
    voice.choices,
    question,
    briefingNeeded,
    serviceNews,
    replyVoice.choices,
    openVoice,
    openReply,
    callerTalking,
    callerVoice.choices,
    openCaller,
  ]);
  // Пробел — push-to-talk (TC-04): пока пробел зажат, идёт запись, отпустил — ответ
  // закончен (проверка 17.10: два нажатия вместо удержания мешали). В поле ввода и на кнопке
  // пробел остаётся им. Полудуплекс смягчён (HQ-052): запись можно начать за секунду до конца
  // реплики собеседника, а нажатие раньше «взводится» — запись начнётся сама, если пробел
  // ещё зажат (кнопка «Говорить» — до повторного щелчка). Возвращает истину, если нажатие
  // принято окном.
  const spaceHeld = useRef(false);
  // Нажатие во время реплики ждёт её конца: пробелом (держится) или кнопкой (до щелчка).
  // Ссылка ставится прямо при нажатии: отпускание в том же тике, до перерисовки, должно
  // видеть взведение, иначе его приняли бы за конец записи.
  const [armed, setArmedState] = useState<"space" | "button" | null>(null);
  const armedRef = useRef(armed);
  function setArmed(value: "space" | "button" | null) {
    armedRef.current = value;
    setArmedState(value);
  }
  // Реплики, звучавшие, когда запись начали: на них отвечают, их остаток запись не гасит.
  const startedOn = useRef<readonly string[]>([]);
  const talkReady = mic !== null && talking && !disabled && callShown;
  /** Начать запись; `space` — её закончит отпущенный пробел. */
  function startTalk(by: "space" | "button") {
    if (!mic) return;
    startedOn.current = peerNow;
    stopOnRecording.current = false;
    setArmed(null);
    mic.toggle();
    if (by === "space") {
      spaceHeld.current = true;
      learn("space");
    }
  }
  /** Нажатие «говорить» пробелом или кнопкой при свободном микрофоне. */
  function press(by: "space" | "button") {
    if (!mic) return;
    const outcome = pressOutcome({
      idle: mic.status === "idle",
      speaking,
      leftMs: speaking ? speechLeft() : 0,
    });
    if (outcome === "start") startTalk(by);
    else if (outcome === "arm") {
      setArmed(by);
      if (by === "space") spaceHeld.current = true;
    }
  }
  const spaceRef = useRef<{ down: () => boolean; up: () => void }>({
    down: () => false,
    up: () => undefined,
  });
  spaceRef.current = {
    down: () => {
      if (!mic || !talkReady) return false;
      // Запись начата кнопкой — пробел её заканчивает.
      if (mic.status === "recording") {
        mic.toggle();
        return true;
      }
      press("space");
      return true;
    },
    up: () => {
      if (!spaceHeld.current) return;
      spaceHeld.current = false;
      const outcome = releaseOutcome({
        armed: armedRef.current,
        recording: mic?.status === "recording",
      });
      // Отпустил до конца реплики — запись не начинается.
      if (outcome === "disarm") setArmed(null);
      else if (outcome === "stop") mic?.toggle();
      // Микрофон ещё включается — запись закончится, как только начнётся.
      else stopOnRecording.current = true;
    },
  };
  const stopOnRecording = useRef(false);
  const heldMic = mic;
  useEffect(() => {
    if (heldMic?.status !== "recording" || !stopOnRecording.current) return;
    stopOnRecording.current = false;
    heldMic.toggle();
  }, [heldMic, heldMic?.status]);
  // Взведённое нажатие: запись — как только собеседник договаривает (последняя секунда
  // реплики или её конец). Разговор кончился или микрофон занят — нажатие снимается.
  const [armTick, setArmTick] = useState(0);
  const armStage = mic?.status ?? null;
  const armRef = useRef({ speechLeft, startTalk });
  armRef.current = { speechLeft, startTalk };
  useEffect(() => {
    if (!armed) return;
    if (!talkReady || armStage !== "idle") {
      setArmed(null);
      if (armed === "space") spaceHeld.current = false;
      return;
    }
    const left = speaking ? armRef.current.speechLeft() : 0;
    if (peerAlmostDone(speaking, left)) {
      armRef.current.startTalk(armed);
      return;
    }
    const timer = setTimeout(
      () => setArmTick((value) => value + 1),
      armRecheckMs(left),
    );
    return () => clearTimeout(timer);
  }, [armed, talkReady, armStage, speaking, armTick]);
  useEffect(() => {
    function onDown(event: KeyboardEvent) {
      // Автоповтор зажатого пробела не листает страницу, пока идёт или ждёт запись.
      if (event.code === "Space" && event.repeat && spaceHeld.current) {
        event.preventDefault();
        return;
      }
      if (!isPushToTalk(event, event.target)) return;
      if (spaceRef.current.down()) event.preventDefault();
    }
    function onUp(event: KeyboardEvent) {
      if (event.code !== "Space" || !spaceHeld.current) return;
      event.preventDefault();
      spaceRef.current.up();
    }
    // Окно потеряло фокус с зажатым пробелом — отпускания не будет, ответ заканчивается.
    const onBlur = () => spaceRef.current.up();
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  const micStage = mic?.status ?? null;
  const cancelMic = mic?.cancel;
  const wasRecording = useRef(false);
  useEffect(() => {
    if (micStage !== "recording") {
      // Запись кончилась — следующая начнётся заново (пока микрофон включается — ещё нет).
      if (wasRecording.current) startedOn.current = [];
      wasRecording.current = false;
      return;
    }
    wasRecording.current = true;
    if (
      cancelsRecording({
        recording: true,
        peer: peerKey ? peerKey.split(" ") : [],
        startedOn: startedOn.current,
      })
    )
      cancelMic?.();
  }, [peerKey, micStage, cancelMic]);
  // Время записи — с начала текущей фразы.
  const recording = mic?.status === "recording";
  const [recStart, setRecStart] = useState<number | null>(null);
  useEffect(() => setRecStart(recording ? Date.now() : null), [recording]);
  const recNow = useNow(250);
  // Пик громкости фразы: записана в норме — подписи шкалы выучиваются.
  const peakRef = useRef<number | null>(null);
  const micLevel = mic?.level ?? 0;
  useEffect(() => {
    if (recording) peakRef.current = Math.max(peakRef.current ?? 0, micLevel);
  }, [recording, micLevel]);
  useEffect(() => {
    if (recording) return;
    const peak = peakRef.current;
    peakRef.current = null;
    if (peak !== null && peakZone(peak) === "ok") learn("meter");
  }, [recording, learn]);

  // Шаги по частям: доклад службе или вводная бригаде.
  const allBriefing =
    card && model.callId ? briefingSteps(card.source, model.callId) : [];
  const stepBar = reportStep
    ? partSteps.map((step) => step.label)
    : briefing.step && replyVoice.choices
      ? allBriefing.map((step) => step.label)
      : [];
  const stepAt = reportStep
    ? roundPicks.length
    : briefing.step
      ? allBriefing.findIndex((step) => step.key === briefing.step?.key)
      : -1;
  const partsMode =
    reportStep !== null ||
    spellChoice !== null ||
    quick.some((item) => item.id === "brief");

  // Заявитель ждёт ответа (HQ-019, docs/dds_caller.md, раздел 3): 8 с тишины диспетчера
  // после его реплики — «Алло, вы тут?», вторая пауза подряд — ещё раз, третья — отбой. Пока
  // диспетчер говорит или распознаётся фраза, тишины нет; на удержании заявитель молчит.
  const callerQuiet =
    callerTalking &&
    !speaking &&
    callerVoice.status === "idle" &&
    armed === null &&
    callerHangupRef.current !== model.callId;
  const callerSaysRef = useRef(callerSays);
  callerSaysRef.current = callerSays;
  const callerBookOnLine = callerOnLine?.book ?? null;
  useEffect(() => {
    if (!callerQuiet || !callerBookOnLine) return;
    const timer = setTimeout(() => {
      callerSaysRef.current(
        callerSilence(callerBookOnLine, callerMemory(cardId)),
      );
    }, NO_REPLY_MS);
    return () => clearTimeout(timer);
  }, [callerQuiet, callerBookOnLine, cardId, lines.length]);
  // Заявитель договорил прощание или «Ничего не слышно» — кладёт трубку сам.
  const callerLeaves =
    talking && callerHangupRef.current === model.callId && !speaking;
  useEffect(() => {
    if (!callerLeaves) return;
    const timer = setTimeout(() => finishRef.current(), CALLER_LEAVE_MS);
    return () => clearTimeout(timer);
  }, [callerLeaves, lines.length]);
  // Звонок заявителю кончился: оборвался без прощания — на перезвон «это опять вы?».
  const callerEndedRef = useRef<string | null>(null);
  const callerCallEnded =
    callerOnLine !== null &&
    model.state === "ended" &&
    !model.held &&
    model.callId !== null &&
    callerEndedRef.current !== model.callId;
  useEffect(() => {
    if (!callerCallEnded || !model.callId) return;
    callerEndedRef.current = model.callId;
    rememberCaller(
      cardId,
      hungUp(callerMemory(cardId), callerFarewellRef.current === model.callId),
    );
  }, [callerCallEnded, model.callId, cardId]);
  // Фон под звонком: заявитель вышел из дома — улица (раздел 4).
  useCallerBackground(
    CALLER_BACKGROUND,
    talking && callerOnLine !== null && !model.held,
    phone.voiceMuted,
    phone.voiceVolume,
  );
  const callerChoices =
    callerTalking && callerVoice.choices && card && liveCaller
      ? questionChoices({
          book: liveCaller.book,
          serviceName: ownService?.name ?? ownServiceId ?? "",
          street: card.source.address.street,
          house: card.source.address.house,
          flat: card.source.address.apartment,
          seed: model.callId ?? "",
          memory: callerMemory(cardId),
        })
      : [];

  // Значок на панели: таймер разговора при свёрнутом или закрытом окне.
  const phoneApi = usePhone();
  const setPhoneCall = phoneApi?.setCall;
  const showPhone = phoneApi?.show;
  useEffect(() => {
    if (!setPhoneCall || !active) return;
    setPhoneCall({
      talkStartedAt: model.talkStartedAt,
      holdable,
      // Вкладка идущего разговора (вкладки линий 17.10).
      line: model.callId
        ? {
            callId: model.callId,
            cardId,
            cardNumber,
            who: lineWho,
            kind: brigadeCallee ? "brigade" : "service",
          }
        : null,
    });
    return () => setPhoneCall(null);
  }, [
    setPhoneCall,
    active,
    model.talkStartedAt,
    holdable,
    model.callId,
    cardId,
    cardNumber,
    lineWho,
    brigadeCallee,
  ]);
  // Новый разговор (в том числе ответ на вызов) — окно телефона на виду.
  useEffect(() => {
    if (active && callId) showPhone?.();
  }, [active, callId, showPhone]);

  const inCall = callShown && model.callId !== null;
  // Окно телефона занято этой линией и пока софтфон ждёт сведений, чтобы снять трубку: иначе
  // в нём контакты другой (открытой) карточки и набор пошёл бы по ней.
  const lineTaken = inCall || awaitsLine(cardId, clock);
  useEffect(() => onCallShown?.(lineTaken), [lineTaken, onCallShown]);
  useEffect(() => () => onCallShown?.(false), [onCallShown]);
  const elapsed =
    model.talkStartedAt !== null ? seconds(talkDurationMs(model, now)) : "";
  // Длинное имя сокращается, но таймер остаётся целым и при переносе шапки узкого окна.
  const title = !inCall
    ? `Телефон${ownService ? ` · ${ownService.name}` : ""}`
    : active && !talking
      ? `${peerName} · вызов…`
      : active
        ? `Разговор: ${peerName} ·`
        : model.held
          ? `${peerName} · на удержании`
          : model.aborted
            ? `${peerName} · вызов сброшен`
            : `${peerName} · разговор окончен ·`;

  const head = (
    <>
      <h2 data-call-state={inCall ? model.state : undefined} title={title}>
        <span className={ps.peer}>{title}</span>
        {inCall && (talking || !active) && !model.aborted && !model.held && (
          <span className={ps.clock}>{elapsed}</span>
        )}
      </h2>
      {inCall && talking && (
        <span
          className={ps.tone}
          data-speaking={speaking}
          title="Голос собеседника"
        >
          <i />
          <i />
          <i />
          <i />
          <span>{speaking ? "говорит" : "слушает"}</span>
        </span>
      )}
      {inCall && active && (
        <span className={ps.talkTools} data-help="phone-call">
          <SoundButton
            muted={phone.voiceMuted}
            onToggle={phone.setVoiceMuted}
          />
        </span>
      )}
    </>
  );

  const hintBlock = hints && (
    <Hint label="Подсказка: телефон" onOpen={() => onHintOpen?.("phone")}>
      <p>
        <strong>{hint.now}</strong>
      </p>
      <p>{hint.next}</p>
    </Hint>
  );

  // Набор кнопками (HQ-023): клавиатура и поле «Номер» — левая треть, контакты — правые две.
  const contactsView = (
    <DialPad
      value={typed}
      onChange={(value) => {
        setTyped(value);
        setTypedNote(null);
        phone.clearDialNote();
      }}
      onSubmit={dialTyped}
      disabled={!canDial}
      blocked={dialBlocked}
      status={
        typedNote ??
        phone.dialNote ??
        (learned.shown("dial") ? "Выберите, кому позвонить." : null)
      }
    >
      <div className={ps.talkLog}>
        {hintBlock}
        <ContactList
          brigades={brigade.available ? contactRows : []}
          persons={contacts}
          services={directory}
          ownExt={ownExt}
          cardPhone={cardPhones.find(Boolean) ?? null}
          onDial={canDial ? dialOut : null}
        />
        {/* Бригаду направляют после решения реагировать (памятка ДДС, стр. 21). */}
        {brigade.block && <p className={ps.talkStart}>{brigade.block}</p>}
        {/* Бригада действует по решению диспетчера: следующий доклад — после статуса. */}
        {brigade.committed.length > 0 && !current && brigade.awaiting && (
          <p className={ps.talkStart} role="status">
            Бригада ждёт вашего решения: отметьте в карточке статус «
            {STATE_LABELS[brigade.awaiting]}» — после этого она доложит дальше.
          </p>
        )}
        {phone.refusalNote && (
          <p className={ps.talkStart}>{phone.refusalNote}</p>
        )}
        {/* Принятые доклады остаются на виду: по ним пишется комментарий карточки. */}
        {brigade.accepted.length > 0 && (
          <section aria-label="Доклады бригад" data-help="phone-reports">
            <div className={ps.grp}>Доклады бригад</div>
            <ol className={ps.contacts}>
              {brigade.accepted.map((item) => (
                <li key={item.delivery.delivery_id}>
                  <b>{clockTime(item.presented_at)}</b>{" "}
                  {item.delivery.message.text}
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </DialPad>
  );

  const meter = (level: number) => {
    const on = litSegments(level);
    return (
      <span
        className={ps.meter}
        title="Громкость: слева тихо, зелёным отмечена норма, справа громко"
      >
        <span
          className={ps.meterBar}
          role="meter"
          aria-label="Громкость микрофона"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
        >
          {Array.from({ length: METER_SEGMENTS }, (_, index) => (
            <i
              key={index}
              data-zone={segmentZone(index) === "ok"}
              data-on={index < on}
              data-hi={segmentZone(index) === "loud"}
            />
          ))}
        </span>
        {/* Подписи шкалы — пока громкость не освоена (GP-24), потом — при наведении. */}
        {learned.shown("meter") && (
          <span className={ps.meterScale}>
            <span>тихо</span>
            <span>норма</span>
            <span>громко</span>
          </span>
        )}
      </span>
    );
  };

  const partsButton = (off: boolean) => (
    <button
      type="button"
      className={ps.partsBtn}
      data-parts={mic === voice ? "report" : "reply"}
      aria-pressed={keepParts}
      disabled={off}
      title={off ? "Сейчас по частям отвечать нельзя" : undefined}
      onClick={openParts}
    >
      По частям
    </button>
  );

  let answer: ReactNode;
  if (!active)
    answer = (
      <>
        <button
          type="button"
          className={ps.question}
          disabled={disabled || !model.phoneExt}
          title={
            disabled
              ? "Занятие не идёт — позвонить нельзя"
              : !model.phoneExt
                ? "Номера нет в справочнике"
                : undefined
          }
          onClick={() => model.phoneExt && phone.dial(model.phoneExt)}
        >
          Перезвонить
        </button>
        <button
          type="button"
          className={ps.question}
          onClick={() => setCallShown(false)}
        >
          К контактам
        </button>
      </>
    );
  else if (!talking)
    answer = (
      <span className={ps.status}>
        <span className={ps.spin} />
        {phrase.text}…
      </span>
    );
  else if (mic?.status === "recording")
    answer = (
      <>
        <button
          type="button"
          className={ps.talkBtn}
          data-rec="true"
          aria-keyshortcuts="Space"
          title="Закончить ответ — пробел"
          onClick={mic.toggle}
        >
          Закончить ответ
        </button>
        {meter(mic.level)}
        <span className={ps.status} role="status">
          {micStatus(
            "recording",
            false,
            false,
            recStart === null ? 0 : recNow - recStart,
          )}
        </span>
      </>
    );
  else if (mic?.status === "recognizing")
    answer = (
      <>
        <button
          type="button"
          className={ps.talkBtn}
          disabled
          title="Идёт распознавание — подождите"
        >
          Говорить
        </button>
        {partsButton(true)}
        <span className={ps.status}>
          <span className={ps.spin} />
          {micStatus("recognizing", false)}
        </span>
      </>
    );
  else if (mic === voice && voice.draft !== null)
    answer = (
      <CheckField
        key={voice.draft}
        initial={voice.draft}
        busy={voice.sending}
        onSend={(text) => {
          voice.submitDraft(text);
          learn("check");
        }}
        onDismiss={voice.dismissDraft}
        onAgain={() => {
          voice.dismissDraft();
          if (canStartRecording("idle", speaking)) voice.toggle();
        }}
      />
    );
  else
    answer = (
      <>
        {!disabled && quick.length > 0 && (
          <span className={ps.group} role="group" aria-label="Реплики">
            {quick.map((item) => (
              <button
                key={`${item.id}:${item.label}`}
                type="button"
                data-reply={item.id}
                data-correct={item.correct}
                className={ps.question}
                onClick={() => say(item)}
              >
                {item.label}
              </button>
            ))}
          </span>
        )}
        {spellChoice && (
          <span className={ps.group} role="group" aria-label="Варианты доклада">
            {spellChoice.options.map((option) => (
              <button
                key={option.text}
                type="button"
                data-correct={option.correct}
                data-part="report"
                className={ps.question}
                onClick={() =>
                  spelledBack(option.text, [
                    { label: spellChoice.label, ok: option.correct },
                  ])
                }
              >
                {option.text}
              </button>
            ))}
          </span>
        )}
        {callerTalking &&
          liveCaller &&
          callerGuidance(liveCaller.book, callerMemory(cardId)) && (
            <span
              role="status"
              aria-label="Подсказка разговора с заявителем"
              className={ps.group}
            >
              {callerGuidance(liveCaller.book, callerMemory(cardId))}
            </span>
          )}
        {callerChoices.length > 0 && (
          <span
            className={ps.group}
            role="group"
            aria-label="Вопросы заявителю"
          >
            {callerChoices.map((item) => (
              <button
                key={item.id}
                type="button"
                data-caller={item.id}
                className={ps.question}
                onClick={() => askCaller(item.text)}
              >
                {item.text}
              </button>
            ))}
          </span>
        )}
        {reportStep && (
          <span className={ps.group} role="group" aria-label="Варианты доклада">
            {reportStep.options.map((option) => (
              <button
                key={option.text}
                type="button"
                data-correct={option.correct}
                data-part="report"
                className={ps.question}
                onClick={() => sayPart(reportStep, option)}
              >
                {option.text}
              </button>
            ))}
          </span>
        )}
        {!partsMode && (
          <span
            className={ps.group}
            role="group"
            aria-label={
              mic === replyVoice
                ? "Ответ бригаде голосом"
                : mic === callerVoice
                  ? "Разговор с заявителем голосом"
                  : "Доклад голосом"
            }
          >
            <button
              type="button"
              className={ps.talkBtn}
              disabled={!mic}
              aria-keyshortcuts={mic ? "Space" : undefined}
              // Нажатие во время реплики ждёт её конца (HQ-052): повторный щелчок — отмена.
              // Всегда переключатель: нажата — запись ждёт конца реплики (CONTRIBUTING §4).
              aria-pressed={armed !== null}
              data-armed={armed ?? undefined}
              title={
                !mic
                  ? "Микрофон недоступен: ответьте вариантом ответа"
                  : armed
                    ? "Запись начнётся, когда собеседник договорит; щёлкните ещё раз — отмена"
                    : speaking
                      ? "Говорит собеседник — запись начнётся, когда он договорит"
                      : "Говорить — пробел"
              }
              onClick={() => {
                if (armedRef.current) setArmed(null);
                else press("button");
              }}
            >
              {speaking && !mic ? "Слушайте…" : "Говорить"}
            </button>
            {partsButton(!mic || !partsOffered)}
          </span>
        )}
        {/* Статус микрофона словами: собеседник говорит — запись не идёт (TC-04). */}
        {mic && micStatus("idle", speaking, armed !== null) && (
          <span className={ps.status} role="status">
            {micStatus("idle", speaking, armed !== null)}
          </span>
        )}
      </>
    );

  const warnings = new Set(
    [voice.note, replyVoice.note, voice.problem ? voice.note : null].filter(
      (text): text is string => Boolean(text),
    ),
  );
  const callView = (
    <>
      <div className={ps.talkLog} ref={feedRef}>
        {hintBlock}
        <ol aria-live="polite" aria-label={`Разговор: ${peerName}`}>
          {lines.map((line) => (
            <li
              key={line.id}
              className={
                line.who === "you"
                  ? ps.me
                  : line.who === "note"
                    ? ps.sys
                    : undefined
              }
              data-report={line.report || undefined}
            >
              {line.who !== "note" && (
                <span className={ps.who}>
                  {line.who === "you" ? "Вы сказали" : peerName}:
                </span>
              )}{" "}
              <span data-line-text="">{line.text}</span>
              {canReplay(line.replay) && (
                <button
                  type="button"
                  className={ps.replay}
                  aria-label="Повторить реплику"
                  title="Повторить реплику"
                  onClick={() => line.replay && void replay(line.replay)}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10">
                    <path d="M1 .5 9 5 1 9.5z" fill="currentColor" />
                  </svg>
                </button>
              )}
              {line.chips && <Chips chips={line.chips} />}
            </li>
          ))}
        </ol>
        {notes.map((text) => (
          <p key={text} className={ps.talkStart} data-warn={warnings.has(text)}>
            {text}
          </p>
        ))}
        {result && (
          <p className={ps.talkStart}>
            Что прозвучало: {result.length} из {required.length}
            <Chips chips={heardChips(result, required)} />
            {result.length < required.length && (
              <>
                <br />
                Чего не сказали, на том конце не узнают.
              </>
            )}
          </p>
        )}
      </div>
      {/* Полоса шагов — только когда отвечают по частям (GP-24: пустой не держит места). */}
      {stepBar.length > 0 && (
        <div className={ps.steps}>
          <div className={ps.stepList}>
            {stepBar.map((label, index) => (
              <span
                key={label}
                className={ps.step}
                data-done={index < stepAt}
                data-current={index === stepAt}
              >
                {index < stepAt ? "✓ " : ""}
                {index + 1}. {label}
              </span>
            ))}
          </div>
        </div>
      )}
      <CallFooter
        onHangup={active ? hangup : undefined}
        disabled={disabled || model.phase === "closing"}
        title={
          disabled
            ? "Занятие завершено — разговор уже закрыт"
            : model.phase === "closing"
              ? "Звонок уже заканчивается"
              : undefined
        }
      >
        {answer}
      </CallFooter>
    </>
  );

  const body = inCall ? callView : contactsView;

  // В АРМ окно телефона ставит ArmPage (PhoneWindow); на стендах его нет — связь
  // рисуется на месте тем же видом.
  if (phoneApi) {
    if (!inPhone || (callOnly && !inCall)) return null;
    const { head: headSlot, body: bodySlot } = phoneApi.slots;
    return (
      <>
        {headSlot && createPortal(head, headSlot)}
        {bodySlot && createPortal(body, bodySlot)}
      </>
    );
  }
  return (
    <section
      className={ps.talk}
      style={{ position: "relative", width: 760, height: 340 }}
      aria-label="Телефон ДДС"
    >
      <div className={ps.talkHead}>{head}</div>
      <div className={ps.body}>{body}</div>
    </section>
  );
}

/**
 * Поле правки (TC-04): фраза распознана неуверенно, сначала она показана здесь. Enter
 * отправляет проверенный текст; «Сказать заново» (запись сразу) и Escape (без записи)
 * убирают его без штрафа.
 */
function CheckField({
  initial,
  busy,
  onSend,
  onDismiss,
  onAgain,
}: {
  readonly initial: string;
  readonly busy: boolean;
  readonly onSend: (text: string) => void;
  readonly onDismiss: () => void;
  readonly onAgain: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className={ps.checkForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) onSend(value);
      }}
    >
      <input
        aria-label={CHECK_NOTE}
        title={CHECK_NOTE}
        value={value}
        maxLength={1000}
        disabled={busy}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onDismiss();
        }}
      />
      <button
        type="submit"
        className={ps.question}
        disabled={busy || !value.trim()}
        title={
          busy
            ? "Идёт отправка — подождите"
            : value.trim()
              ? undefined
              : "Впишите текст"
        }
      >
        Отправить
      </button>
      <button
        type="button"
        className={ps.question}
        disabled={busy}
        title={busy ? "Идёт отправка — подождите" : undefined}
        onClick={onAgain}
      >
        Сказать заново
      </button>
    </form>
  );
}

function Chips({ chips }: { readonly chips: readonly Chip[] }) {
  return (
    <span className={ps.parts}>
      {chips.map((chip) => (
        <span key={chip.label} className={ps.part} data-ok={chip.ok}>
          {chip.ok ? "✓" : "✗"} {chip.label}
        </span>
      ))}
    </span>
  );
}
