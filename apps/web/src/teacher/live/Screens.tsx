// Экраны учеников на live-доске (HQ-017, решение Dani 18.10): «Смотреть экран» на плитке
// места → ученик соглашается → в плитке живая картинка 5 кадров/с, щелчок — крупно.
// Видео без звука, до 10 экранов сразу. Протокол — contracts/ws-events.md.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../../shared/api";
import { useSession } from "../../shared/session";
import { ScreenViewer } from "../../shared/ws/screen";
import type { components } from "../../api-client/schema";
import styles from "./LiveBoard.module.css";

type ScreenShare = components["schemas"]["ScreenShare"];

/** Столько плиток с экраном держит сервер одновременно (MAX_SHARES_PER_SESSION). */
export const MAX_SCREENS = 10;

export interface ScreensView {
  readonly shares: ReadonlyMap<string, ScreenShare["state"]>;
  readonly frames: ReadonlyMap<string, string>;
  readonly failure: string;
  readonly full: boolean;
  request(userId: string): Promise<void>;
  stop(userId: string): Promise<void>;
}

export function useScreens(sessionId: string, running: boolean): ScreensView {
  const { realtime } = useSession();
  const queries = useQueryClient();
  const key = ["session-screens", sessionId];
  const list = useQuery({
    queryKey: key,
    enabled: running && Boolean(sessionId),
    queryFn: async (): Promise<ScreenShare[]> => {
      const { data, error } = await api.GET("/sessions/{id}/screens", {
        params: { path: { id: sessionId } },
      });
      if (!data) throw new Error(error?.message ?? "Нет связи с сервером.");
      return data;
    },
  });
  const [failure, setFailure] = useState("");
  const [frames, setFrames] = useState<ReadonlyMap<string, string>>(new Map());
  const urls = useRef(new Map<string, string>());

  // screen.state приходит и при согласии ученика, и при его «Остановить показ».
  useEffect(
    () =>
      realtime.subscribe((event) => {
        if (event.type === "snapshot")
          void queries.invalidateQueries({ queryKey: key });
        if (event.type !== "screen.state") return;
        if (event.payload.session_id !== sessionId) return;
        queries.setQueryData<ScreenShare[]>(key, (old = []) => {
          const rest = old.filter((s) => s.user_id !== event.payload.user_id);
          return event.payload.state === "stopped"
            ? rest
            : [...rest, event.payload];
        });
      }),
    [realtime, queries, sessionId],
  );

  const shares = new Map(
    (running ? (list.data ?? []) : []).map((s) => [s.user_id, s.state]),
  );
  const watching = shares.size > 0;

  // Канал кадров открыт, только пока кто-то показывает или ждёт согласия.
  useEffect(() => {
    if (!watching) return;
    const viewer = new ScreenViewer(sessionId, (userId, jpeg) => {
      const url = URL.createObjectURL(jpeg);
      const previous = urls.current.get(userId);
      urls.current.set(userId, url);
      setFrames(new Map(urls.current));
      // Прежний кадр отпускаем после замены: в памяти только последний.
      if (previous) URL.revokeObjectURL(previous);
    });
    viewer.start();
    return () => viewer.stop();
  }, [sessionId, watching]);

  // Остановленный показ — картинку убираем сразу, а не держим последний кадр.
  const active = [...shares.keys()].join(",");
  useEffect(() => {
    let changed = false;
    for (const [userId, url] of urls.current) {
      if (shares.get(userId) === "sharing") continue;
      URL.revokeObjectURL(url);
      urls.current.delete(userId);
      changed = true;
    }
    if (changed) setFrames(new Map(urls.current));
  }, [active, list.data]);

  useEffect(
    () => () => {
      for (const url of urls.current.values()) URL.revokeObjectURL(url);
      urls.current.clear();
    },
    [],
  );

  async function call(userId: string, action: "request" | "stop") {
    setFailure("");
    const params = {
      path: { id: sessionId, user_id: userId },
      header: { "X-CSRF-Token": csrfToken() },
    };
    const { data, error } =
      action === "request"
        ? await api.POST("/sessions/{id}/screens/{user_id}/request", { params })
        : await api.POST("/sessions/{id}/screens/{user_id}/stop", { params });
    if (!data) {
      setFailure(error?.message ?? "Нет связи с сервером.");
      return;
    }
    queries.setQueryData<ScreenShare[]>(key, (old = []) => {
      const rest = old.filter((s) => s.user_id !== userId);
      return data.state === "stopped" ? rest : [...rest, data];
    });
  }

  return {
    shares,
    frames,
    failure,
    full: shares.size >= MAX_SCREENS,
    request: (userId) => call(userId, "request"),
    stop: (userId) => call(userId, "stop"),
  };
}

/** Экран места в плитке: кнопка, ожидание согласия или живая картинка. */
export function ScreenSlot({
  screens,
  userId,
  label,
  onZoom,
}: {
  screens: ScreensView;
  userId: string;
  label: string;
  onZoom: (userId: string) => void;
}) {
  const state = screens.shares.get(userId);
  const frame = screens.frames.get(userId);
  if (!state)
    return (
      <button
        type="button"
        className={styles.injectButton}
        disabled={screens.full}
        title={
          screens.full
            ? `Одновременно — не больше ${MAX_SCREENS} экранов`
            : undefined
        }
        onClick={() => void screens.request(userId)}
      >
        Смотреть экран
      </button>
    );
  return (
    <div className={styles.screen}>
      {state === "requested" ? (
        <div className={styles.screenWait}>Ждём согласия ученика…</div>
      ) : frame ? (
        <button
          type="button"
          className={styles.screenImage}
          aria-label={`Экран ${label} крупно`}
          onClick={() => onZoom(userId)}
        >
          <img src={frame} alt={`Экран ${label}`} />
        </button>
      ) : (
        <div className={styles.screenWait}>Экран подключается…</div>
      )}
      <button
        type="button"
        className={styles.injectButton}
        onClick={() => void screens.stop(userId)}
      >
        Перестать
      </button>
    </div>
  );
}

/** Крупный вид одного экрана поверх доски; Esc или щелчок — закрыть. */
export function ScreenZoom({
  screens,
  userId,
  label,
  onClose,
}: {
  screens: ScreensView;
  userId: string;
  label: string;
  onClose: () => void;
}) {
  const frame = screens.frames.get(userId);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  return (
    <div
      className={styles.zoom}
      role="dialog"
      aria-label={`Экран ${label}`}
      onClick={onClose}
    >
      <div className={styles.zoomHead}>
        Экран {label} · 5 кадров/с, без звука
        <button type="button" onClick={onClose}>
          Закрыть
        </button>
      </div>
      {frame ? (
        <img src={frame} alt={`Экран ${label}`} />
      ) : (
        <p>Показ остановлен.</p>
      )}
    </div>
  );
}
