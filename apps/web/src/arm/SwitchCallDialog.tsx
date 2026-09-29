// Переход к другому происшествию посреди разговора: звонок оборвётся — спрашиваем.
// Реальный диспетчер тоже сначала заканчивает разговор, а уже потом берёт новое.
import { ConfirmDialog } from "./ConfirmDialog";

export function SwitchCallDialog({
  label,
  onConfirm,
  onCancel,
}: {
  label: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      title="Идёт разговор"
      confirmLabel="Завершить разговор и перейти"
      cancelLabel="Остаться"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      Разговор ({label}) будет завершён. Перейти к другому происшествию?
    </ConfirmDialog>
  );
}
