// Удержание линий в окне телефона (TC-02, вкладки 17.10): машина `hold.ts` с часами и
// сервером. Часы идут, только пока есть линия на удержании или вкладка «не дождался»; сервер
// закрыл звонок сам (занятие завершено) — удерживать нечего. Эффекты (отбой, снятие)
// исполняет ArmPage. Линии на удержании помнятся в sessionStorage вкладки браузера: после
// обновления страницы их можно снять. Сервер ограничивает срок по call_hold/call_resume,
// даже если вкладка закрыта; локальный таймер — отображение и резервный отбой через outbox.
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "../../shared/session";
import {
  initialHold,
  reduceHold,
  type HeldLine,
  type HoldEffect,
  type HoldEvent,
  type HoldState,
} from "./hold";
import { brigadeWho } from "./lines";
import { cancelLine } from "../pickup";

/** Линия из хранилища; прежний формат (одна линия бригады) — тоже. */
function heldLine(value: unknown): HeldLine | null {
  if (!value || typeof value !== "object") return null;
  const line = value as Partial<HeldLine>;
  if (
    typeof line.callId !== "string" ||
    typeof line.cardId !== "string" ||
    typeof line.phoneExt !== "string" ||
    typeof line.heldAt !== "number"
  )
    return null;
  return {
    ...(line as HeldLine),
    kind: line.kind ?? "brigade",
    who: line.who ?? brigadeWho(line.phoneExt),
    cardNumber: line.cardNumber ?? "",
  };
}

function restore(key: string): HoldState {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    const held = (Array.isArray(stored) ? stored : [stored])
      .map(heldLine)
      .filter((line): line is HeldLine => line !== null);
    return held.length ? { held, dropped: [] } : initialHold;
  } catch {
    return initialHold;
  }
}

function remember(key: string, state: HoldState): void {
  try {
    if (state.held.length)
      sessionStorage.setItem(key, JSON.stringify(state.held));
    else sessionStorage.removeItem(key);
  } catch {
    // Хранилище запрещено — удержание живёт до обновления страницы.
  }
}

export function useHold(onEffect: (effect: HoldEffect) => void): {
  readonly state: HoldState;
  readonly dispatch: (event: HoldEvent) => void;
  readonly acceptResume: (callId: string, start: () => boolean) => boolean;
} {
  const { realtime, user } = useSession();
  const key = `dds-hold:${user.id}`;
  const [state, setState] = useState<HoldState>(() => restore(key));
  const stateRef = useRef(state);
  const mounted = useRef(true);
  const effectRef = useRef(onEffect);
  effectRef.current = onEffect;
  const dispatch = useCallback(
    (event: HoldEvent) => {
      if (event.type === "ended") cancelLine(event.callId);
      const next = reduceHold(stateRef.current, event);
      if (next.state !== stateRef.current) {
        if (next.state.held !== stateRef.current.held)
          remember(key, next.state);
        stateRef.current = next.state;
        setState(next.state);
      }
      for (const effect of next.effects) effectRef.current(effect);
    },
    [key],
  );
  const ticking = state.held.length > 0 || state.dropped.length > 0;
  const acceptResume = useCallback(
    (callId: string, start: () => boolean) => {
      if (!mounted.current) return false;
      dispatch({ type: "tick", at: Date.now() });
      if (!stateRef.current.held.some((line) => line.callId === callId))
        return false;
      if (!start()) return false;
      dispatch({ type: "resumed", callId });
      return true;
    },
    [dispatch],
  );
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(
      () => dispatch({ type: "tick", at: Date.now() }),
      1000,
    );
    return () => clearInterval(timer);
  }, [ticking, dispatch]);
  useEffect(
    () =>
      realtime.subscribe((event) => {
        if (event.type === "call.state" && event.payload.state === "ended")
          dispatch({ type: "ended", callId: event.payload.id });
      }),
    [realtime, dispatch],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return { state, dispatch, acceptResume };
}
