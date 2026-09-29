// Выбор обучаемого в «Новом занятии»: поле с подсказками вместо длинного списка.
// Учёток могут быть сотни, и идут они не по порядку (удалённые, заблокированные):
// преподаватель набирает часть ФИО или логина, браузер подсказывает совпадения.
import { useEffect, useState } from "react";
import type { User } from "../../shared/api";
import { traineeLabel, traineeByText } from "./traineeModel";

export function TraineeInput({
  value,
  trainees,
  listId,
  onChange,
}: {
  value: string;
  trainees: readonly User[];
  /** Общий datalist формы: в нём только ещё не выбранные обучаемые. */
  listId: string;
  onChange: (userId: string) => void;
}) {
  const chosen = trainees.find((user) => user.id === value);
  const [text, setText] = useState(chosen ? traineeLabel(chosen) : "");
  // Выбор мог прийти снаружи (рекомендация из отчёта) — показываем его.
  useEffect(() => {
    if (chosen) setText(traineeLabel(chosen));
  }, [chosen]);
  return (
    <input
      list={listId}
      value={text}
      placeholder="Введите ФИО или логин обучаемого"
      aria-label="Обучаемый"
      aria-invalid={text.trim() !== "" && !chosen}
      onChange={(event) => {
        setText(event.target.value);
        onChange(traineeByText(trainees, event.target.value)?.id ?? "");
      }}
    />
  );
}
