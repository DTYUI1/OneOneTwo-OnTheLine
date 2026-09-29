// Все обучаемые закончили — кабинет предлагает завершить занятие и, если
// преподаватель не ответил за FINISH_PROMPT_S секунд, завершает его сам.
// Окно живёт на уровне кабинета, а не вкладки занятия: преподаватель может
// в это время смотреть каталог или отчёт другого занятия.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import type { components } from "../../api-client/schema";
import { api, csrfToken } from "../../shared/api";
import { useSession } from "../../shared/session";
import { Dialog } from "../../arm/Dialog";
import { everyoneDone, FINISH_PROMPT_S } from "./lessonClock";
import styles from "./FinishPrompt.module.css";

type Session = components["schemas"]["Session"];

const keepKey = (id: string) => `teacher:keep-running:${id}`;

/** «Не завершать» переживает перезагрузку: иначе окно вернулось бы и закрыло занятие само. */
function isKept(id: string): boolean {
  try {
    return sessionStorage.getItem(keepKey(id)) === "1";
  } catch {
    return false;
  }
}

function keep(id: string) {
  try {
    sessionStorage.setItem(keepKey(id), "1");
  } catch {
    // Без хранилища выбор действует до перезагрузки страницы.
  }
}

export function FinishPrompt({ sessions }: { sessions: readonly Session[] }) {
  const { realtime } = useSession();
  const queries = useQueryClient();
  const running = sessions.filter((session) => session.status === "running");
  const lifecycles = useQueries({
    queries: running.map((session) => ({
      // Ключ и форма ответа — как у доски: один запрос на двоих.
      queryKey: ["lifecycle", session.id],
      queryFn: async () => {
        const { data } = await api.GET("/sessions/{id}/lifecycle", {
          params: { path: { id: session.id } },
        });
        return data ?? null;
      },
    })),
  });
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());

  useEffect(
    () =>
      realtime.subscribe((event) => {
        // Остаток назначений меняется только когда карточка закрылась или
        // прервалась. Прочие правки карточки снимок занятия не трогают, а
        // lifecycle берёт блокировку занятия — лишний раз его не запрашиваем.
        if (
          event.type === "card.updated" &&
          (event.payload.closed_at !== null ||
            event.payload.interrupted_at !== null)
        )
          void queries.invalidateQueries({
            queryKey: ["lifecycle", event.payload.session_id],
          });
        if (event.type === "snapshot")
          void queries.invalidateQueries({ queryKey: ["lifecycle"] });
      }),
    [realtime, queries],
  );

  const due = running.find((session, index) => {
    const lifecycle = lifecycles[index]?.data;
    return (
      lifecycle &&
      everyoneDone(lifecycle) &&
      !kept.has(session.id) &&
      !isKept(session.id)
    );
  });
  if (!due) return null;
  return (
    <FinishDialog
      key={due.id}
      session={due}
      onKeep={() => {
        keep(due.id);
        setKept((current) => new Set(current).add(due.id));
      }}
    />
  );
}

function FinishDialog({
  session,
  onKeep,
}: {
  session: Session;
  onKeep: () => void;
}) {
  const queries = useQueryClient();
  const [deadline] = useState(() => Date.now() + FINISH_PROMPT_S * 1000);
  const [left, setLeft] = useState(FINISH_PROMPT_S);
  // Один request_id на окно: повтор и вторая вкладка кабинета получат тот же
  // итог finish, а не 409 «завершить можно только идущее».
  const [requestId] = useState(() => crypto.randomUUID());
  const fired = useRef(false);

  const finish = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/sessions/{id}/finish", {
        params: {
          path: { id: session.id },
          header: { "X-CSRF-Token": csrfToken() },
        },
        body: { contract_version: 2, request_id: requestId },
      });
      if (!data) throw new Error(error?.message ?? "Занятие не завершено.");
      return data;
    },
    onSuccess: async () => {
      for (const key of ["sessions", "session", "lifecycle", "report"])
        await queries.invalidateQueries({ queryKey: [key] });
    },
  });
  const mutate = finish.mutate;

  useEffect(() => {
    const tick = setInterval(() => {
      const rest = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setLeft(rest);
      if (rest === 0 && !fired.current) {
        fired.current = true;
        mutate();
      }
    }, 250);
    return () => clearInterval(tick);
  }, [deadline, mutate]);

  const waiting = !finish.isError;
  return (
    <div className={styles.backdrop}>
      <Dialog
        label="Завершение занятия"
        className={styles.dialog}
        onClose={() => {
          if (!finish.isPending) onKeep();
        }}
      >
        <h2>Все обучаемые завершили задания</h2>
        <p>
          Занятие «{session.title}»: карточки закрыты, новых заданий не будет.
        </p>
        {waiting ? (
          <p className={styles.countdown} role="status">
            {finish.isPending
              ? "Завершаем занятие…"
              : `Занятие завершится автоматически через ${left} с.`}
          </p>
        ) : (
          <p role="alert" className={styles.error}>
            {finish.error.message} Завершите занятие кнопкой «Завершить».
          </p>
        )}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.finish}
            disabled={finish.isPending}
            onClick={() => {
              fired.current = true;
              mutate();
            }}
          >
            Завершить сейчас
          </button>
          <button
            type="button"
            className={styles.keep}
            disabled={finish.isPending}
            onClick={onKeep}
          >
            Не завершать
          </button>
        </div>
      </Dialog>
    </div>
  );
}
