// Модули системы. Сейчас один: «Оператор 112» — обучение приёму вызова. По умолчанию выключен;
// настройку хранит сервер (contracts/operator/module-switch.md).
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { csrfToken } from "../shared/api";
import { useFeatures } from "../shared/features";
import kit from "../teacher/console/Console.module.css";

export function ModulesPanel() {
  const queries = useQueryClient();
  const features = useFeatures();
  const [error, setError] = useState("");
  const save = useMutation({
    mutationFn: async (enabled: boolean) => {
      const response = await fetch("/api/admin/features", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken(),
        },
        body: JSON.stringify({ operator_module: enabled }),
      });
      if (!response.ok) throw new Error("Настройка не сохранена.");
    },
    onSuccess: async () => {
      setError("");
      await queries.invalidateQueries({ queryKey: ["features"] });
    },
    onError: (cause: Error) => setError(cause.message),
  });

  if (features.isError)
    return (
      <p role="alert" className={kit.placeholder}>
        Настройка недоступна: {features.error.message}
      </p>
    );
  if (features.isPending)
    return <p className={kit.placeholder}>Загружаем настройку…</p>;
  const enabled = features.data.operator_module;

  return (
    <div className={kit.tabBody}>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          disabled={save.isPending}
          onChange={(event) => save.mutate(event.target.checked)}
        />{" "}
        Оператор 112
      </label>
      <p>
        {enabled
          ? "Модуль включён: обучаемые видят выбор обучения, а преподаватели — попытки операторов."
          : "Модуль выключен: обучение оператора 112 скрыто, обращения к нему отклоняются. Данные сохранены."}
      </p>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
