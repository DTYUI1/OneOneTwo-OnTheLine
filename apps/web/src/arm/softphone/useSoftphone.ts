// Связка чистой machine с браузером: звук, реплики, таймеры и очередь событий.
// Доклад службе — голосом (useVoiceReport) или вариантами (report.ts); здесь он копится
// по звонку и уходит в отбой.
// Вся логика переходов остаётся в machine.ts и проверяется тестами.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type CardEvent } from "../../shared/api";
import { confirmDial, type DialConfirmation } from "./dialConfirmation";
import { useSession } from "../../shared/session";
import type { components } from "../../api-client/schema";
import {
  type Effect,
  EXT_LENGTH,
  initialModel,
  reduce,
  type SoftphoneEvent,
  type Refusal,
  type SoftphoneModel,
} from "./machine";
import { createTones, lineHiss } from "./tones";
import { orderContacts } from "./contactOrder";
import { createVoices, type Spoken } from "./voices";
import { partsOf, type ReportChoice, type ReportPart } from "./report";
import type { Loudness, ReportMode } from "./voiceReport";
import { planDial, refusalNote, UNKNOWN_NUMBER } from "./brigade/logic";
import { noteServiceDial } from "./brigade/dials";
import { serverNow } from "../../shared/ws/client";
import { contactServices, type PhoneContact } from "./contacts";
import {
  answerLine,
  personaBook,
  registeredLine,
  seededPhrase,
} from "./official";
import {
  BANK_BOOKS,
  OFFICIAL,
  bankAudio,
  bankAudioForText,
  brigadePhrases,
} from "./bank";
import { stopCallSignal } from "../signals";
import { officialBackPhrase, reportPayload, type ReportLog } from "./heldTalk";
import type { CallerBook } from "./caller/book";
import { backOnLine, pickUp } from "./caller/conversation";
import { callerMemory, callerSaid, rememberCaller } from "./caller/memory";

type Service = components["schemas"]["Service"];
type CallTarget = components["schemas"]["CallTarget"];

/** Прямые номера бригад и ручной набор: по ним звонок бригаде уходит как call_dial_target. */
export interface DialLinks {
  readonly targets: readonly CallTarget[];
  readonly selectedBrigadeIds: readonly string[];
  /** Бригада → происшествие, где она занята: так она и ответит на звонок. */
  readonly busy?: ReadonlyMap<string, string>;
  /** Решение по карточке принято («Принята»): от этого зависит, что советовать после отказа. */
  readonly decided?: boolean;
  /** Бригады в списке панели: только их можно направить. */
  readonly listed?: readonly string[];
  /**
   * Сведения о направленных бригадах загружены. Пока их нет, звонок бригаде не набираем:
   * без них направленная бригада выглядела бы ненаправленной и «отказала» бы по ошибке.
   */
  readonly ready?: boolean;
  /** Своя служба (ДДС участника): её номер первый в справочнике. */
  readonly ownServiceId?: string | null;
  /** Абоненты телефона ДДС на занятии (GP-09): звонок им — как в службу, с докладом. */
  readonly contacts?: readonly PhoneContact[];
  /**
   * Живой заявитель (HQ-019): номер роли «Заявитель» и книга его характера. Звонок на этот
   * номер — разговор с заявителем, а не доклад службе: он отвечает своей репликой.
   */
  readonly caller?: {
    readonly number: string;
    readonly book: CallerBook;
  } | null;
}

const NO_LINKS: DialLinks = { targets: [], selectedBrigadeIds: [] };

export interface SoftphoneView {
  readonly model: SoftphoneModel;
  /** Синхронная версия разговора: hold/resume одного callId — разные поколения. */
  readonly conversationVersion: () => number;
  /**
   * Своя служба первая, за ней службы карточки — искать номер не надо; в конце —
   * абоненты ДДС (GP-09) записями справочника своей службы.
   */
  readonly services: readonly Service[];
  readonly cardServiceIds: readonly string[];
  readonly phrase: Spoken | null;
  /**
   * Реплика дежурного службы 101–104 — постоянного персонажа банка (TC-03): он представляется
   * и называет номер регистрации. Записей банка пока нет — реплика текстом, без звука.
   * `null` — звучит запись `phrase` (общий дежурный, Q14).
   */
  readonly spoken: {
    readonly callId: string;
    readonly phrase: Spoken;
    readonly text: string;
  } | null;
  /** Реплика собеседника звучит прямо сейчас — индикатор «говорит» в окне разговора. */
  readonly speaking: boolean;
  /** Номер звучащей реплики: новая реплика — новый номер, даже без паузы (HQ-052). */
  readonly speechId: number;
  /** Сколько ещё звучать реплике, мс; `null` — не звучит или конец неизвестен (HQ-052). */
  readonly speechLeftMs: () => number | null;
  /** Почему реплику не слышно; `null` — реплика прозвучала. */
  readonly voiceNote: string | null;
  /** Звук реплик: отключение и громкость доступны обучаемому. */
  readonly voiceMuted: boolean;
  readonly voiceVolume: number;
  readonly setVoiceMuted: (muted: boolean) => void;
  readonly setVoiceVolume: (volume: number) => void;
  /** Почему номер не набран: сервер отклонил бы звонок и остановил очередь карточки. */
  readonly dialNote: string | null;
  /** Правка поля «Номер» (HQ-023): прежний отказ набора («Номер недоступен.») уже не о нём. */
  readonly clearDialNote: () => void;
  /** Бригада ответила отказом: почему доклада не будет и что делать дальше. */
  readonly refusalNote: string | null;
  /** Выбранные в этом звонке варианты доклада службе, по порядку. */
  readonly reportChoices: readonly ReportChoice[];
  readonly digit: (digit: string) => void;
  readonly backspace: () => void;
  readonly clear: () => void;
  readonly dial: (phoneExt?: string) => void;
  readonly finish: () => void;
  /**
   * Доклад службе сделан — голосом или вариантом. Полный закрывает разговор
   * («информация принята»), неполный остаётся в разговоре — служба уточняет.
   */
  /**
   * Доклад службе; `parts` — прозвучавшие части памятки (голос), иначе по виду. `close =
   * false` — полный доклад записан, но служба ещё спросит (улица по буквам, TC-03): разговор
   * закрывает `accept`.
   */
  readonly report: (
    choice: ReportChoice,
    mode: ReportMode,
    parts?: readonly ReportPart[],
    loudness?: Loudness | null,
    close?: boolean,
  ) => void;
  /** Служба получила ответ на свой последний вопрос и принимает доклад. */
  readonly accept: () => void;
  /** Фраза доклада голосом не расслышана — отмечается в отбое (`voice_failures`). */
  readonly voiceFailed: () => void;
  /** Ответить на входящий вызов бригады (звонок создан сервером). */
  readonly pickup: (callId: string, phoneExt: string) => void;
  /** Положить трубку сразу — перед переходом к другому происшествию. */
  readonly hangupNow: () => Promise<void>;
  /**
   * На удержание (TC-02): линия здесь свободна, звонок на сервере идёт дальше. `false` —
   * удерживать нечего (нет разговора или собеседник уже прощается).
   */
  readonly holdNow: () => boolean;
  /** Доклад службе в идущем звонке — сохранить на удержании (вкладки 17.10). */
  readonly reportLog: () => ReportLog | null;
  /**
   * Снять с удержания: тот же звонок снова в разговоре, без call_answer. `report` — доклад
   * службе, сказанный до удержания: он продолжается и уйдёт в отбой.
   */
  readonly resume: (
    callId: string,
    phoneExt: string,
    report?: ReportLog | null,
    inbound?: boolean,
  ) => boolean;
}

export function useSoftphone(
  cardId: string,
  cardServiceIds: readonly string[],
  disabled = false,
  links: DialLinks = NO_LINKS,
): SoftphoneView {
  const { realtime } = useSession();
  const [model, setModel] = useState(initialModel);
  const [phrase, setPhrase] = useState<Spoken | null>(null);
  const [spoken, setSpoken] = useState<SoftphoneView["spoken"]>(null);
  const [speaking, setSpeaking] = useState(false);
  const [speechId, setSpeechId] = useState(0);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const [voiceMuted, setVoiceMutedState] = useState(false);
  const [voiceVolume, setVoiceVolumeState] = useState(1);
  const [dialNote, setDialNote] = useState<string | null>(null);
  const [refusalText, setRefusalText] = useState<string | null>(null);
  const [reportChoices, setReportChoices] = useState<readonly ReportChoice[]>(
    [],
  );

  const modelRef = useRef(model);
  const conversationRef = useRef(0);
  const conversationVersion = useCallback(() => conversationRef.current, []);
  const mountedRef = useRef(false);
  const dialCleanupRef = useRef<(() => void) | null>(null);
  // Смена контекста отменяет старые обработчики, даже при переходе A → B → A.
  const scopeRef = useRef({ cardId, realtime, disabled });
  if (
    scopeRef.current.cardId !== cardId ||
    scopeRef.current.realtime !== realtime ||
    scopeRef.current.disabled !== disabled
  )
    scopeRef.current = { cardId, realtime, disabled };
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const tonesRef = useRef<ReturnType<typeof createTones> | null>(null);
  const voicesRef = useRef<ReturnType<typeof createVoices> | null>(null);
  // Конец реплики, показанной текстом без записи, мс эпохи.
  const textUntilRef = useRef<number | null>(null);
  const textTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechRunRef = useRef(0);
  /** Доклад службе звонка `callId` — уходит в его отбой (`report_choices` и др.). */
  const reportRef = useRef<{
    callId: string;
    choices: ReportChoice[];
    modes: ReportMode[];
    parts: ReportPart[][];
    loudness: (Loudness | null)[];
    voiceFailures: number;
    /** Номер регистрации, который назвал дежурный (TC-03). */
    registration: string | null;
  } | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const serviceListRef = useRef<readonly Service[]>([]);
  const dispatchRef = useRef<(event: SoftphoneEvent) => void>(() => {});
  const linksRef = useRef(links);
  linksRef.current = links;
  const cardRef = useRef(cardId);
  cardRef.current = cardId;
  const realtimeRef = useRef(realtime);
  realtimeRef.current = realtime;

  const services = useQuery({
    queryKey: ["services"],
    queryFn: async () => {
      const { data, error } = await api.GET("/services");
      if (!data) throw new Error(error?.message ?? "Нет связи с сервером.");
      return data;
    },
    staleTime: Infinity,
  });

  const send = useCallback(
    (
      type: CardEvent["type"],
      next: SoftphoneModel,
      confirmation?: DialConfirmation,
    ): Promise<void> => {
      if (disabledRef.current || !next.callId) return Promise.resolve();
      const base = {
        client_event_id: crypto.randomUUID(),
        client_ts: new Date().toISOString(),
      };
      const plan =
        type === "call_dial"
          ? planDial(
              next.phoneExt ?? "",
              serviceListRef.current,
              linksRef.current.targets,
              linksRef.current.selectedBrigadeIds,
              linksRef.current.busy,
            )
          : null;
      // Ненаправленной бригаде звоним так же: сервер примет звонок и запишет отказ.
      const event =
        plan?.kind === "target" || plan?.kind === "refused"
          ? ({
              ...base,
              type: "call_dial_target",
              payload: {
                call_id: next.callId,
                call_target_id: plan.target.id,
                brigade_id: plan.target.brigade_id,
              },
            } satisfies CardEvent)
          : type === "call_dial"
            ? ({
                ...base,
                type,
                payload: {
                  call_id: next.callId,
                  phone_ext: next.phoneExt ?? "",
                },
              } satisfies CardEvent)
            : type === "call_hangup" &&
                reportRef.current?.callId === next.callId
              ? ({
                  ...base,
                  type,
                  // Доклад службе — в отбое: по нему оценка видит, был ли он полным
                  // и как сказан (голосом или вариантом ответа).
                  payload: {
                    call_id: next.callId,
                    ...reportPayload(reportRef.current),
                  },
                } satisfies CardEvent)
              : type === "call_answer" || type === "call_hangup"
                ? ({
                    ...base,
                    type,
                    payload: { call_id: next.callId },
                  } satisfies CardEvent)
                : null;
      if (!event) return Promise.resolve();
      if (confirmation) {
        dialCleanupRef.current?.();
        const attempt = confirmDial(realtime, cardId, event, confirmation);
        dialCleanupRef.current = attempt.dispose;
        return attempt.queued;
      }
      return realtime.enqueue(cardId, event);
    },
    [cardId, realtime],
  );

  const cancelSpeech = useCallback(() => {
    speechRunRef.current += 1;
    if (textTimerRef.current !== null) clearTimeout(textTimerRef.current);
    textTimerRef.current = null;
    textUntilRef.current = null;
    voicesRef.current?.cancel();
  }, []);

  const runEffect = useCallback(
    (effect: Effect, next: SoftphoneModel): void => {
      /** Реплика банка записью; нет записи — текст держится, пока его читают. */
      const speakBank = (callId: string, text: string, url: string | null) => {
        cancelSpeech();
        const run = speechRunRef.current;
        const scope = scopeRef.current;
        const done = (note: string | null) => {
          // Замена реплики, удержание и размонтирование не завершают новую речь.
          if (
            !mountedRef.current ||
            disabledRef.current ||
            scopeRef.current !== scope ||
            run !== speechRunRef.current ||
            modelRef.current.callId !== callId
          )
            return;
          textTimerRef.current = null;
          textUntilRef.current = null;
          setSpeaking(false);
          setVoiceNote(note);
          dispatchRef.current({ type: "voice_done", at: Date.now() });
        };
        if (url && voicesRef.current) {
          void voicesRef.current
            .playAsset(url, readingMs(text))
            .then((result) => {
              if (result.outcome !== "cancelled") done(result.note);
            });
          return;
        }
        textUntilRef.current = Date.now() + readingMs(text);
        textTimerRef.current = setTimeout(() => done(null), readingMs(text));
      };
      switch (effect.type) {
        case "send":
          void send(effect.event, next);
          return;
        case "tone":
          if (effect.tone === "ringback") tonesRef.current?.ringback();
          // Снятая трубка обрывает трель вызова (проверка 17.10).
          if (effect.tone === "click") {
            stopCallSignal();
            tonesRef.current?.click();
          }
          if (effect.tone === "stop") tonesRef.current?.stop();
          return;
        case "voice": {
          setPhrase(effect.phrase);
          setSpeaking(true);
          setSpeechId((value) => value + 1);
          // Дежурный службы 101–104 — персонаж банка (TC-03): представляется, принимая
          // доклад, называет номер регистрации. Звучит записью банка (GP-28); нет записи —
          // текст держится на экране столько, сколько его читать.
          // Дежурный 101–104 — всегда свой персонаж, а не только в звонке с докладом:
          // один абонент — один голос (проверка 17.10).
          // Живой заявитель (HQ-019) снимает трубку своей репликой, не голосом дежурного:
          // «Алло, слушаю», после оборванного разговора — «это опять вы?».
          const live = linksRef.current.caller;
          if (
            live &&
            next.callId &&
            next.phoneExt === live.number &&
            effect.phrase === "listen"
          ) {
            const callId = next.callId;
            const card = cardRef.current;
            const turn = next.resumed
              ? backOnLine(live.book, callerMemory(card))
              : pickUp(live.book, callerMemory(card));
            rememberCaller(card, turn.memory);
            const line = turn.lines[0];
            if (line) {
              setSpoken({ callId, phrase: effect.phrase, text: line.text });
              speakBank(callId, line.text, bankAudio(line.id));
              if (!disabledRef.current)
                void realtimeRef.current.enqueue(
                  card,
                  callerSaid(callId, line.id),
                );
              return;
            }
          }
          const log = reportRef.current;
          const book = next.callId ? personaBook(next.phoneExt) : null;
          if (
            book &&
            next.callId &&
            (effect.phrase === "listen" || effect.phrase === "accepted")
          ) {
            const callId = next.callId;
            // Снят с удержания (вкладки 17.10): «Да, пожарная охрана, слушаю.» вместо представления.
            const line =
              effect.phrase === "listen"
                ? {
                    text: next.resumed
                      ? officialBackPhrase(book).text
                      : answerLine(book, callId),
                    number: null,
                  }
                : registeredLine(book, callId);
            if (line.number && log?.callId === callId)
              log.registration = line.number;
            setSpoken({ callId, phrase: effect.phrase, text: line.text });
            speakBank(callId, line.text, bankAudioForText([book], line.text));
            return;
          }
          // Отказ бригады, не направленной на происшествие, — фраза банка её службы (GP-28).
          if (
            next.callId &&
            (effect.phrase === "busy" || effect.phrase === "not_assigned")
          ) {
            const service = linksRef.current.ownServiceId ?? null;
            const [phrase] = brigadePhrases(
              service,
              effect.phrase === "busy"
                ? "refusal_busy"
                : "refusal_not_assigned",
            );
            if (phrase) {
              setSpoken({
                callId: next.callId,
                phrase: effect.phrase,
                text: phrase.text,
              });
              speakBank(next.callId, phrase.text, bankAudio(phrase.id));
              return;
            }
          }
          // Остальные абоненты — тоже голос банка (проверка 17.10: без Piper). Бригада снимает
          // трубку голосом своей службы, ЖКХ, Мослифт, 112 и прочие — общий дежурный.
          if (next.callId) {
            const callId = next.callId;
            const brigade = linksRef.current.targets.some(
              (target) =>
                target.brigade_id !== null &&
                target.phone_ext === next.phoneExt,
            );
            const own = linksRef.current.ownServiceId ?? null;
            // Снят с удержания (вкладки 17.10): общий дежурный — «Да, слушаю.».
            if (!brigade && next.resumed && effect.phrase === "listen") {
              const back = officialBackPhrase(OFFICIAL);
              setSpoken({ callId, phrase: effect.phrase, text: back.text });
              speakBank(callId, back.text, back.url);
              return;
            }
            const phrase =
              brigade && own && BANK_BOOKS[own]
                ? seededPhrase(
                    own,
                    effect.phrase === "listen" ? "answer" : "ack",
                    callId,
                  )
                : seededPhrase(
                    OFFICIAL,
                    effect.phrase === "listen" ? "answer" : "accepted",
                    callId,
                  );
            setSpoken({ callId, phrase: effect.phrase, text: phrase.text });
            speakBank(callId, phrase.text, bankAudio(phrase.id));
            return;
          }
          setSpeaking(false);
          return;
        }
        case "wait": {
          const waited = effect.event;
          const scope = scopeRef.current;
          const callId = next.callId;
          timersRef.current.push(
            setTimeout(() => {
              if (
                !mountedRef.current ||
                disabledRef.current ||
                scopeRef.current !== scope ||
                modelRef.current.callId !== callId
              )
                return;
              dispatchRef.current(
                waited === "ring"
                  ? { type: "ring" }
                  : { type: "answer", at: Date.now() },
              );
            }, effect.delayMs),
          );
          return;
        }
      }
    },
    [send, cancelSpeech],
  );

  const dispatch = useCallback(
    (event: SoftphoneEvent): void => {
      if (
        disabledRef.current &&
        event.type !== "server" &&
        event.type !== "suspend"
      )
        return;
      const { model: next, effects } = reduce(modelRef.current, event);
      if (next === modelRef.current && effects.length === 0) return;
      // До эффектов и React commit: поздний Promise не должен успеть в прежний разговор.
      if (
        next.callId !== modelRef.current.callId ||
        (next.state !== modelRef.current.state &&
          (next.state === "ended" || modelRef.current.state === "ended"))
      )
        conversationRef.current += 1;
      if (next.callId !== modelRef.current.callId) dialCleanupRef.current?.();
      const answerEffect = effects.find(
        (effect) => effect.type === "send" && effect.event === "call_answer",
      );
      if (answerEffect?.type === "send") {
        // Запись в очередь — не принятие. Управление, звук и подтверждение доклада
        // доступны лишь после принятия сервером именно этого ответа на звонок.
        const pending: SoftphoneModel = {
          ...next,
          state: "ringing",
          phase: null,
          talkStartedAt: null,
        };
        modelRef.current = pending;
        setModel(pending);
        const scope = scopeRef.current;
        const conversation = conversationRef.current;
        void send(answerEffect.event, next, {
          isCurrent: () =>
            mountedRef.current &&
            !disabledRef.current &&
            scopeRef.current === scope &&
            conversationRef.current === conversation &&
            modelRef.current === pending,
          accepted: () => {
            const accepted = { ...next, talkStartedAt: Date.now() };
            modelRef.current = accepted;
            setModel(accepted);
            for (const effect of effects)
              if (effect !== answerEffect) runEffect(effect, accepted);
          },
          rejected: (message) => {
            for (const timer of timersRef.current) clearTimeout(timer);
            timersRef.current.length = 0;
            cancelSpeech();
            setSpeaking(false);
            setDialNote(message);
            dispatchRef.current({ type: "suspend", at: Date.now() });
          },
        });
        return;
      }
      modelRef.current = next;
      setModel(next);
      const dialEffect = effects.find(
        (effect) => effect.type === "send" && effect.event === "call_dial",
      );
      if (dialEffect?.type === "send") {
        // Набор ждёт подтверждения: завершение enqueue не означает, что сервер принял
        // звонок, — событие могло остаться в очереди без сети или за отклонённым действием.
        const scope = scopeRef.current;
        void send(dialEffect.event, next, {
          isCurrent: () =>
            mountedRef.current &&
            !disabledRef.current &&
            scopeRef.current === scope &&
            modelRef.current.callId === next.callId,
          accepted: () => {
            if (modelRef.current.state !== "dialing") return;
            for (const effect of effects)
              if (effect !== dialEffect) runEffect(effect, next);
          },
          rejected: (message) => {
            for (const timer of timersRef.current) clearTimeout(timer);
            timersRef.current.length = 0;
            cancelSpeech();
            setSpeaking(false);
            setDialNote(message);
            dispatchRef.current({ type: "suspend", at: Date.now() });
          },
        });
        return;
      }
      for (const effect of effects) runEffect(effect, next);
    },
    [runEffect, send, cancelSpeech],
  );
  dispatchRef.current = dispatch;

  // Инструменты браузера создаются один раз на монтирование модуля.
  useEffect(() => {
    mountedRef.current = true;
    tonesRef.current = createTones();
    voicesRef.current = createVoices();
    const timers = timersRef.current;
    return () => {
      conversationRef.current += 1;
      mountedRef.current = false;
      dialCleanupRef.current?.();
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
      cancelSpeech();
      tonesRef.current?.close();
      tonesRef.current = null;
      voicesRef.current = null;
    };
  }, [cancelSpeech]);

  useEffect(() => {
    return () => {
      dialCleanupRef.current?.();
    };
  }, [cardId, realtime, disabled]);

  // Шипение открытой линии — только пока идёт разговор; «звук выкл.» гасит и его.
  const hiss = lineHiss(model.state, voiceMuted, disabled);
  useEffect(() => {
    tonesRef.current?.line(hiss);
  }, [hiss]);

  useEffect(() => {
    if (!disabled) return;
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current.length = 0;
    cancelSpeech();
    setSpeaking(false);
    tonesRef.current?.stop();
    // Останавливаем только локальную линию, без нового call_hangup после finish.
    dispatchRef.current({ type: "suspend", at: Date.now() });
  }, [disabled, cancelSpeech]);

  // Сервер может закрыть звонок — слушаем только свой call_id.
  useEffect(() => {
    const scope = scopeRef.current;
    return realtime.subscribe((event) => {
      if (
        !mountedRef.current ||
        disabledRef.current ||
        scopeRef.current !== scope
      )
        return;
      if (event.type !== "call.state") return;
      if (event.payload.id !== modelRef.current.callId) return;
      dispatchRef.current({
        type: "server",
        state: event.payload.state,
        at: Date.now(),
      });
    });
  }, [realtime, cardId, disabled]);

  const ownServiceId = links.ownServiceId ?? null;
  const ordered = useMemo(
    () => orderContacts(services.data ?? [], ownServiceId, cardServiceIds),
    [services.data, ownServiceId, cardServiceIds],
  );
  const contacts = links.contacts;
  const dialable = useMemo(
    () => [
      ...ordered,
      ...contactServices(
        contacts ?? [],
        ordered.find((service) => service.id === ownServiceId),
      ),
    ],
    [ordered, contacts, ownServiceId],
  );
  // Эффекту нужен каталог в момент реплики, а не на момент создания колбэка.
  serviceListRef.current = dialable;

  const setVoiceMuted = useCallback((next: boolean) => {
    setVoiceMutedState(next);
    voicesRef.current?.setMuted(next);
  }, []);

  const setVoiceVolume = useCallback((next: number) => {
    setVoiceVolumeState(next);
    voicesRef.current?.setVolume(next);
  }, []);

  const dial = useCallback((phoneExt?: string) => {
    if (disabledRef.current) return;
    const ext = phoneExt ?? modelRef.current.dialed;
    let refusal: { reason: Refusal; note: string } | null = null;
    // Доклад ведётся только со службой: бригада докладывает сама, отказ — без доклада.
    let toService = false;
    if (ext.length === EXT_LENGTH) {
      // Отклоняемый звонок не отправляем: отказ сервера остановил бы очередь карточки.
      if (serviceListRef.current.length === 0) {
        setDialNote(
          "Справочник номеров ещё загружается — повторите через секунду.",
        );
        return;
      }
      const plan = planDial(
        ext,
        serviceListRef.current,
        linksRef.current.targets,
        linksRef.current.selectedBrigadeIds,
        linksRef.current.busy,
      );
      if (plan.kind === "unknown") {
        setDialNote(UNKNOWN_NUMBER);
        return;
      }
      // Заявителю не докладывают (HQ-019): с ним разговор, и он не вызванная служба.
      const live = linksRef.current.caller?.number === ext;
      toService = plan.kind === "service" && !live;
      // Служба вызвана — окно знает это сразу, до выдачи обучения (HQ-055, GP-28).
      if (plan.kind === "service" && !live)
        noteServiceDial(
          cardRef.current,
          plan.service.id,
          serverNow(realtimeRef.current.clockOffsetMs),
        );
      if (plan.kind !== "service" && linksRef.current.ready === false) {
        setDialNote(
          "Сведения о бригадах ещё загружаются — повторите через секунду.",
        );
        return;
      }
      // Звонок не запрещаем: бригада ответит отказом, а пояснение появится после ответа.
      refusal =
        plan.kind === "refused"
          ? {
              reason: plan.reason,
              note: refusalNote(
                plan,
                linksRef.current.decided ?? true,
                linksRef.current.listed?.includes(
                  plan.target.brigade_id as string,
                ) ?? true,
              ),
            }
          : null;
    }
    setDialNote(null);
    setRefusalText(refusal?.note ?? null);
    if (phoneExt) {
      dispatchRef.current({ type: "clear" });
      for (const digit of phoneExt)
        dispatchRef.current({ type: "digit", digit });
    }
    setPhrase(null);
    setVoiceNote(null);
    const callId = crypto.randomUUID();
    reportRef.current = toService
      ? {
          callId,
          choices: [],
          modes: [],
          parts: [],
          loudness: [],
          voiceFailures: 0,
          registration: null,
        }
      : null;
    setReportChoices([]);
    dispatchRef.current({
      type: "dial",
      callId,
      at: Date.now(),
      refusal: refusal?.reason ?? null,
    });
  }, []);

  const pickup = useCallback((callId: string, phoneExt: string) => {
    if (disabledRef.current) return;
    setDialNote(null);
    setPhrase(null);
    setVoiceNote(null);
    reportRef.current = null;
    setReportChoices([]);
    dispatchRef.current({ type: "pickup", callId, phoneExt, at: Date.now() });
  }, []);

  const hangupNow = useCallback(async () => {
    const current = modelRef.current;
    if (current.state === "idle" || current.state === "ended") return;
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current.length = 0;
    cancelSpeech();
    setSpeaking(false);
    const sent = send("call_hangup", current);
    // suspend закрывает линию локально; отбой уже отправлен.
    dispatchRef.current({ type: "suspend", at: Date.now() });
    await sent.catch(() => undefined);
  }, [send, cancelSpeech]);

  const holdNow = useCallback((): boolean => {
    const current = modelRef.current;
    if (
      disabledRef.current ||
      current.state !== "talking" ||
      current.phase !== "reporting"
    )
      return false;
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current.length = 0;
    cancelSpeech();
    setSpeaking(false);
    dispatchRef.current({ type: "hold", at: Date.now() });
    return true;
  }, [cancelSpeech]);

  const reportLog = useCallback((): ReportLog | null => {
    const log = reportRef.current;
    if (!log || log.callId !== modelRef.current.callId) return null;
    return {
      ...log,
      choices: [...log.choices],
      modes: [...log.modes],
      parts: log.parts.map((parts) => [...parts]),
      loudness: [...log.loudness],
    };
  }, []);

  const resume = useCallback(
    (
      callId: string,
      phoneExt: string,
      report: ReportLog | null = null,
      inbound = false,
    ) => {
      if (
        disabledRef.current ||
        ["dialing", "ringing", "talking"].includes(modelRef.current.state)
      )
        return false;
      setDialNote(null);
      setRefusalText(null);
      setPhrase(null);
      setVoiceNote(null);
      // Доклад службе, начатый до удержания, продолжается в том же звонке.
      reportRef.current =
        report?.callId === callId
          ? {
              ...report,
              choices: [...report.choices],
              modes: [...report.modes],
              parts: report.parts.map((parts) => [...parts]),
              loudness: [...report.loudness],
            }
          : null;
      setReportChoices(reportRef.current ? [...reportRef.current.choices] : []);
      // Бригада говорит «на связи» сама (лента); служба и абонент ДДС снова отвечают.
      const brigade = linksRef.current.targets.some(
        (target) => target.brigade_id !== null && target.phone_ext === phoneExt,
      );
      dispatchRef.current({
        type: "resume",
        callId,
        phoneExt,
        at: Date.now(),
        answer: !brigade,
        inbound,
      });
      return (
        modelRef.current.callId === callId &&
        modelRef.current.state === "talking"
      );
    },
    [],
  );

  const report = useCallback(
    (
      choice: ReportChoice,
      mode: ReportMode,
      parts: readonly ReportPart[] = partsOf(choice),
      loudness: Loudness | null = null,
      close = true,
    ) => {
      const current = modelRef.current;
      const log = reportRef.current;
      if (
        disabledRef.current ||
        current.state !== "talking" ||
        current.phase !== "reporting" ||
        !log ||
        log.callId !== current.callId
      )
        return;
      log.choices.push(choice);
      log.modes.push(mode);
      log.parts.push([...parts]);
      log.loudness.push(loudness);
      setReportChoices([...log.choices]);
      if (choice === "full" && close)
        dispatchRef.current({ type: "report", at: Date.now() });
    },
    [],
  );

  const accept = useCallback(() => {
    const current = modelRef.current;
    if (
      disabledRef.current ||
      current.state !== "talking" ||
      current.phase !== "reporting" ||
      reportRef.current?.callId !== current.callId
    )
      return;
    dispatchRef.current({ type: "report", at: Date.now() });
  }, []);

  const voiceFailed = useCallback(() => {
    const log = reportRef.current;
    if (log && log.callId === modelRef.current.callId) log.voiceFailures += 1;
  }, []);

  const speechLeftMs = useCallback((): number | null => {
    const until = textUntilRef.current;
    if (until !== null) return Math.max(0, until - Date.now());
    return voicesRef.current?.remainingMs() ?? null;
  }, []);

  return {
    model,
    conversationVersion,
    services: dialable,
    cardServiceIds,
    phrase,
    spoken,
    speaking,
    speechId,
    speechLeftMs,
    voiceNote,
    voiceMuted,
    voiceVolume,
    setVoiceMuted,
    setVoiceVolume,
    dialNote,
    clearDialNote: () => setDialNote(null),
    // Пояснение — после ответа бригады, а не во время гудков: сначала слышен её отказ.
    refusalNote:
      model.refusal &&
      !model.aborted &&
      (model.state === "talking" || model.state === "ended")
        ? refusalText
        : null,
    reportChoices,
    digit: (digit) => {
      setDialNote(null);
      // Цифра после разговора начинает новый вызов: итог прежнего больше не нужен.
      if (modelRef.current.state === "ended" && !disabledRef.current)
        setPhrase(null);
      dispatchRef.current({ type: "digit", digit });
    },
    backspace: () => dispatchRef.current({ type: "backspace" }),
    clear: () => dispatchRef.current({ type: "clear" }),
    dial,
    finish: () => dispatchRef.current({ type: "finish", at: Date.now() }),
    report,
    accept,
    voiceFailed,
    pickup,
    hangupNow,
    holdNow,
    reportLog,
    resume,
  };
}

/** Сколько держать реплику без звука: скорость чтения короткой строки. */
function readingMs(text: string): number {
  return Math.max(900, Math.round((text.length / 12) * 1000));
}

export { EXT_LENGTH };
