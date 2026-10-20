import { useState } from "react";
import { createPortal } from "react-dom";
import { api, type User } from "./api";
import { Dialog } from "../arm/Dialog";
import dialog from "../arm/ConfirmDialog.module.css";
import styles from "./LogoutButton.module.css";

export function LogoutButton({
  role,
  onLogout,
}: {
  role: User["role"];
  onLogout: () => Promise<boolean>;
}) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancel = () => {
    if (!busy) {
      setStep(0);
      setError("");
    }
  };
  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (step === 1 && role !== "admin") {
        // Читаем перед выходом: занятие могло начаться после открытия окна.
        const { data } = await api.GET("/sessions");
        if (!data)
          throw new Error(
            "Не удалось проверить, идёт ли занятие. Повторите попытку.",
          );
        if (
          data.some(
            (session) =>
              session.status === "running" && session.kind !== "practice",
          )
        ) {
          setStep(2);
          return;
        }
      }
      if (await onLogout()) setStep(0);
      else setError("Не удалось выйти. Повторите попытку.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Нет связи с сервером. Повторите попытку.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError("");
          setStep(1);
        }}
      >
        Выйти
      </button>
      {step !== 0 &&
        createPortal(
          <div className={`${dialog.backdrop} ${styles.overlay}`}>
            <Dialog
              label="Выход из системы"
              className={dialog.dialog}
              onClose={cancel}
            >
              <h2>Выход из системы</h2>
              <p>
                {step === 1
                  ? "Вы точно хотите выйти?"
                  : "У вас идёт занятие. Вы действительно хотите выйти?"}
              </p>
              {error && <p role="alert">{error}</p>}
              <div className={`${dialog.actions} ${styles.actions}`}>
                <button
                  type="button"
                  className={dialog.plain}
                  disabled={busy}
                  onClick={cancel}
                >
                  Остаться
                </button>
                <button
                  type="button"
                  className={dialog.primary}
                  disabled={busy}
                  onClick={() => void confirm()}
                >
                  {busy
                    ? "Подождите…"
                    : step === 1
                      ? "Да, выйти"
                      : "Всё равно выйти"}
                </button>
              </div>
            </Dialog>
          </div>,
          document.body,
        )}
    </>
  );
}
