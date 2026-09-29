import { useState, type FormEvent, type KeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { loginDestination } from "./loginDestination";
import { forgetWelcome } from "./welcome";
import entry from "./LoginPage.module.css";

export function LoginPage() {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const watchCaps = (event: KeyboardEvent) =>
    setCapsLock(event.getModifierState("CapsLock"));
  const navigate = useNavigate();
  const location = useLocation();
  const queries = useQueryClient();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const result = await api.POST("/auth/login", {
        body: { login, password },
      });
      if (!result.data) {
        setError(result.error?.message ?? "Не удалось войти.");
        return;
      }
      queries.clear();
      queries.setQueryData(["me"], result.data);
      if (result.data.role === "trainee") forgetWelcome(result.data.id);
      navigate(loginDestination(result.data.role, location.state?.returnTo), {
        replace: true,
      });
    } catch {
      setError("Сервер недоступен. Повторите попытку.");
    } finally {
      setPending(false);
    }
  }
  return (
    // Раскладка — экран входа Системы 112 (arm_dds/01), общая с выбором обучения.
    <main className={entry.welcome}>
      <form
        className={`${entry.panel} ${entry.form}`}
        onSubmit={(event) => void submit(event)}
      >
        <h1>
          <span className={entry.mark}>112</span>
          <span className={entry.caption}>
            Вход в систему
            {/* Экран входа копирует Систему 112 — подпись говорит, что это тренажёр
                (просьба капитана 29.09). */}
            <span className={entry.trainer}>
              Учебный тренажёр оператора 112 и диспетчера служб
            </span>
          </span>
        </h1>
        <label className={entry.field}>
          Логин
          <input
            autoComplete="username"
            required
            value={login}
            onChange={(e) => setLogin(e.target.value)}
          />
        </label>
        <label className={entry.field}>
          Пароль
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={watchCaps}
            onKeyUp={watchCaps}
            onBlur={() => setCapsLock(false)}
            aria-describedby={capsLock ? "caps-lock" : undefined}
          />
        </label>
        {capsLock && (
          <p id="caps-lock" role="status">
            Включён ввод заглавных букв. Проверьте пароль.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <button className={entry.choice} disabled={pending}>
          {pending ? "Вход…" : "Войти"}
        </button>
      </form>
    </main>
  );
}
