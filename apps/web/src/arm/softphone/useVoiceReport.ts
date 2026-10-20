// Доклад службе голосом в окне разговора (DT-05): кнопка записи, распознавание фразы на
// сервере, «Не расслышал, повторите» и переход к вариантам после двух неудач.
// Правила — в voiceReport.ts (проверяются тестами), здесь только браузер и сеть.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { api, csrfToken } from "../../shared/api";
import type { AddressGap, ReportChoice, ReportPart } from "./report";
import { createPhraseRecorder, type PhraseRecorder } from "./phraseRecorder";
import {
  afterPhrase,
  CHECK_RETRY_NOTE,
  choicesShown,
  earlierText,
  loudnessNote,
  problemNote,
  recognitionOutcome,
  unclearNote,
  type Loudness,
  type Recognition,
  type VoiceOutcome,
  type VoiceProblem,
} from "./voiceReport";

export type VoiceStatus = "idle" | "recording" | "recognizing";

export interface VoiceReportView {
  /** Расслышанные фразы своего звонка: сохранить вместе с линией на удержании. */
  readonly earlier: () => readonly string[];
  readonly status: VoiceStatus;
  /** Идёт отправка поправленного текста. */
  readonly sending: boolean;
  /** Громкость с микрофона во время записи, 0…1: видно, что микрофон слышит. */
  readonly level: number;
  /** Голосом не доложить: нет микрофона, доступа или распознавания. */
  readonly problem: VoiceProblem | null;
  /** Что сказать обучаемому под кнопкой; `null` — всё идёт штатно. */
  readonly note: string | null;
  /** Нераспознанных фраз в этом звонке — уходит в отбой (`voice_failures`). */
  readonly failures: number;
  /** Показывать варианты ответа. */
  readonly choices: boolean;
  /** Начать фразу или закончить её — одна кнопка. */
  readonly toggle: () => void;
  /** Раскрыть варианты вручную («По частям»). */
  readonly openChoices: () => void;
  /** Распознанное с низкой уверенностью, ждёт проверки в поле правки (TC-04); иначе `null`. */
  readonly draft: string | null;
  /** Отправить поправленный текст вместо звука: служба принимает его как сказанное. */
  readonly submitDraft: (text: string) => void;
  /** Убрать поле правки без отправки («Сказать заново»). */
  readonly dismissDraft: () => void;
  /** Бросить запись без результата: собеседник заговорил, микрофон закрыт (полудуплекс). */
  readonly cancel: () => void;
}

async function recognize(
  callId: string,
  phrase: Blob | string,
  earlier: string | null,
): Promise<VoiceOutcome> {
  const form = new FormData();
  if (typeof phrase === "string") form.append("text", phrase);
  else form.append("audio", phrase, "report");
  // Доклад за звонок: сервер ищет части в прежних фразах и новой вместе.
  if (earlier) form.append("earlier", earlier);
  try {
    const { data, response } = await api.POST("/calls/{id}/voice-report", {
      params: {
        path: { id: callId },
        header: { "X-CSRF-Token": csrfToken() },
      },
      // Тело целиком собирает bodySerializer; поле здесь — требование типа из контракта.
      body: { audio: "" },
      bodySerializer: () => form,
    });
    return recognitionOutcome(response.status, data as Recognition | undefined);
  } catch {
    // Нет связи — фраза не распознана; служба переспросит, повтор возможен.
    return { kind: "unclear" };
  }
}

export function useVoiceReport(input: {
  /** Звонок службе, в котором идёт доклад; `null` — доклада нет. */
  readonly callId: string | null;
  /** Версия настоящей машины: меняется синхронно, даже если callId сохранён в ended. */
  readonly conversationVersion?: () => number;
  /** Снимок доклада до удержания; чужой звонок его не наследует. */
  readonly saved?: {
    readonly callId: string;
    readonly earlier: readonly string[];
  } | null;
  /** Служба слушает доклад: после «Слушаю вас» и до полного доклада. */
  readonly listening: boolean;
  readonly voiceOnly: boolean;
  readonly onHeard: (
    text: string,
    choice: ReportChoice,
    parts: readonly ReportPart[],
    loudness: Loudness | null,
    spellStreet: string | null,
    addressGap: AddressGap | null,
  ) => void;
  readonly onUnclear: () => void;
}): VoiceReportView {
  const { callId, listening, voiceOnly } = input;
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [problem, setProblem] = useState<VoiceProblem | null>(null);
  const [failures, setFailures] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  // Поправленный текст не дошёл до сервера: поле остаётся, Enter пробует ещё раз.
  const [sendFailed, setSendFailed] = useState(false);
  const [sending, setSending] = useState(false);
  const [opened, setOpened] = useState(false);
  const [level, setLevel] = useState(0);
  // Громкость последней расслышанной фразы: подсказка «громче / тише» до следующей.
  const [loudness, setLoudness] = useState<Loudness | null>(null);
  const recorderRef = useRef<PhraseRecorder | null>(null);
  const failuresRef = useRef(failures);
  failuresRef.current = failures;
  const sendingRef = useRef(false);
  const callRef = useRef(callId);
  callRef.current = callId;
  const handlers = useRef(input);
  handlers.current = input;
  // Расслышанные фразы доклада в этом звонке — уходят с новой фразой (`earlier`).
  const saidRef = useRef<readonly string[]>([]);
  const generation = useRef(0);
  const conversationVersion = input.conversationVersion?.() ?? 0;
  const current = useCallback(
    (version: number, call: string | null, conversation: number) =>
      version === generation.current &&
      call === callRef.current &&
      conversation === (handlers.current.conversationVersion?.() ?? 0),
    [],
  );

  // Новый звонок — новый доклад: счётчик и раскрытые варианты не переносятся.
  useLayoutEffect(() => {
    const saved = handlers.current.saved;
    saidRef.current = saved?.callId === callId ? [...saved.earlier] : [];
    setFailures(0);
    setDraft(null);
    setSendFailed(false);
    setOpened(false);
    setLoudness(null);
    setStatus("idle");
    sendingRef.current = false;
    setSending(false);
    // Распознавание, выключенное на сервере, не включится до конца занятия.
    setProblem((old) => (old === "server_off" ? old : null));
    return () => {
      generation.current += 1;
      recorderRef.current?.cancel();
      recorderRef.current = null;
    };
  }, [callId, conversationVersion]);

  // Служба больше не слушает (полный доклад, отбой) — запись бросается.
  useEffect(() => {
    if (listening) return;
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setDraft(null);
    setStatus((old) => (old === "recording" ? "idle" : old));
  }, [listening]);

  useEffect(
    () => () => {
      recorderRef.current?.cancel();
    },
    [],
  );

  // Индикатор громкости: уровень раз в кадр, пока идёт запись.
  useEffect(() => {
    if (status !== "recording") {
      setLevel(0);
      return;
    }
    let frame = requestAnimationFrame(function tick() {
      setLevel(recorderRef.current?.level() ?? 0);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [status]);

  const finish = useCallback(async () => {
    const recorder = recorderRef.current;
    const call = callRef.current;
    recorderRef.current = null;
    if (!recorder || !call) return;
    const version = generation.current;
    const conversation = handlers.current.conversationVersion?.() ?? 0;
    const earlier = earlierText(saidRef.current);
    setStatus("recognizing");
    const blob = await recorder.stop();
    if (!current(version, call, conversation)) return;
    const outcome: VoiceOutcome = blob
      ? await recognize(call, blob, earlier)
      : { kind: "unclear" };
    // Пока распознавали, звонок мог закончиться — ответ уже не к нему.
    if (!current(version, call, conversation)) return;
    setStatus("idle");
    if (outcome.kind === "off") {
      setProblem("server_off");
      return;
    }
    // Штрафует только фраза без речи; неуверенно распознанное — в поле правки (TC-04).
    const next = afterPhrase(
      { failures: failuresRef.current, draft: null },
      outcome,
    );
    setFailures(next.failures);
    if (outcome.kind === "check") {
      setDraft(next.draft);
      return;
    }
    if (outcome.kind === "heard") {
      saidRef.current = [...saidRef.current, outcome.text];
      setLoudness(outcome.loudness);
      handlers.current.onHeard(
        outcome.text,
        outcome.choice,
        outcome.parts,
        outcome.loudness,
        outcome.spellStreet,
        outcome.addressGap,
      );
      return;
    }
    handlers.current.onUnclear();
  }, [current]);

  const submitDraft = useCallback(
    (text: string) => {
      const call = callRef.current;
      const phrase = text.trim();
      if (!call || !phrase || sendingRef.current) return;
      const version = generation.current;
      const conversation = handlers.current.conversationVersion?.() ?? 0;
      sendingRef.current = true;
      setSending(true);
      setSendFailed(false);
      void recognize(call, phrase, earlierText(saidRef.current)).then(
        (outcome) => {
          // Возврат к тому же callId после удержания — уже другое поколение разговора.
          if (!current(version, call, conversation)) return;
          sendingRef.current = false;
          setSending(false);
          if (outcome.kind === "heard") {
            saidRef.current = [...saidRef.current, outcome.text];
            setDraft(null);
            setLoudness(null);
            handlers.current.onHeard(
              outcome.text,
              outcome.choice,
              outcome.parts,
              null,
              outcome.spellStreet,
              outcome.addressGap,
            );
            return;
          }
          // Не дошло или сервер отказал: поле остаётся, текст не потерян.
          setSendFailed(true);
        },
      );
    },
    [current],
  );

  const dismissDraft = useCallback(() => {
    setDraft(null);
    setSendFailed(false);
  }, []);

  const cancel = useCallback(() => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setStatus((old) => (old === "recording" ? "idle" : old));
  }, []);

  const toggle = useCallback(() => {
    if (status === "recording") {
      void finish();
      return;
    }
    if (status !== "idle" || !listening) return;
    // Новая фраза вместо непроверенной: поле правки убирается.
    setDraft(null);
    setSendFailed(false);
    const recorder = createPhraseRecorder();
    const version = generation.current;
    const conversation = handlers.current.conversationVersion?.() ?? 0;
    const call = callRef.current;
    const live = () =>
      current(version, call, conversation) && recorderRef.current === recorder;
    recorderRef.current = recorder;
    setStatus("recording");
    void recorder
      .start(() => {
        if (live()) void finish();
      })
      .then((reason) => {
        if (!live()) {
          recorder.cancel();
          return;
        }
        if (reason === null) return;
        recorderRef.current = null;
        setStatus("idle");
        setProblem(reason);
      });
  }, [status, listening, finish, current]);

  const note = problem
    ? problemNote(problem, voiceOnly)
    : draft !== null
      ? sendFailed
        ? CHECK_RETRY_NOTE
        : null
      : failures > 0 && listening && status === "idle"
        ? unclearNote(failures, voiceOnly)
        : listening && status === "idle"
          ? loudnessNote(loudness)
          : null;

  return {
    earlier: () => [...saidRef.current],
    status,
    sending,
    level,
    problem,
    note,
    failures,
    choices: choicesShown({ voiceOnly, problem, failures, opened }),
    toggle,
    openChoices: () => setOpened(true),
    draft,
    submitDraft,
    dismissDraft,
    cancel,
  };
}
