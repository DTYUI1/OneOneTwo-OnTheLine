// Запуск тренировки (29.09): POST /practice, ожидание карточки и переход к ней. Общий
// для кнопки «Тренировка» и этапов обучения (DT-18): этап — режим занятия
// тренировки, его запоминаем по id занятия до прихода карточки.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../../shared/api";
import {
  pickPracticeCard,
  practiceQuery,
  practiceRunning,
} from "./practiceModel";
import {
  setExpertSource,
  setSessionMode,
  setSessionStage,
  STAGES,
  type CardMode,
  type Stage,
} from "../trainer/stages";

// Сколько ждать карточку, прежде чем отправить обучаемого в список.
const WAIT_MS = 30_000;

export interface PracticeStart {
  /** Ступень (evalcore/progress.py); без неё — обучающее упражнение. */
  readonly step?: number;
  /** Сценарий из каталога; со ступенью — повтор сценария из «Моего пути». */
  readonly scenario?: string;
  /** Карточка из разбора: тот же сценарий ещё раз (со ступенью — на ней). */
  readonly again?: string;
  /** Этап обучения; без него — обычная тренировка («Сам»). */
  readonly mode?: CardMode;
  /** Показ опытного: карточка обучаемого, с которой его сравнить. */
  readonly expertFor?: string;
}

export function usePracticeStart(onStarted?: () => void) {
  const queries = useQueryClient();
  const navigate = useNavigate();
  const started = useRef(onStarted);
  started.current = onStarted;
  // Один запуск для кнопки, этапов и каталога; сообщения тоже общие.
  const launch = useQuery({
    queryKey: ["practice-launch"],
    queryFn: () => ({ busy: false, note: "" }),
    initialData: { busy: false, note: "" },
    enabled: false,
  });
  const { busy, note } = launch.data;
  const setBusy = useCallback(
    (busy: boolean) => {
      queries.setQueryData(
        ["practice-launch"],
        (old: { busy: boolean; note: string }) => ({ ...old, busy }),
      );
    },
    [queries],
  );
  const setNote = useCallback(
    (note: string) => {
      queries.setQueryData(
        ["practice-launch"],
        (old: { busy: boolean; note: string }) => ({ ...old, note }),
      );
    },
    [queries],
  );
  // Сессия, чью карточку ждём; null — не ждём.
  const [waiting, setWaiting] = useState<string | null>(null);
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const { data } = await api.GET("/sessions");
      return data ?? [];
    },
  });
  const blockedReason = sessions.data?.some(
    (session) => session.kind === "lesson" && session.status === "running",
  )
    ? "Идёт занятие преподавателя. Тренировка доступна после его завершения."
    : "";
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
  const disabled =
    busy ||
    waiting !== null ||
    !sessions.isSuccess ||
    !cards.isSuccess ||
    Boolean(blockedReason);
  useEffect(() => {
    if (blockedReason) setNote("");
  }, [blockedReason, setNote]);
  const running = practiceRunning(cards.data ?? [], practiceIds);
  const arrivedId = waiting
    ? pickPracticeCard(cards.data ?? [], waiting)?.id
    : undefined;

  useEffect(() => {
    if (!arrivedId) return;
    setWaiting(null);
    setBusy(false);
    setNote("");
    navigate(`/arm/cards/${encodeURIComponent(arrivedId)}`);
    started.current?.();
  }, [arrivedId, navigate, setBusy, setNote]);

  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => {
      setWaiting(null);
      setBusy(false);
      setNote(
        "Карточка тренировки ещё не пришла. Откройте её из списка происшествий, как только она появится.",
      );
    }, WAIT_MS);
    return () => {
      window.clearTimeout(timer);
      setBusy(false);
    };
  }, [waiting, setBusy, setNote]);

  async function start({
    step,
    scenario,
    again,
    mode,
    expertFor,
  }: PracticeStart = {}) {
    if (
      disabled ||
      queries.getQueryData<{ busy: boolean }>(["practice-launch"])?.busy
    )
      return;
    setBusy(true);
    setNote("");
    let awaitingCard = false;
    try {
      const query = practiceQuery({ step, scenario, again, mode });
      const { data, error } = await api.POST("/practice", {
        signal: AbortSignal.timeout(30_000),
        params: {
          header: { "X-CSRF-Token": csrfToken() },
          ...(Object.keys(query).length > 0 ? { query } : {}),
        },
      });
      if (!data) {
        void queries.invalidateQueries({ queryKey: ["sessions"] });
        setNote(error?.message ?? "Тренировку запустить не удалось.");
        return;
      }
      setSessionMode(data.id, mode ?? "solo");
      // Запуск этапом обучения: его «Сам» — этап, ✓ ставит закрытая карточка.
      if (mode && mode in STAGES) setSessionStage(data.id, mode as Stage);
      if (expertFor) setExpertSource(data.id, expertFor);
      queries.setQueryData(["session", data.id], data);
      void queries.invalidateQueries({ queryKey: ["sessions"] });
      void queries.invalidateQueries({ queryKey: ["progress"] });
      void queries.invalidateQueries({ queryKey: ["cards"] });
      awaitingCard = true;
      setWaiting(data.id);
      setNote(
        "Тренировка запущена: карточка откроется сама — время реакции уже идёт (норма 30 секунд).",
      );
    } catch {
      setNote("Нет связи с сервером. Повторите попытку.");
    } finally {
      if (!awaitingCard) setBusy(false);
    }
  }

  return {
    start,
    note,
    running,
    // Пока не известно, идёт ли тренировка, запуск мог бы молча прервать карточку.
    disabled,
    blockedReason,
  };
}
