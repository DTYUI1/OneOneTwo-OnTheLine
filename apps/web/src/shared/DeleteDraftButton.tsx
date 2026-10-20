import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "./api";
import kit from "../teacher/console/Console.module.css";
import styles from "../teacher/console/AIResourceDialog.module.css";

export function DeleteDraftButton({
  id,
  kind,
  onDeleted,
}: {
  id: string;
  kind: "session" | "scenario";
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={kit.plain} onClick={() => setOpen(true)}>
        Удалить
      </button>
      {open && (
        <Confirm
          id={id}
          kind={kind}
          onClose={() => setOpen(false)}
          onDeleted={onDeleted}
        />
      )}
    </>
  );
}

function Confirm({
  id,
  kind,
  onClose,
  onDeleted,
}: {
  id: string;
  kind: "session" | "scenario";
  onClose: () => void;
  onDeleted: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const queries = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  const remove = async () => {
    setPending(true);
    setError("");
    try {
      const { error, response } = await api.DELETE(
        kind === "session" ? "/sessions/{id}" : "/scenarios/{id}",
        {
          params: { path: { id }, header: { "X-CSRF-Token": csrfToken() } },
        },
      );
      if (!response.ok)
        throw new Error(error?.message ?? "Не удалось удалить черновик.");
      await Promise.all(
        ["sessions", "scenarios", "packs"].map((key) =>
          queries.invalidateQueries({ queryKey: [key] }),
        ),
      );
      onDeleted();
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось удалить черновик.",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-label="Удалить черновик"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
    >
      <h2>Удалить черновик?</h2>
      <p>Черновик будет удалён из списка. Восстановить может администратор.</p>
      {error && <p role="alert">{error}</p>}
      <div className={styles.actions}>
        <button
          type="button"
          className={kit.plain}
          disabled={pending}
          onClick={onClose}
        >
          Отмена
        </button>
        <button
          type="button"
          className={kit.primary}
          disabled={pending}
          onClick={() => void remove()}
        >
          {pending ? "Удаляем…" : "Удалить"}
        </button>
      </div>
    </dialog>
  );
}
