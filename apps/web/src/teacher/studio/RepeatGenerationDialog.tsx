import { AIResourceDialog } from "../console/AIResourceDialog";

export function repeatMessage(left: number, count: number): string {
  if (count <= left) return "";
  return left === 0
    ? "Все варианты карточек для этой службы и уровня уже сгенерированы. Следующая карточка повторит существующую (другие фразы и заявитель). Сгенерировать?"
    : `Новых вариантов осталось ${left}. Следующие ${count - left} карточек повторят уже сгенерированные (другие фразы и заявитель). Сгенерировать?`;
}

export function RepeatGenerationDialog({
  left,
  count,
  onChoose,
}: {
  left: number;
  count: number;
  onChoose: (confirmed: boolean) => void;
}) {
  const message = repeatMessage(left, count);
  if (!message) return null;
  return (
    <AIResourceDialog
      action="generate"
      repeatMessage={message}
      onChoose={(choice) => onChoose(choice !== "cancel")}
    />
  );
}
