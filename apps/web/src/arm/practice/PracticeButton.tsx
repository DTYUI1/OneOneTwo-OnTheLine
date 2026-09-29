// «Тренировка»: обучающее упражнение, которое ученик запускает сам, без преподавателя,
// сколько угодно раз. Сервер закрывает прежнюю тренировку и выдаёт новую карточку —
// кнопка дожидается её и открывает сама: время реакции идёт с момента запуска.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../../shared/api";
import { ConfirmDialog } from "../ConfirmDialog";
import { pickPracticeCard, practiceRunning } from "./practiceModel";
import styles from "../ArmPage.module.css";

// Сколько ждать карточку, прежде чем отправить обучаемого в список.
const WAIT_MS = 30_000;

export function PracticeButton({
  label = "Тренировка",
  step,
  className = styles.resultsButton,
  onStarted,
}: {
  /** Подпись кнопки: в разборе тренировочной карточки — «Пройти тренировку ещё раз». */
  label?: string;
  /** Ступень обучения (evalcore/progress.py); без неё — обучающее упражнение. */
  step?: number;
  /** Класс кнопки: в «Моём пути» выделена только текущая ступень. */
  className?: string;
  /** Карточка тренировки открыта: окно, из которого запускали, можно закрыть. */
  onStarted?: () => void;
} = {}) {
  const queries = useQueryClient();
  const navigate = useNavigate();
  const started = useRef(onStarted);
  started.current = onStarted;
  const [busy, setBusy] = useState(false);
  // Идёт другая тренировка: сначала спрашиваем окном, прервать ли её карточку.
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  // Сессия, чью карточку ждём; null — не ждём.
  const [waiting, setWaiting] = useState<string | null>(null);
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const { data } = await api.GET("/sessions");
      return data ?? [];
    },
  });
  // Тот же ключ и запрос, что у реестра АРМ; пока ждём карточку — опрашиваем чаще.
  const cards = useQuery({
    queryKey: ["cards"],
    queryFn: async () => {
      const { data, error } = await api.GET("/cards");
      if (!data) throw new Error(error?.message ?? "Нет связи с сервером.");
      return data;
    },
    refetchInterval: waiting ? 1000 : false,
  });
  const practiceIds = new Set(
    (sessions.data ?? [])
      .filter((item) => item.kind === "practice")
      .map((item) => item.id),
  );
  const running = practiceRunning(cards.data ?? [], practiceIds);
  const arrivedId = waiting
    ? pickPracticeCard(cards.data ?? [], waiting)?.id
    : undefined;

  useEffect(() => {
    if (!arrivedId) return;
    setWaiting(null);
    setNote("");
    navigate(`/arm/cards/${encodeURIComponent(arrivedId)}`);
    started.current?.();
  }, [arrivedId, navigate]);

  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => {
      setWaiting(null);
      setNote(
        "Карточка тренировки ещё не пришла. Откройте её из списка происшествий, как только она появится.",
      );
    }, WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  async function start() {
    setAsking(false);
    setBusy(true);
    setNote("");
    try {
      const { data, error } = await api.POST("/practice", {
        params: {
          header: { "X-CSRF-Token": csrfToken() },
          ...(step ? { query: { step } } : {}),
        },
      });
      if (!data) {
        setNote(error?.message ?? "Тренировку запустить не удалось.");
        return;
      }
      queries.setQueryData(["session", data.id], data);
      void queries.invalidateQueries({ queryKey: ["sessions"] });
      void queries.invalidateQueries({ queryKey: ["progress"] });
      void queries.invalidateQueries({ queryKey: ["cards"] });
      setWaiting(data.id);
      setNote(
        "Тренировка запущена: карточка откроется сама — время реакции уже идёт (норма 30 секунд).",
      );
    } catch {
      setNote("Нет связи с сервером. Повторите попытку.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={className}
        // Пока не известно, идёт ли тренировка, запуск мог бы молча прервать карточку.
        disabled={
          busy || waiting !== null || !sessions.isSuccess || !cards.isSuccess
        }
        onClick={() => (running ? setAsking(true) : void start())}
        title="Обучающее упражнение: полный путь карточки с подсказками"
      >
        {label}
      </button>
      {asking && (
        <ConfirmDialog
          title="Начать тренировку заново?"
          confirmLabel="Начать заново"
          onConfirm={start}
          onCancel={() => setAsking(false)}
        >
          Текущая тренировочная карточка будет прервана.
        </ConfirmDialog>
      )}
      {note && (
        <p role="status" className={styles.practiceNote}>
          {note}
        </p>
      )}
    </>
  );
}
