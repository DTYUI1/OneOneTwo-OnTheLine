import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useFeatures } from "./features";

/** Адреса модуля «Оператор 112» открываются, только пока администратор его включил. */
export function OperatorGate({ children }: { children: ReactNode }) {
  const features = useFeatures();
  if (features.isPending) return <p>Загрузка…</p>;
  if (features.data?.operator_module !== true)
    return <Navigate to="/login" replace />;
  return <>{children}</>;
}
