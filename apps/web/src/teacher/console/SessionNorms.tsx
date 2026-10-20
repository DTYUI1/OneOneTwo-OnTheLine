import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../../shared/api";
import { HandlingNormativeField } from "../../shared/HandlingNormativeField";
import {
  formatHandlingNormative,
  HANDLING_NORMATIVE_HINT,
} from "../../shared/handlingNormative";
import type { Session } from "./model";
import styles from "./Console.module.css";

export function SessionNorms({ session }: { session: Session }) {
  const queries = useQueryClient();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const save = useMutation({
    mutationKey: ["session-norms", session.id],
    mutationFn: async (seconds: number) => {
      const { data, error } = await api.PATCH("/sessions/{id}/norms", {
        params: {
          path: { id: session.id },
          header: { "X-CSRF-Token": csrfToken() },
        },
        body: { handling_normative_s: seconds },
      });
      if (!data) throw new Error(error?.message ?? "Норматив не сохранён.");
      return data;
    },
    onSuccess: async (value) => {
      queries.setQueryData(["session", session.id], value);
      setNotice("Сохранено");
      setError("");
      await queries.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const seconds = session.settings_snapshot.handling_normative_s;
  if (session.status !== "draft")
    return (
      <div>
        <p>Отработка карточки: {formatHandlingNormative(seconds)}</p>
        <p className={styles.hint}>{HANDLING_NORMATIVE_HINT}</p>
      </div>
    );

  return (
    <div>
      <HandlingNormativeField
        key={session.id}
        value={seconds}
        disabled={save.isPending}
        onChange={() => {
          setNotice("");
          setError("");
        }}
        onCommit={(value) => {
          if (value !== seconds) save.mutate(value);
        }}
      />
      {save.isPending && <p role="status">Сохраняем…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
