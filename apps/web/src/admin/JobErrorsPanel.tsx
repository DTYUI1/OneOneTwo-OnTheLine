import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "../api-client/schema";
import { api, csrfToken } from "../shared/api";
import kit from "../teacher/console/Console.module.css";

type JobError = components["schemas"]["JobErrorView"];
type Filter = "all" | "unread" | "read";
const PAGE = 20;
const KIND: Record<string, string> = {
  generate: "Генерация сценариев",
  evaluate: "Оценка карточки",
  insights: "Подготовка рекомендаций",
  transcribe: "Распознавание речи",
  tts: "Создание озвучки",
};

export function JobErrorsPanel() {
  const queries = useQueryClient();
  const [state, setState] = useState<Filter>("all");
  const [offset, setOffset] = useState(0);
  const errors = useQuery({
    queryKey: ["admin-job-errors", state, offset],
    queryFn: async () => {
      const { data, error } = await api.GET("/admin/job-errors", {
        params: { query: { state, offset, limit: PAGE } },
      });
      if (!data)
        throw new Error(
          error?.message ?? "Не удалось загрузить ошибки очереди.",
        );
      return data;
    },
    refetchInterval: 15_000,
  });
  const read = useMutation({
    mutationFn: async (item: JobError) => {
      const { data, error } = await api.POST("/admin/job-errors/{id}/read", {
        params: {
          path: { id: item.id },
          header: { "X-CSRF-Token": csrfToken() },
        },
        body: { version: item.version },
      });
      if (!data)
        throw new Error(
          error?.message ?? "Не удалось сохранить отметку. Повторите попытку.",
        );
      return data;
    },
    onSuccess: () => setOffset(0),
    onSettled: async () => {
      await Promise.all([
        queries.invalidateQueries({ queryKey: ["admin-job-errors"] }),
        queries.invalidateQueries({ queryKey: ["admin-status"] }),
      ]);
    },
  });
  const pagination = errors.data && (
    <div className={kit.actions}>
      <button
        type="button"
        className={kit.plain}
        disabled={offset === 0 || errors.isFetching}
        onClick={() => setOffset(Math.max(0, offset - PAGE))}
      >
        Предыдущая страница
      </button>
      <span>
        Всего: {errors.data.total} · Страница {Math.floor(offset / PAGE) + 1}
      </span>
      <button
        type="button"
        className={kit.plain}
        disabled={offset + PAGE >= errors.data.total || errors.isFetching}
        onClick={() => setOffset(offset + PAGE)}
      >
        Следующая страница
      </button>
    </div>
  );
  return (
    <div className={kit.tabBody}>
      <p className={kit.hint}>
        Здесь задания, завершившиеся ошибкой. «Отметить прочитанным» убирает
        сообщение из предупреждений для всех администраторов, но не исправляет и
        не перезапускает задание. Прочитанные записи остаются в списке. Новый
        сбой после повторной попытки снова потребует внимания.
      </p>
      <div className={kit.actions}>
        <label className={kit.field}>
          Показать ошибки
          <select
            value={state}
            onChange={(event) => {
              setState(event.target.value as Filter);
              setOffset(0);
            }}
          >
            <option value="all">Все</option>
            <option value="unread">Непрочитанные</option>
            <option value="read">Прочитанные</option>
          </select>
        </label>
        <button
          type="button"
          className={kit.plain}
          disabled={errors.isFetching}
          onClick={() => void errors.refetch()}
        >
          Обновить
        </button>
        {errors.data && <span>Непрочитанных: {errors.data.unread}</span>}
      </div>
      {pagination}
      {errors.isPending && <p role="status">Загружаем ошибки очереди…</p>}
      {errors.isError && <p role="alert">{errors.error.message}</p>}
      {read.isError && <p role="alert">{read.error.message}</p>}
      {errors.data?.items.length === 0 && (
        <p>Ошибок по выбранному фильтру нет.</p>
      )}
      {errors.data?.items.map((item) => (
        <article key={item.id} className={kit.panel}>
          <h3 className={kit.panelTitle}>
            {KIND[item.kind] ?? "Фоновое задание"}
          </h3>
          <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {item.message}
          </p>
          <p className={kit.hint}>
            {item.read_at
              ? `Прочитано ${new Date(item.read_at).toLocaleString("ru-RU")}`
              : "Не прочитано"}
          </p>
          <details>
            <summary>Подробности задания</summary>
            <p>Номер: {item.id}</p>
            <p>Попыток: {item.attempts}</p>
            <p>
              Время в очереди:{" "}
              {new Date(item.last_attempt_at).toLocaleString("ru-RU")}
            </p>
            <p className={kit.hint}>
              Техническая отметка очереди; точное время сбоя отдельно не
              сохранялось.
            </p>
          </details>
          {!item.read_at && (
            <div className={kit.actions}>
              <button
                type="button"
                className={kit.plain}
                disabled={read.isPending}
                onClick={() => read.mutate(item)}
              >
                {read.isPending && read.variables.id === item.id
                  ? "Сохраняем…"
                  : "Отметить прочитанным"}
              </button>
            </div>
          )}
        </article>
      ))}
      {pagination}
    </div>
  );
}
