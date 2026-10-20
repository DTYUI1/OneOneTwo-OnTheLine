import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "./api";
import kit from "../teacher/console/Console.module.css";

export function StopGenerationButton({
  jobId,
  stopping = false,
}: {
  jobId: string;
  stopping?: boolean;
}) {
  const queries = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const stop = async () => {
    setPending(true);
    setError("");
    try {
      const { error, response } = await api.POST("/jobs/{id}/stop", {
        params: {
          path: { id: jobId },
          header: { "X-CSRF-Token": csrfToken() },
        },
      });
      if (!response.ok)
        throw new Error(error?.message ?? "Не удалось остановить генерацию.");
      await queries.invalidateQueries();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось остановить генерацию.",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <div className={kit.actions}>
      <button
        type="button"
        className={kit.plain}
        disabled={pending || stopping}
        onClick={() => void stop()}
      >
        {pending || stopping ? "Останавливаем…" : "Остановить"}
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
