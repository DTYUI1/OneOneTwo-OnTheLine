// Ответ бригаде голосом в разговоре (DT-16): та же запись фразы, индикатор громкости и
// переход к вариантам после двух неудач, что у доклада службе (useVoiceReport). Правила —
// в voiceReply.ts и voiceReport.ts (проверяются тестами), здесь только браузер и сеть.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, csrfToken } from "../../../shared/api";
import { createPhraseRecorder, type PhraseRecorder } from "../phraseRecorder";
import { type VoiceStatus } from "../useVoiceReport";
import {
  choicesShown,
  loudnessNote,
  type Loudness,
  type VoiceProblem,
} from "../voiceReport";
import {
  replyOutcome,
  replyProblemNote,
  replyUnclearNote,
  type ReplyOutcome,
  type ReplyRecognition,
} from "./voiceReply";
import type { BrigadeQuestion } from "./logic";

export interface VoiceReplyView {
  readonly status: VoiceStatus;
  /** Громкость с микрофона во время записи, 0…1. */
  readonly level: number;
  /** Голосом не ответить: нет микрофона, доступа или распознавания. */
  readonly problem: VoiceProblem | null;
  /** Что сказать обучаемому под кнопкой; `null` — всё идёт штатно. */
  readonly note: string | null;
  /** Несопоставленных фраз на этот вопрос — уходит в ответ (`voice_failures`). */
  readonly failures: number;
  /** Показывать варианты ответа. */
  readonly choices: boolean;
  /** Начать фразу или закончить её — одна кнопка. */
  readonly toggle: () => void;
  /** Раскрыть варианты вручную («По частям»). */
  readonly openChoices: () => void;
  /** Бросить запись без результата: собеседник заговорил, микрофон закрыт (полудуплекс, TC-04). */
  readonly cancel: () => void;
}

async function recognize(
  callId: string,
  question: BrigadeQuestion | null,
  blob: Blob,
): Promise<ReplyOutcome> {
  const form = new FormData();
  // Без вопроса — фраза бригаде вне реплики (DT-19): только распознавание.
  if (question) form.append("delivery_id", question.deliveryId);
  form.append("audio", blob, "reply");
  try {
    const { data, response } = await api.POST("/calls/{id}/voice-reply", {
      params: {
        path: { id: callId },
        header: { "X-CSRF-Token": csrfToken() },
      },
      // Тело целиком собирает bodySerializer; поля здесь — требование типа из контракта.
      body: { audio: "" },
      bodySerializer: () => form,
    });
    return replyOutcome(
      response.status,
      data as ReplyRecognition | undefined,
      question?.options ?? null,
    );
  } catch {
    // Нет связи — фраза не понята; бригада переспросит, повтор возможен.
    return { kind: "unclear", loudness: null };
  }
}

export function useVoiceReply(input: {
  /** Разговор с бригадой. */
  readonly callId: string | null;
  /** Вопрос бригады с вариантами ответа; `null` — отвечать не на что. */
  readonly question: BrigadeQuestion | null;
  /** Без вопроса бригаде можно сказать что угодно (DT-19) — `onSaid`. */
  readonly free?: boolean;
  readonly voiceOnly: boolean;
  readonly onHeard: (
    text: string,
    optionKey: string,
    loudness: Loudness | null,
    failures: number,
  ) => void;
  readonly onUnclear: () => void;
  /**
   * Фраза без вопроса распознана; `worldAnswers` — на неё ответит мир репликой ветки
   * (поправка повтора адреса, HQ-024), своего ответа окно не даёт.
   */
  readonly onSaid?: (
    text: string,
    loudness: Loudness | null,
    worldAnswers: boolean,
  ) => void;
}): VoiceReplyView {
  const { callId, question, voiceOnly, free = false } = input;
  const deliveryId = question?.deliveryId ?? null;
  const listening = callId !== null && (question !== null || free);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [problem, setProblem] = useState<VoiceProblem | null>(null);
  const [failures, setFailures] = useState(0);
  const [opened, setOpened] = useState(false);
  const [level, setLevel] = useState(0);
  const [loudness, setLoudness] = useState<Loudness | null>(null);
  const recorderRef = useRef<PhraseRecorder | null>(null);
  const askedRef = useRef({ callId, question });
  askedRef.current = { callId, question };
  const handlers = useRef(input);
  handlers.current = input;
  const failuresRef = useRef(failures);
  failuresRef.current = failures;

  // Новый вопрос — новый ответ: счётчик и раскрытые варианты не переносятся.
  useEffect(() => {
    setFailures(0);
    setOpened(false);
    setLoudness(null);
    setStatus("idle");
    // Распознавание, выключенное на сервере, не включится до конца занятия.
    setProblem((old) => (old === "server_off" ? old : null));
  }, [deliveryId]);

  // Вопроса больше нет (ответили, отбой) — запись бросается.
  useEffect(() => {
    if (listening) return;
    recorderRef.current?.cancel();
    recorderRef.current = null;
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
    const asked = askedRef.current;
    recorderRef.current = null;
    if (!recorder || !asked.callId) return;
    const { callId: call, question: target } = asked;
    setStatus("recognizing");
    const blob = await recorder.stop();
    const outcome: ReplyOutcome = blob
      ? await recognize(call, target, blob)
      : { kind: "silence", loudness: null };
    // Пока распознавали, вопрос мог смениться или звонок закончиться — ответ не к нему.
    const now = askedRef.current;
    if (now.callId !== call || now.question?.deliveryId !== target?.deliveryId)
      return;
    setStatus("idle");
    if (outcome.kind === "off") {
      setProblem("server_off");
      return;
    }
    setLoudness(outcome.loudness);
    if (outcome.kind === "silence") return;
    if (outcome.kind === "said") {
      handlers.current.onSaid?.(
        outcome.text,
        outcome.loudness,
        outcome.worldAnswers,
      );
      return;
    }
    if (outcome.kind === "heard") {
      handlers.current.onHeard(
        outcome.text,
        outcome.optionKey,
        outcome.loudness,
        failuresRef.current,
      );
      return;
    }
    setFailures((count) => count + 1);
    handlers.current.onUnclear();
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
    const recorder = createPhraseRecorder();
    recorderRef.current = recorder;
    setStatus("recording");
    void recorder
      .start(() => void finish())
      .then((reason) => {
        if (reason === null) return;
        recorderRef.current = null;
        setStatus("idle");
        setProblem(reason);
      });
  }, [status, listening, finish]);

  const note = !listening
    ? null
    : problem
      ? replyProblemNote(problem, voiceOnly)
      : status !== "idle"
        ? null
        : failures > 0
          ? replyUnclearNote(failures, voiceOnly)
          : loudnessNote(loudness);

  return {
    status,
    level,
    problem,
    note,
    failures,
    choices: choicesShown({ voiceOnly, problem, failures, opened }),
    toggle,
    openChoices: () => setOpened(true),
    cancel,
  };
}
