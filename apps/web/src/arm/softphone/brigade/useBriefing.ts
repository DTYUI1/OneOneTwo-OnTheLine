// Вводная бригаде в разговоре (GP-05): проверка фразы на сервере и шаги по частям. Правила —
// в briefing.ts (проверяются тестами), здесь только состояние разговора и сеть.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, csrfToken } from "../../../shared/api";
import {
  briefingAnswer,
  briefingText,
  type BriefingCheck,
  type BriefingStep,
} from "./briefing";

async function checkBriefing(
  callId: string,
  text: string,
): Promise<BriefingCheck | null> {
  try {
    const { data } = await api.POST("/calls/{id}/briefing-check", {
      params: {
        path: { id: callId },
        header: { "X-CSRF-Token": csrfToken() },
      },
      body: { text },
    });
    return data ?? null;
  } catch {
    // Нет связи — бригада не расслышала и переспросит.
    return null;
  }
}

export interface BriefingView {
  /** Текущий шаг по частям; `null` — вводная не нужна или части собраны. */
  readonly step: BriefingStep | null;
  /** Часть выбрана: строка «Вы сказали», на последнем шаге — проверка вводной. */
  readonly choose: (part: string) => void;
  /** Фраза голосом: бригада отвечает, полная вводная её отправляет. */
  readonly say: (text: string) => void;
}

export function useBriefing(input: {
  readonly callId: string | null;
  readonly brigadeId: string | null;
  /** Служба бригады: её ответы — фразы банка этой службы. */
  readonly service: string | null;
  /** Бригада на линии ждёт вводной. */
  readonly needed: boolean;
  readonly steps: readonly BriefingStep[];
  /** Строка ленты от диспетчера. */
  readonly onSaid: (text: string) => void;
  /** Ответ бригады; `null` — молчит до доклада о выезде. */
  readonly onAnswer: (text: string | null) => void;
  /** Фраза не стала вводной (неполная): бригаде сказано — в журнал карточки (GP-11). */
  readonly onIncomplete?: (callId: string, text: string) => void;
  readonly onDispatch: (
    callId: string,
    brigadeId: string,
    mode: "voice" | "parts",
    text: string,
  ) => void;
}): BriefingView {
  const { callId, brigadeId, needed, steps } = input;
  const [parts, setParts] = useState<readonly string[]>([]);
  // Сказанное голосом за разговор: бригада помнит адрес из прошлой фразы и не
  // переспрашивает его, когда следом назвали, что случилось.
  const said = useRef<readonly string[]>([]);
  const handlers = useRef(input);
  handlers.current = input;
  const generation = useRef(0);

  // Новый разговор — части и сказанное собираются заново.
  useEffect(() => {
    setParts([]);
    said.current = [];
    return () => {
      generation.current += 1;
    };
  }, [callId]);

  const submit = useCallback(
    async (text: string, mode: "voice" | "parts") => {
      if (!callId || !brigadeId) return;
      // Новая фраза включает прежние: поздний ответ на старую сумму уже не актуален.
      const version = ++generation.current;
      const check = await checkBriefing(callId, text);
      // Проверка могла закончиться после отбоя, смены линии или размонтирования.
      if (
        version !== generation.current ||
        handlers.current.callId !== callId ||
        handlers.current.brigadeId !== brigadeId
      )
        return;
      handlers.current.onAnswer(
        briefingAnswer(check, handlers.current.service),
      );
      if (check?.complete)
        handlers.current.onDispatch(callId, brigadeId, mode, text);
      else {
        handlers.current.onIncomplete?.(callId, text);
        if (mode === "parts") setParts([]);
      }
    },
    [callId, brigadeId],
  );

  const choose = useCallback(
    (part: string) => {
      handlers.current.onSaid(part);
      const next = [...parts, part];
      setParts(next);
      if (next.length === steps.length)
        void submit(briefingText(next), "parts");
    },
    [parts, steps.length, submit],
  );

  const say = useCallback(
    (text: string) => {
      said.current = [...said.current, text];
      void submit(briefingText(said.current), "voice");
    },
    [submit],
  );

  return {
    step: needed && parts.length < steps.length ? steps[parts.length] : null,
    choose,
    say,
  };
}
