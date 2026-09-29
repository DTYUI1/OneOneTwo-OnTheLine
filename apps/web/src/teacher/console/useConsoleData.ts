// Общие запросы пульта. Ключи совпадают во всех вкладках — TanStack Query
// делит один ответ между компонентами и не дёргает сервер повторно.
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api";

export function useSessions() {
  return useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const { data, error } = await api.GET("/sessions");
      if (!data) throw new Error(error?.message ?? "Занятия недоступны.");
      return data;
    },
  });
}

export function useSession(sessionId: string) {
  return useQuery({
    queryKey: ["session", sessionId],
    queryFn: async () => {
      const { data, error } = await api.GET("/sessions/{id}", {
        params: { path: { id: sessionId } },
      });
      if (!data) throw new Error(error?.message ?? "Занятие недоступно.");
      return data;
    },
  });
}

export function useAssignments(sessionId: string) {
  return useQuery({
    queryKey: ["assignments", sessionId],
    queryFn: async () => {
      const { data, error } = await api.GET("/sessions/{id}/assignments", {
        params: { path: { id: sessionId } },
      });
      if (!data) throw new Error(error?.message ?? "Задания недоступны.");
      return data;
    },
  });
}

export function useUsers() {
  return useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const { data, error } = await api.GET("/users");
      if (!data)
        throw new Error(
          error?.message ?? "Не удалось загрузить пользователей.",
        );
      return data;
    },
  });
}

export function useServices() {
  const services = useQuery({
    queryKey: ["services"],
    queryFn: async () => {
      const { data } = await api.GET("/services");
      return data ?? [];
    },
  });
  // Подпись службы вместо кода: «Служба 102», «Мосгаз», а не «104».
  const serviceName = (id: string) =>
    (services.data ?? []).find((service) => service.id === id)?.name ?? id;
  return { services, serviceName };
}

export function useScenarios() {
  return useQuery({
    queryKey: ["scenarios"],
    queryFn: async () => {
      const { data, error } = await api.GET("/scenarios");
      if (!data) throw new Error(error?.message ?? "Сценарии недоступны.");
      return data;
    },
  });
}

export function useCards() {
  return useQuery({
    queryKey: ["cards"],
    queryFn: async () => {
      const { data, error } = await api.GET("/cards");
      if (!data) throw new Error(error?.message ?? "Карточки недоступны.");
      return data;
    },
    // Карточки закрываются по ходу занятия — вердикты к ним подтягиваем сами.
    refetchInterval: 15_000,
  });
}

export function useEvaluations() {
  return useQuery({
    queryKey: ["evaluations"],
    queryFn: async () => {
      const { data, error } = await api.GET("/evaluations");
      if (!data) throw new Error(error?.message ?? "Вердикты недоступны.");
      return data;
    },
    refetchInterval: 15_000,
  });
}

/**
 * Принимает ли сервер адресную выдачу пачкой (C-03), и что уже выдано пачками.
 * Узнаём чтением списка пачек: 501 — ещё не включена, тогда работает прежняя
 * раздача по службам.
 */
export function useBatchAvailability(sessionId: string) {
  const batches = useQuery({
    queryKey: ["assignment-batches", sessionId],
    queryFn: async () => {
      const { data, response } = await api.GET(
        "/sessions/{id}/assignment-batches",
        {
          params: { path: { id: sessionId } },
        },
      );
      return { status: response.status, batches: data ?? [] };
    },
    retry: false,
  });
  return {
    pending: batches.isPending,
    available: batches.data?.status === 200,
    batches: batches.data?.batches ?? [],
  };
}

export type DeliveryMode = "profile" | "intentional_mismatch";

/** Выданное задание — одиночным назначением или в пачке. */
export interface IssuedAssignment {
  id: string;
  participant_id: string;
  scenario_id: string;
  order: number;
  source: "single" | "batch";
  status: string;
  planned_at?: string;
  delay_from_start_s?: number;
  due_at?: string | null;
  delivery_mode?: DeliveryMode;
}

/**
 * Всё выданное занятию. C-03 отдаёт задания пачек только в списке пачек, а в
 * GET /assignments их нет — без объединения пульт считал бы места пустыми и
 * не дал бы начать занятие.
 */
export function useIssuedAssignments(sessionId: string) {
  const single = useAssignments(sessionId);
  const batch = useBatchAvailability(sessionId);
  const data: IssuedAssignment[] = [
    ...(single.data ?? []).map((item) => ({
      id: item.id,
      participant_id: item.participant_id,
      scenario_id: item.scenario_id,
      order: item.order,
      source: "single" as const,
      status: item.status,
      planned_at: item.planned_at,
    })),
    ...batch.batches.flatMap((receipt) =>
      receipt.assignments.map((item) => ({
        id: item.id,
        participant_id: item.participant_id,
        scenario_id: item.scenario_id,
        order: item.order,
        source: "batch" as const,
        status: item.status,
        delay_from_start_s: item.delay_from_start_s,
        due_at: item.due_at,
        delivery_mode: item.delivery_mode,
      })),
    ),
  ];
  return { data, isPending: single.isPending || batch.pending };
}
