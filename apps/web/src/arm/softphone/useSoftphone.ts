// Связка чистой machine с браузером: звук, микрофон, реплики, таймеры и очередь
// событий. Вся логика переходов остаётся в machine.ts и проверяется тестами.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type CardEvent } from "../../shared/api";
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
import { createTones } from "./tones";
import { orderContacts } from "./contactOrder";
import {
  browserRecordingStatus,
  createRecorder,
  type Recorder,
  type Recording,
} from "./recorder";
import { createVoices, type Spoken } from "./voices";
import { serviceReplyMayStart } from "./speech";
import { uploadAudio } from "./upload";
import { planDial, refusalNote, UNKNOWN_NUMBER } from "./brigade/logic";

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
}

const NO_LINKS: DialLinks = { targets: [], selectedBrigadeIds: [] };

export interface SoftphoneView {
  readonly model: SoftphoneModel;
  /** Своя служба первая, за ней службы карточки — искать номер не надо. */
  readonly services: readonly Service[];
  readonly cardServiceIds: readonly string[];
  readonly phrase: Spoken | null;
  /** Реплика собеседника звучит прямо сейчас — индикатор «говорит» в окне разговора. */
  readonly speaking: boolean;
  /** Почему реплику не слышно; `null` — реплика прозвучала. */
  readonly voiceNote: string | null;
  /** Звук реплик: отключение и громкость доступны обучаемому. */
  readonly voiceMuted: boolean;
  readonly voiceVolume: number;
  readonly setVoiceMuted: (muted: boolean) => void;
  readonly setVoiceVolume: (volume: number) => void;
  /** Почему номер не набран: сервер отклонил бы звонок и остановил очередь карточки. */
  readonly dialNote: string | null;
  /** Бригада ответила отказом: почему доклада не будет и что делать дальше. */
  readonly refusalNote: string | null;
  /** Почему записи не будет; `null` — запись идёт. */
  readonly micNote: string | null;
  readonly uploadNote: string | null;
  readonly canRetryUpload: boolean;
  readonly digit: (digit: string) => void;
  readonly backspace: () => void;
  readonly clear: () => void;
  readonly dial: (phoneExt?: string) => void;
  readonly finish: () => void;
  /** Ответить на входящий вызов бригады (звонок создан сервером). */
  readonly pickup: (callId: string, phoneExt: string) => void;
  /** Положить трубку сразу — перед переходом к другому происшествию. */
  readonly hangupNow: () => Promise<void>;
  /** Последняя речь диспетчера в микрофоне — по ней бригада ждёт паузы. */
  readonly lastVoiceAt: () => number | null;
  readonly retryUpload: () => void;
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
  const [speaking, setSpeaking] = useState(false);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const [voiceMuted, setVoiceMutedState] = useState(false);
  const [voiceVolume, setVoiceVolumeState] = useState(1);
  const [micNote, setMicNote] = useState<string | null>(null);
  const [dialNote, setDialNote] = useState<string | null>(null);
  const [refusalText, setRefusalText] = useState<string | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [canRetryUpload, setCanRetryUpload] = useState(false);

  const modelRef = useRef(model);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const tonesRef = useRef<ReturnType<typeof createTones> | null>(null);
  const voicesRef = useRef<ReturnType<typeof createVoices> | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const recordingRef = useRef<Promise<Recording> | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const hangupRef = useRef<Promise<void> | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const serviceListRef = useRef<readonly Service[]>([]);
  const dispatchRef = useRef<(event: SoftphoneEvent) => void>(() => {});
  const greetingEndedRef = useRef<{ callId: string; at: number } | null>(null);
  const linksRef = useRef(links);
  linksRef.current = links;

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
    (type: CardEvent["type"], next: SoftphoneModel): Promise<void> => {
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
            : type === "call_answer" || type === "call_hangup"
              ? ({
                  ...base,
                  type,
                  payload: { call_id: next.callId },
                } satisfies CardEvent)
              : null;
      return event ? realtime.enqueue(cardId, event) : Promise.resolve();
    },
    [cardId, realtime],
  );

  const sendRecording = useCallback(async (callId: string) => {
    // Сервер принимает запись только после того, как закрыл звонок
    // (`upload_audio`: 409, пока `ended_at` пуст), поэтому ждём отбоя.
    // Ошибка отправки отбоя не отменяет попытку: очередь его дожмёт.
    await hangupRef.current?.catch(() => undefined);
    const recording = await recordingRef.current;
    const blob = recording?.blob ?? blobRef.current;
    if (!blob) return;
    blobRef.current = blob;
    const result = await uploadAudio(callId, blob);
    setUploadNote(result.note);
    setCanRetryUpload(result.retryable);
    if (result.ok || !result.retryable) blobRef.current = null;
  }, []);

  const runEffect = useCallback(
    (effect: Effect, next: SoftphoneModel): void => {
      switch (effect.type) {
        case "send": {
          const sent = send(effect.event, next);
          if (effect.event === "call_hangup") hangupRef.current = sent;
          else void sent;
          return;
        }
        case "tone":
          if (effect.tone === "ringback") tonesRef.current?.ringback();
          if (effect.tone === "click") tonesRef.current?.click();
          if (effect.tone === "stop") tonesRef.current?.stop();
          return;
        case "record":
          if (effect.action === "start") {
            recordingRef.current = null;
            blobRef.current = null;
            void recorderRef.current?.start().then(setMicNote);
          } else {
            // Запись останавливается раньше отбоя, но резаться может дольше —
            // держим обещание, а не блоб, чтобы загрузка его дождалась.
            const stopping =
              recorderRef.current?.stop() ??
              Promise.resolve({ blob: null, note: null });
            recordingRef.current = stopping;
            void stopping.then((recording) => {
              if (recording.note) setMicNote(recording.note);
            });
          }
          return;
        case "voice": {
          setPhrase(effect.phrase);
          setSpeaking(true);
          // Голос у каждой службы свой — он приходит в её профиле из каталога;
          // у бригады — в профиле её адресата.
          const callee =
            linksRef.current.targets.find(
              (target) =>
                target.brigade_id !== null &&
                target.phone_ext === next.phoneExt,
            ) ??
            serviceListRef.current.find(
              (service) => service.phone_ext === next.phoneExt,
            );
          void voicesRef.current
            ?.play(effect.phrase, callee?.voice_profile ?? null)
            .then((result) => {
              setSpeaking(false);
              if (modelRef.current.callId !== next.callId) return;
              // Молчание не выдаётся за состоявшийся разговор: причина видна.
              setVoiceNote(result.note);
              if (effect.phrase === "listen" && next.callId)
                greetingEndedRef.current = {
                  callId: next.callId,
                  at: Date.now(),
                };
              dispatchRef.current({ type: "voice_done", at: Date.now() });
            });
          return;
        }
        case "wait": {
          const waited = effect.event;
          timersRef.current.push(
            setTimeout(() => {
              dispatchRef.current(
                waited === "ring"
                  ? { type: "ring" }
                  : { type: "answer", at: Date.now() },
              );
            }, effect.delayMs),
          );
          return;
        }
        case "upload": {
          if (next.callId) void sendRecording(next.callId);
          return;
        }
      }
    },
    [send, sendRecording],
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
      modelRef.current = next;
      setModel(next);
      for (const effect of effects) runEffect(effect, next);
    },
    [runEffect],
  );
  dispatchRef.current = dispatch;

  useEffect(() => {
    if (
      model.state !== "talking" ||
      model.phase !== "reporting" ||
      !model.callId ||
      !model.phoneExt ||
      model.inbound ||
      model.refusal
    )
      return;
    const callId = model.callId;
    const phoneExt = model.phoneExt;
    const timer = setInterval(() => {
      // Доклады бригад живут по плану; пауза в речи завершает только разговор
      // с общим адресатом службы, после его «Слушаю вас».
      if (
        linksRef.current.targets.some(
          (target) =>
            target.brigade_id !== null && target.phone_ext === phoneExt,
        )
      )
        return;
      const greeting = greetingEndedRef.current;
      if (greeting?.callId !== callId) return;
      if (
        serviceReplyMayStart({
          now: Date.now(),
          greetingEndedAt: greeting.at,
          lastVoiceAt: recorderRef.current?.lastVoiceAt() ?? null,
        })
      )
        dispatchRef.current({ type: "finish", at: Date.now() });
    }, 150);
    return () => clearInterval(timer);
  }, [
    model.state,
    model.phase,
    model.callId,
    model.phoneExt,
    model.inbound,
    model.refusal,
  ]);

  // Инструменты браузера создаются один раз на монтирование модуля.
  useEffect(() => {
    tonesRef.current = createTones();
    voicesRef.current = createVoices();
    recorderRef.current = createRecorder();
    setMicNote(browserRecordingStatus().note);
    const timers = timersRef.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
      voicesRef.current?.cancel();
      recorderRef.current?.release();
      tonesRef.current?.close();
      tonesRef.current = null;
      voicesRef.current = null;
      recorderRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!disabled) return;
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current.length = 0;
    voicesRef.current?.cancel();
    setSpeaking(false);
    tonesRef.current?.stop();
    // Останавливаем только локальную линию, без нового call_hangup после finish.
    // Уже записанный blob и возможность загрузки остаются в этом же экземпляре.
    dispatchRef.current({ type: "suspend", at: Date.now() });
  }, [disabled]);

  // Сервер может закрыть звонок — слушаем только свой call_id.
  useEffect(() => {
    return realtime.subscribe((event) => {
      if (event.type !== "call.state") return;
      if (event.payload.id !== modelRef.current.callId) return;
      dispatchRef.current({
        type: "server",
        state: event.payload.state,
        at: Date.now(),
      });
    });
  }, [realtime]);

  const ownServiceId = links.ownServiceId ?? null;
  const ordered = useMemo(
    () => orderContacts(services.data ?? [], ownServiceId, cardServiceIds),
    [services.data, ownServiceId, cardServiceIds],
  );
  // Эффекту нужен каталог в момент реплики, а не на момент создания колбэка.
  serviceListRef.current = ordered;

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
    greetingEndedRef.current = null;
    const ext = phoneExt ?? modelRef.current.dialed;
    let refusal: { reason: Refusal; note: string } | null = null;
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
    setUploadNote(null);
    setCanRetryUpload(false);
    // Новый звонок — прежняя запись больше не его: звонок с отказом записи не ведёт,
    // и без сброса к нему ушла бы запись прошлого разговора.
    recordingRef.current = null;
    blobRef.current = null;
    dispatchRef.current({
      type: "dial",
      callId: crypto.randomUUID(),
      at: Date.now(),
      refusal: refusal?.reason ?? null,
    });
  }, []);

  const pickup = useCallback((callId: string, phoneExt: string) => {
    if (disabledRef.current) return;
    greetingEndedRef.current = null;
    setDialNote(null);
    setPhrase(null);
    setVoiceNote(null);
    setUploadNote(null);
    setCanRetryUpload(false);
    dispatchRef.current({ type: "pickup", callId, phoneExt, at: Date.now() });
  }, []);

  const hangupNow = useCallback(async () => {
    const current = modelRef.current;
    if (current.state === "idle" || current.state === "ended") return;
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current.length = 0;
    voicesRef.current?.cancel();
    setSpeaking(false);
    const sent = send("call_hangup", current);
    hangupRef.current = sent;
    // suspend закрывает линию локально и останавливает запись; отбой уже отправлен.
    dispatchRef.current({ type: "suspend", at: Date.now() });
    if (current.state === "talking" && current.callId)
      void sendRecording(current.callId);
    await sent.catch(() => undefined);
  }, [send, sendRecording]);

  const retryUpload = useCallback(() => {
    const callId = modelRef.current.callId;
    if (!blobRef.current || !callId) return;
    setCanRetryUpload(false);
    void sendRecording(callId);
  }, [sendRecording]);

  return {
    model,
    services: ordered,
    cardServiceIds,
    phrase,
    speaking,
    voiceNote,
    voiceMuted,
    voiceVolume,
    setVoiceMuted,
    setVoiceVolume,
    dialNote,
    // Пояснение — после ответа бригады, а не во время гудков: сначала слышен её отказ.
    refusalNote:
      model.refusal &&
      !model.aborted &&
      (model.state === "talking" || model.state === "ended")
        ? refusalText
        : null,
    micNote,
    uploadNote,
    canRetryUpload,
    digit: (digit) => {
      setDialNote(null);
      // Цифра после разговора начинает новый вызов: итог прежнего больше не нужен.
      if (modelRef.current.state === "ended" && !disabledRef.current) {
        setPhrase(null);
        setUploadNote(null);
        setCanRetryUpload(false);
        setMicNote(browserRecordingStatus().note);
      }
      dispatchRef.current({ type: "digit", digit });
    },
    backspace: () => dispatchRef.current({ type: "backspace" }),
    clear: () => dispatchRef.current({ type: "clear" }),
    dial,
    finish: () => dispatchRef.current({ type: "finish", at: Date.now() }),
    pickup,
    hangupNow,
    lastVoiceAt: () => recorderRef.current?.lastVoiceAt() ?? null,
    retryUpload,
  };
}

export { EXT_LENGTH };
