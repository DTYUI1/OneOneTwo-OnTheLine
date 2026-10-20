import { useEffect, useRef } from "react";
import { alarmCallSignal, brigadeCallSignal, stopCallSignal } from "../signals";

export interface IncomingSignal {
  readonly callId: string;
  readonly alarm: boolean;
}

/** Один сигнал на вызов за время работы АРМ, независимо от окна и выбранной карточки. */
export function useIncomingSignal(incoming: readonly IncomingSignal[]): void {
  const heard = useRef(new Set<string>());
  useEffect(() => {
    const fresh = incoming.filter((line) => !heard.current.has(line.callId));
    for (const line of fresh) heard.current.add(line.callId);
    if (fresh.length > 0)
      (incoming.some((line) => line.alarm)
        ? alarmCallSignal
        : brigadeCallSignal)();
    else if (incoming.length === 0) stopCallSignal();
  }, [incoming]);
  useEffect(
    () => () => {
      stopCallSignal();
      // StrictMode повторно запускает эффекты после cleanup: оборванный звук нужен снова.
      heard.current.clear();
    },
    [],
  );
}
