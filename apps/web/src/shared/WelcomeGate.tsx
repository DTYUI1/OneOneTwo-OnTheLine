import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { api, csrfToken, type User } from "./api";
import { acknowledgeWelcome, hasSeenWelcome } from "./welcome";
import { welcomeContent } from "./welcomeContent";
import styles from "./WelcomeGate.module.css";

// Экран после входа — по наброску пользователя (28.09): «Выберите обучение»
// и две плитки, красная «112» (оператор) и синяя «Диспетчер служб» (ДДС).

/**
 * Состояние перехода, которое снова открывает выбор обучения: крестик экрана результатов
 * «Оператор 112» (просьба капитана 29.09). Пример: navigate("/arm", { state: CHOOSE_TRAINING }).
 */
export const CHOOSE_TRAINING = { chooseTraining: true } as const;

export function WelcomeGate({
  user,
  children,
}: {
  user: User;
  children: ReactNode;
}) {
  const [seen, setSeen] = useState(() => hasSeenWelcome(user.id));
  const navigate = useNavigate();
  const location = useLocation();
  const queries = useQueryClient();
  const [exitError, setExitError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const trainee = user.role === "trainee";
  const again =
    trainee &&
    (location.state as { chooseTraining?: unknown } | null)?.chooseTraining ===
      true;
  const open = !seen || again;
  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open]);

  if (!open) return children;

  function begin() {
    acknowledgeWelcome(user.id);
    setSeen(true);
    // Выбор заново: «Диспетчер служб» ведёт в АРМ, отметка перехода снимается.
    if (again) navigate("/arm", { replace: true, state: null });
  }

  // Крестик (просьба капитана 29.09): назад к экрану входа — с выходом из учётной записи,
  // иначе сессия осталась бы открытой, а экран входа её не проверяет.
  async function backToLogin() {
    setExitError("");
    try {
      const { error } = await api.POST("/auth/logout", {
        params: { header: { "X-CSRF-Token": csrfToken() } },
      });
      if (error) {
        setExitError(error.message);
        return;
      }
      queries.clear();
      navigate("/login", { replace: true });
    } catch {
      setExitError("Не удалось выйти: сервер недоступен.");
    }
  }

  function beginOperator() {
    acknowledgeWelcome(user.id);
    setSeen(true);
    navigate("/operator", { replace: again });
  }

  return (
    <main className={styles.welcome}>
      <h1 ref={heading} tabIndex={-1}>
        {trainee ? "Выберите обучение" : "Добро пожаловать"}
      </h1>
      <div className={styles.tiles}>
        {trainee ? (
          <>
            <button
              className={styles.operator}
              aria-label="Оператор 112"
              onClick={beginOperator}
            >
              112
            </button>
            <button className={styles.dispatcher} onClick={begin}>
              Диспетчер служб
            </button>
          </>
        ) : (
          <button className={styles.dispatcher} onClick={begin}>
            {welcomeContent(user.role).begin}
          </button>
        )}
      </div>
      {/* После плиток: Tab ведёт с заголовка сразу на «112», крестик — последним. */}
      <button
        type="button"
        className={styles.close}
        aria-label="Вернуться ко входу"
        title="Выйти из учётной записи — к экрану входа"
        onClick={() => void backToLogin()}
      >
        ×
      </button>
      {exitError && <p role="alert">{exitError}</p>}
    </main>
  );
}
