// Показ экрана преподавателю (HQ-017): ученик всегда знает, что его экран видят.
// Запрос преподавателя → плашка «Показать экран / Отказаться»; согласие — кнопка и окно
// браузера (getDisplayMedia), без них ничего не уходит. Пока идёт показ — плашка
// «Преподаватель смотрит ваш экран» и «Остановить показ»; преподаватель закрыл плитки
// (screen.state paused) — кадры не идут, плашка «Показ включён, преподаватель сейчас не
// смотрит». Протокол — contracts/ws-events.md.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../shared/api";
import { useSession } from "../shared/session";
import {
  canvasGrabber,
  captureScreen,
  ownShareState,
  SCREEN_CLOSE_FINAL,
  ScreenPublisher,
  screenSocketUrl,
} from "../shared/ws/screen";
import styles from "./ScreenShareBar.module.css";

type Phase = "idle" | "requested" | "starting" | "sharing";

/** Идущее учебное занятие, в составе которого обучаемый (личная тренировка — без показа). */
function useRunningLesson(): string | null {
  const { user } = useSession();
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const { data } = await api.GET("/sessions");
      return data ?? [];
    },
  });
  const lesson = (sessions.data ?? []).find(
    (session) =>
      session.status === "running" &&
      session.kind === "lesson" &&
      session.participants.some((item) => item.user_id === user.id),
  );
  return lesson?.id ?? null;
}

export function ScreenShareBar() {
  const { user, realtime } = useSession();
  const queries = useQueryClient();
  const sessionId = useRunningLesson();
  const [requested, setRequested] = useState(false);
  const [phase, setPhase] = useState<Exclude<Phase, "idle" | "requested">>();
  const [failure, setFailure] = useState("");
  // Смотрит ли преподаватель сейчас: сервер шлёт sharing / paused (HQ-017).
  const [watched, setWatched] = useState(false);
  const watchedRef = useRef(false);
  const live = useRef<{ publisher: ScreenPublisher; dispose: () => void }>();

  const own = useQuery({
    queryKey: ["own-screen", sessionId],
    enabled: Boolean(sessionId),
    queryFn: async () => {
      const { data } = await api.GET("/sessions/{id}/screens", {
        params: { path: { id: sessionId! } },
      });
      return data ?? [];
    },
  });
  // После переподключения /ws пропущенные screen.state восстанавливаются из GET.
  useEffect(() => {
    const status = ownShareState(own.data, user.id);
    setRequested(status.requested);
    if (status.watched !== undefined) applyWatched(status.watched);
  }, [own.data, user.id]);

  function applyWatched(now: boolean) {
    watchedRef.current = now;
    setWatched(now);
    if (live.current) live.current.publisher.paused = !now;
  }

  function halt() {
    live.current?.publisher.stop();
    live.current?.dispose();
    live.current = undefined;
    setPhase(undefined);
    watchedRef.current = false;
    setWatched(false);
  }

  useEffect(
    () =>
      realtime.subscribe((event) => {
        if (event.type === "snapshot")
          void queries.invalidateQueries({ queryKey: ["own-screen"] });
        if (event.type !== "screen.state" || event.payload.user_id !== user.id)
          return;
        setRequested(event.payload.state !== "stopped");
        if (event.payload.state === "stopped") halt();
        applyWatched(event.payload.state === "sharing");
      }),
    [realtime, queries, user.id],
  );

  // Занятие закончилось или ученик ушёл со страницы — захват гасим.
  useEffect(() => {
    if (!sessionId) {
      setRequested(false);
      halt();
    }
  }, [sessionId]);
  useEffect(() => () => halt(), []);

  async function stopShare() {
    halt();
    setRequested(false);
    if (!sessionId) return;
    await api.POST("/sessions/{id}/screens/{user_id}/stop", {
      params: {
        path: { id: sessionId, user_id: user.id },
        header: { "X-CSRF-Token": csrfToken() },
      },
    });
  }

  async function startShare() {
    if (!sessionId) return;
    setFailure("");
    setPhase("starting");
    let stream: MediaStream;
    try {
      stream = await captureScreen();
    } catch {
      setPhase(undefined);
      setFailure(
        "Показ не начат: браузер не дал доступ к экрану. Можно попробовать ещё раз.",
      );
      return;
    }
    const grabber = canvasGrabber(stream);
    const socket = new WebSocket(screenSocketUrl(sessionId));
    const publisher = new ScreenPublisher(grabber.grab, socket);
    live.current = { publisher, dispose: grabber.dispose };
    socket.onopen = () => {
      setPhase("sharing");
      // screen.state мог прийти по /ws раньше onopen — берём последнее известное.
      publisher.paused = !watchedRef.current;
      publisher.start();
    };
    socket.onclose = (closed) => {
      if (live.current?.publisher !== publisher) return;
      halt();
      if (!SCREEN_CLOSE_FINAL.has(closed.code))
        setFailure("Показ прервался: нет связи с сервером.");
    };
    // «Прекратить показ» на панели браузера — то же, что наша кнопка.
    for (const track of stream.getVideoTracks())
      track.addEventListener("ended", () => void stopShare());
  }

  if (!sessionId || (!requested && !phase)) return null;
  if (phase === "sharing")
    return (
      <div
        className={`${styles.bar} ${watched ? styles.live : ""}`}
        role="status"
        aria-label="Идёт показ экрана"
      >
        {watched && <span className={styles.dot} aria-hidden="true" />}
        {watched
          ? "Преподаватель смотрит ваш экран"
          : "Показ включён, преподаватель сейчас не смотрит"}
        <button type="button" onClick={() => void stopShare()}>
          Остановить показ
        </button>
      </div>
    );
  return (
    <div className={styles.bar} role="alertdialog" aria-label="Показ экрана">
      Преподаватель просит показать ваш экран (без звука).
      <button
        type="button"
        disabled={phase === "starting"}
        onClick={() => void startShare()}
      >
        Показать экран
      </button>
      <button type="button" onClick={() => void stopShare()}>
        Отказаться
      </button>
      {failure && <span className={styles.failure}>{failure}</span>}
    </div>
  );
}
