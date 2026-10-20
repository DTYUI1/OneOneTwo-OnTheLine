// Модуль «Оператор 112» включает администратор (созвон 16.10, contracts/operator/module-switch.md):
// настройку хранит сервер, веб читает её через GET /api/features. По умолчанию модуль выключен,
// пока ответа нет или сервер недоступен — тоже.
import { useQuery } from "@tanstack/react-query";

export async function fetchFeatures(): Promise<{ operator_module: boolean }> {
  const response = await fetch("/api/features");
  if (!response.ok) throw new Error("Настройки модулей недоступны.");
  const body: unknown = await response.json();
  return { operator_module: isOperatorModuleEnabled(body) };
}

export function isOperatorModuleEnabled(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { operator_module?: unknown }).operator_module === true
  );
}

export function useFeatures() {
  return useQuery({
    queryKey: ["features"],
    queryFn: fetchFeatures,
    retry: false,
  });
}

/** Включён ли модуль «Оператор 112»; пока настройка не прочитана — нет. */
export function useOperatorModule(): boolean {
  return useFeatures().data?.operator_module === true;
}
