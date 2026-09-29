// Состояние системы (C-07) — GET /admin/status; общий запрос для раздела и полосы
// предупреждений, опрос раз в 15 с.
import { useQuery } from "@tanstack/react-query";
import { api } from "../shared/api";

export function useSystemStatus() {
  return useQuery({
    queryKey: ["admin-status"],
    queryFn: async () => {
      const { data, error } = await api.GET("/admin/status");
      if (!data) throw new Error(error?.message ?? "Сервер не ответил.");
      return data;
    },
    refetchInterval: 15_000,
  });
}
