import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../shared/api";
import { useSession } from "../shared/session";
import { referenceKey } from "./referenceModel";

export function useReferenceMaterials() {
  return useQuery({
    queryKey: referenceKey,
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/materials/by-session", {
        signal,
      });
      if (!data)
        throw new Error(
          error?.message ?? "Не удалось загрузить справку. Попробуйте ещё раз.",
        );
      return data;
    },
  });
}

/** На переподключении snapshot перечитывает и пропущенные назначения. */
export function useReferenceUpdates() {
  const { realtime } = useSession();
  const queries = useQueryClient();
  useEffect(
    () =>
      realtime.subscribe((event) => {
        if (
          [
            "session.materials_changed",
            "session.started",
            "session.finished",
            "snapshot",
          ].includes(event.type)
        ) {
          void queries.invalidateQueries({ queryKey: referenceKey });
        }
      }),
    [realtime, queries],
  );
}
