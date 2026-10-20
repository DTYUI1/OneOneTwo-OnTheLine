import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../shared/api";
import type { components } from "../api-client/schema";
import kit from "../teacher/console/Console.module.css";

export function DeletedDrafts() {
  const queries = useQueryClient();
  const drafts = useQuery({
    queryKey: ["deleted-drafts"],
    queryFn: async () => {
      const { data, error } = await api.GET("/admin/drafts");
      if (!data)
        throw new Error(
          error?.message ?? "Не удалось загрузить удалённые черновики.",
        );
      return data;
    },
  });
  const restore = useMutation({
    mutationFn: async (item: components["schemas"]["DraftItem"]) => {
      const { error, response } = await api.POST(
        item.kind === "session"
          ? "/sessions/{id}/restore"
          : "/scenarios/{id}/restore",
        {
          params: {
            path: { id: item.id },
            header: { "X-CSRF-Token": csrfToken() },
          },
        },
      );
      if (!response.ok)
        throw new Error(error?.message ?? "Не удалось восстановить черновик.");
    },
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ["deleted-drafts"] });
    },
  });
  return (
    <section className={kit.panel}>
      <h3 className={kit.panelTitle}>Удалённые черновики</h3>
      <p className={kit.hint}>
        Данные сохранены. Восстановление не возобновляет генерацию и отменённые
        задания.
      </p>
      {drafts.isPending && <p>Загружаем…</p>}
      {drafts.error && <p role="alert">{drafts.error.message}</p>}
      {restore.error && <p role="alert">{restore.error.message}</p>}
      {drafts.data?.length === 0 && <p>Удалённых черновиков нет.</p>}
      {drafts.data && drafts.data.length > 0 && (
        <table className={kit.table}>
          <thead>
            <tr>
              <th>Тип</th>
              <th>Название</th>
              <th>Удалён</th>
              <th>Действие</th>
            </tr>
          </thead>
          <tbody>
            {drafts.data.map((item) => (
              <tr key={`${item.kind}:${item.id}`}>
                <td>{item.kind === "session" ? "Занятие" : "Сценарий"}</td>
                <td>{item.title}</td>
                <td>{new Date(item.deleted_at).toLocaleString("ru-RU")}</td>
                <td>
                  <button
                    type="button"
                    className={kit.plain}
                    disabled={restore.isPending}
                    onClick={() => restore.mutate(item)}
                  >
                    Восстановить
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
