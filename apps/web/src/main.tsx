import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Shell } from "./shared/Shell";
import { LoginPage } from "./shared/LoginPage";
import { ArmPage } from "./arm/ArmPage";
import { TeacherPage } from "./teacher/TeacherPage";
import { AdminPage } from "./admin/AdminPage";
import { bindRoomEscape } from "./shared/roomBridge";
import "./shared/tokens.css";

// Модуль «Оператор 112» — отдельный фрагмент сборки: в нём копия классификатора.
const OperatorPage = React.lazy(() =>
  import("./operator/OperatorPage").then((module) => ({
    default: module.OperatorPage,
  })),
);

const queries = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
// Внутри комнаты intro/ Esc вне справок и карточек возвращает в комнату.
bindRoomEscape();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queries}>
      <BrowserRouter basename="/app">
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<Shell roles={["trainee"]} />}>
            <Route path="/arm/*" element={<ArmPage />} />
            {/* «Мои результаты» — один экран: разбор в АРМ. Старый адрес из
                закладок и ссылок ведёт туда же. */}
            <Route
              path="/results"
              element={<Navigate to="/arm/results" replace />}
            />
          </Route>
          <Route element={<Shell roles={["teacher"]} />}>
            <Route path="/teacher" element={<TeacherPage />} />
          </Route>
          <Route element={<Shell roles={["admin"]} />}>
            <Route path="/admin" element={<AdminPage />} />
          </Route>
          <Route element={<Shell roles={["trainee", "teacher", "admin"]} />}>
            <Route
              path="/operator/*"
              element={
                <React.Suspense fallback={<p>Загрузка…</p>}>
                  <OperatorPage />
                </React.Suspense>
              }
            />
          </Route>
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
